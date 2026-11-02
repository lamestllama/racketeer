#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require (only-in ffi/unsafe/global get-place-table)
         compiler/cm
         compiler/cm-accomplice
         file/convertible
         file/sha1
         racket/file
         racket/path
         racket/port
         racket/runtime-path
         syntax/modcode
         "../test-discovery.rkt"
         "../wxme-source.rkt"
         "../instrumentation/instrument.rkt"
         "debug-cache.rkt")
(provide run-module make-debug-loader make-debug-exception-handler)

;; Used both while loading a program and during later console interactions.
(define (make-debug-exception-handler on-exception on-pause)
  (lambda (value)
    (when (and on-pause (exn:break? value)
               (not (exn:break:hang-up? value)) (not (exn:break:terminate? value))
               (on-pause value))
      ((exn:break-continuation value)))
    (call-with-exception-stop value on-exception)))

(define-namespace-anchor anchor)
(define-runtime-path instrumentation-path "../instrumentation/instrument.rkt")
(define-runtime-path expander-path "expand.rkt")
(define-runtime-path instrumentation-runtime-path "../instrumentation/runtime.rkt")
(define-runtime-path debugger-root "..")
(define-runtime-path testing-path "testing.rkt")
(define-logger debug-cache)

;; The worker loads this module before starting debuggee threads. Its first
;; instantiation establishes one parameter per place; later loader copies in
;; other registries or phases reuse it. A parameter carries dynamic ownership
;; through forwarding handlers, continuation prompts, and inherited threads.
(define current-compilation-policy-owner
  (hash-ref! (get-place-table) 'racketeer/worker/load:compilation-policy-owner
             (lambda () (make-parameter #f))))

;; Build load handlers for one namespace. The entry controls belong to the
;; same instrumentation state as those handlers; loading alone starts no run.
;; Returns the compiled/source load handlers, an entry selector and an entry
;; completion procedure, in that order. The source path is already canonical.
(define (make-debug-loader namespace source
                           #:instrument? [instrument? #t]
                           #:coverage? [coverage? #f]
                           #:language [language #f]
                           #:on-sites [on-sites void]
                           #:on-event [on-event #f]
                           #:on-entry [on-entry #f]
                           #:on-source [on-source void]
                           #:on-source-snapshot [on-source-snapshot void]
                           #:exclude [excluded? (lambda (_path) #f)]
                           #:fresh-id [supplied-fresh-id #f]
                           #:source-selected? [source-selected? (lambda (_path) #f)]
                           #:sources [additional-sources '()]
                           #:source-roots [source-roots '()]
                           #:test? [test? #f]
                           #:test-selection [test-selection #f]
                           #:cache-directory [cache-directory #f])
  (define selected-sources
    (cons source (map (lambda (path) (simplify-path (path->complete-path path)))
                      additional-sources)))
  (define roots (map (lambda (p) (explode-path (simplify-path (path->complete-path p)))) source-roots))
  (define (under-root? path)
    (define parts (explode-path path))
    (for/or ([root (in-list roots)])
      (and (<= (length root) (length parts))
           (for/and ([a (in-list root)] [b (in-list parts)]) (equal? a b)))))
  (define (debugger-source? path)
    (define root (explode-path (simplify-path debugger-root)))
    (define parts (explode-path path))
    (and (<= (length root) (length parts))
         (for/and ([a (in-list root)] [b (in-list parts)]) (equal? a b))))
  (define (selected-source? resolved)
    (and (not (equal? (path-get-extension resolved) #".zo"))
         (not (debugger-source? resolved))
         (not (excluded? resolved))
         (or (member resolved selected-sources) (under-root? resolved)
             (source-selected? resolved))))
  (when instrument?
    (namespace-attach-module (namespace-anchor->namespace anchor)
                             instrumentation-path namespace)
    (namespace-attach-module (namespace-anchor->namespace anchor)
                             instrumentation-runtime-path namespace))
  (define ordinary-load (current-load/use-compiled))
  (define ordinary-source-load (current-load))
  (define ordinary-eval (current-eval))
  (define compiled-paths (use-compiled-file-paths))
  (define compiled-roots (current-compiled-file-roots))
  (define compiled-check (use-compiled-file-check))
  (define ordinary-compile (current-compile))
  (define enforce-module-constants? (compile-enforce-module-constants))
  (define selected-load-request (make-parameter #f))
  (define policy-owner (gensym 'compilation-policy))
  (define registry (namespace-module-registry namespace))
  (define (target-registry?)
    (eq? registry (namespace-module-registry (current-namespace))))
  (define next-id 0)
  (define discovered-tests '())
  ;; Record module ownership during expansion. Source paths alone cannot
  ;; distinguish main from its parent or sibling submodules in the same file.
  (define module-paths (make-hasheq))
  (define entry-submodule #f)
  (define entry-announced? #f)
  (define (fresh-id)
    (if supplied-fresh-id (supplied-fresh-id)
        (begin0 next-id (set! next-id (add1 next-id)))))
  (define next-unit 0)
  ;; The runtime's table holds a unit's forms only as long as its symbol lives,
  ;; which code read lazily from a file does not ensure until it runs.
  (define live-units '())
  (define (hold-unit! unit) (set! live-units (cons unit live-units)) unit)
  ;; The callback a form's sites deliver to. It decides the automatic entry stop
  ;; from the form's module, so it is made for one file and module path.
  (define (form-callback selected-source module-path)
    (and on-event
         (if on-entry
             (lambda (stop)
               (cond
                 [(and (not entry-announced?)
                       (eq? (stop-kind stop) 'before)
                       (equal? selected-source source)
                       (equal? module-path entry-submodule))
                  (set! entry-announced? #t)
                  (on-entry stop)]
                 [else (on-event stop)]))
             on-event)))
  ;; Forms compiled for the cache keep what they tell the session in a record, and
  ;; deliver it as they expand only when the session is loading them right now.
  (struct recording (unit source-hash live? [events #:mutable]))
  (define current-recording (make-parameter #f))
  (define (record! rec event)
    (when rec (set-recording-events! rec (cons event (recording-events rec)))))
  (define (instrument-eval selected-source
                           #:top-level? [top-level? language]
                           #:recording [rec #f]
                           #:finish [finish ordinary-eval])
    ;; A unit names this load's forms in the runtime's table.
    (define unit
      (hold-unit!
       (if rec
           (recording-unit rec)
           (begin0 (string->symbol (format "~a#~a" selected-source next-unit))
             (set! next-unit (add1 next-unit))))))
    (define live? (or (not rec) (recording-live? rec)))
    (define next-form 0)
    (lambda (form)
      (parameterize ([current-eval ordinary-eval])
        (define wrapper-name (gensym 'racketdap-form))
        ;; This module's scope must not reach the program's module: compiled code
        ;; would keep it, and with it this module's imports, which the program's
        ;; namespace does not have.
        (define (in-context-of form stx) (datum->syntax form (syntax-e stx) stx stx))
        (define (language-wrapper language context bindings)
          (define name
            (if rec
                (string->symbol (format "racketdap-language:~a" (module-binding-context-key bindings)))
                (gensym 'racketdap-language)))
          (define module-path (syntax->datum language))
          (declare-language-wrapper name module-path (make-transform bindings))
          (when rec
            (record-language-dependency! module-path)
            (record! rec (list 'language name module-path)))
          (datum->syntax context `(quote ,name)))
        (define (annotate expanded [bindings #f] #:expression-boundary? [expression-boundary? #f])
          (define index (begin0 next-form (set! next-form (add1 next-form))))
          (define-values (annotated sites table)
            (instrument-module expanded selected-source fresh-id
                               #:form (cons unit index) #:module-context bindings
                               #:coverage? coverage?
                               #:expression-boundary? expression-boundary?))
          (define module-path (hash-ref module-paths bindings '()))
          (when live?
            (register-form-sites! unit index (form-callback selected-source module-path) (map car table))
            (on-sites sites))
          (when rec
            (record! rec (list 'form module-path index
                               (for/list ([entry (in-list table)])
                                 (define s (car entry))
                                 (vector (site-line s) (site-column s) (site-position s) (site-span s)
                                         (site-tail? s) (cdr entry))))))
          annotated)
        (define (make-transform bindings)
          (lambda (kind stx)
            (case kind
              [(declaration) (record-module-bindings! bindings stx selected-source)]
              [(expression) (annotate stx bindings)]
              [(module-expression) (annotate stx bindings #:expression-boundary? #t)]
              [(module) (rewrite-submodule stx bindings)])))
        (define (wrap-body body context bindings)
          (define transform (make-transform bindings))
          (define wrapper (datum->syntax context wrapper-name))
          (cons
           (datum->syntax context
                          `(require (only-in (file ,(path->string instrumentation-runtime-path)))
                                    (rename-in (file ,(path->string expander-path))
                                               [instrument-form ,wrapper-name])))
           (for/list ([item (in-list body)])
             ;; Racket's module-begin must see an explicit runtime configuration
             ;; before expansion, or it inserts a second submodule of that name.
             (syntax-case item ()
               [(head name language form ...)
                (and (memq (syntax-e #'head) '(module module*))
                     (eq? (syntax-e #'name) 'configure-runtime))
                (let ([child (module-binding-context-child! bindings 'configure-runtime
                                                           (not (syntax-e #'language)))])
                  (hash-set! module-paths child
                             (append (hash-ref module-paths bindings '()) '(configure-runtime)))
                  (in-context-of
                   item
                   (if (syntax-e #'language)
                       #`(head name #,(language-wrapper #'language item child) form ...)
                       #`(head name language #,@(wrap-body (syntax->list #'(form ...)) item child)))))]
               [_ (in-context-of item #`(#,wrapper #,transform #,item))]))))
        (define (rewrite-submodule form [parent-bindings #f])
          (define (context-for name inherit?)
            (define context
              (if parent-bindings
                  (module-binding-context-child! parent-bindings (syntax-e name) inherit?)
                  (make-module-binding-context
                   #f (string->symbol (format "~a:~a" unit (syntax-e name))))))
            (hash-set! module-paths context
                       (if parent-bindings
                           (append (hash-ref module-paths parent-bindings) (list (syntax-e name)))
                           '()))
            context)
          ;; Keep declaration bindings when a module is loaded during expansion.
          (define rewritten
            (syntax-case form (module module* module+ begin)
            [(module . _) (not (equal? (syntax-source form) selected-source)) form]
            [(module* . _) (not (equal? (syntax-source form) selected-source)) form]
            [(module name language (mb body ...))
             (and (memq (syntax-e #'language) '(racket/base racket))
                  (eq? (syntax-e #'mb) '#%module-begin))
             #`(#,(car (syntax-e form)) name language
                 #,(in-context-of form #`(mb #,@(wrap-body (syntax->list #'(body ...)) #'mb (context-for #'name #f)))))]
            [(module name language body ...)
             (memq (syntax-e #'language) '(racket/base racket))
             #`(#,(car (syntax-e form)) name language #,@(wrap-body (syntax->list #'(body ...)) form (context-for #'name #f)))]
            [(module* name language body ...)
             (or (not (syntax-e #'language))
                 (memq (syntax-e #'language) '(racket/base racket)))
             #`(#,(car (syntax-e form)) name language
                 #,@(wrap-body (syntax->list #'(body ...)) form
                               (context-for #'name (not (syntax-e #'language)))))]
            [(module name language . _)
             (syntax-case form ()
               [(_ name language body ...)
                #`(#,(car (syntax-e form)) name #,(language-wrapper #'language form (context-for #'name #f)) body ...)])]
            [(module* name language . _)
             (syntax-case form ()
               [(_ name language body ...)
                #`(#,(car (syntax-e form)) name #,(language-wrapper #'language form (context-for #'name #f)) body ...)])]
            [(module+ name body ...)
             #`(#,(car (syntax-e form)) name #,@(wrap-body (syntax->list #'(body ...)) form (context-for #'name #t)))]
            [(begin body ...)
             #`(#,(car (syntax-e form)) #,@(map (lambda (item) (rewrite-submodule item parent-bindings))
                              (syntax->list #'(body ...))))]
            [_ form]))
          (if (syntax? rewritten)
              (datum->syntax form (syntax-e rewritten) form form)
              rewritten))
        (define (eval-top form)
          (define partial (expand-syntax-to-top-form form))
          (syntax-case partial (begin define-values define-syntaxes begin-for-syntax #%require module)
            [(begin item ...)
             (let loop ([items (syntax->list #'(item ...))])
               (cond [(null? items) (void)]
                     [(null? (cdr items)) (eval-top (car items))]
                     [else (call-with-values (lambda () (eval-top (car items))) (lambda _ (void)))
                           (loop (cdr items))]))]
            [(define-values ids rhs)
             ;; Plain-file evaluation has no transformer-time syntax-local-name
             ;; to carry this binding through the procedure-registration call.
             (let* ([expanded-rhs (expand-syntax #'rhs)]
                    [identifiers (syntax->list #'ids)]
                    [named-rhs
                     (if (and (= (length identifiers) 1)
                              (not (syntax-property expanded-rhs 'inferred-name)))
                         (syntax-property expanded-rhs 'inferred-name (syntax-e (car identifiers)))
                         expanded-rhs)])
               (ordinary-eval #`(define-values ids #,(annotate named-rhs))))]
            [(define-syntaxes . _) (ordinary-eval partial)]
            [(begin-for-syntax . _) (ordinary-eval partial)]
            [(#%require . _) (ordinary-eval partial)]
            [(module . _) (ordinary-eval (rewrite-submodule partial))]
            [_ (ordinary-eval (annotate (expand-syntax partial) #:expression-boundary? #t))]))
        (if (and top-level? (not (compiled-expression? form)))
            (eval-top form)
            (finish (rewrite-submodule form))))))
  ;; A language other than racket/base or racket gets a wrapper module that
  ;; instruments its module body. A cached module imports it by name, so its
  ;; declaration is repeated before such a module is used. The repeat has no body
  ;; to instrument, and a module path relative to the source still reads from
  ;; the load's relative directory.
  (define (declare-language-wrapper name module-path rewrite)
    (parameterize ([current-module-declare-name #f]
                   [current-namespace namespace])
      (eval
       (datum->syntax
        #f
        `(module ,name racket/base
           (require racket/provide (for-syntax racket/base)
                    (prefix-in original: ,module-path)
                    (file ,(path->string expander-path)))
           (provide (filtered-out
                     (lambda (name)
                       (and (regexp-match? #rx"^original:" name)
                            (not (equal? name "original:#%module-begin"))
                            (substring name 9)))
                     (all-from-out ,module-path))
                    (rename-out [debug-module-begin #%module-begin]))
           (define-instrumented-module-begin debug-module-begin original:#%module-begin ,rewrite ,(path->string instrumentation-runtime-path)))))))
  ;; The wrapper hides the language from the import list the manager reads.
  (define (record-language-dependency! module-path)
    (define resolved
      (resolved-module-path-name
       (module-path-index-resolve (module-path-index-join module-path #f))))
    (define file (if (pair? resolved) (car resolved) resolved))
    (when (path? file) (register-external-module file #:indirect? #t)))

  ;; The compilation cache, when this session has one. A failure while using it
  ;; ends its use for the session: what remains runs from source, as without it.
  (define cache-usable?
    (and cache-directory instrument? (not test?) (not language)
         (with-handlers ([exn:fail? (lambda (_) #f)])
           (make-directory* cache-directory)
           (evict-cache! cache-directory)
           #t)))
  (define cache-root-path (and cache-usable? (cache-root cache-directory)))
  (define cache-mode (string->path (if coverage? "compiled/coverage" "compiled/debug")))
  (define plain-mode (string->path "compiled/plain"))
  (define (mode-for path) (if (selected-source? path) cache-mode plain-mode))
  ;; Bytes captured for files this session is loading now, by path.
  (define captured-sources (make-hash))
  ;; Source hash of the bytes the manager's reader hands out, awaiting compilation.
  (define pending-compiles (make-hash))
  ;; Files whose expansion already told the session everything.
  (define delivered-units (make-hash))
  (define build-manager #f)
  (define compiled-unchecked '())
  (define surfaced-failure #f)
  (define current-build-output (make-parameter #f))
  (struct abandoned-build (source code))
  (define (cached-unit path) (string->symbol (path->string path)))
  (define (skip-for-manager path)
    (cond
      [(selected-source? path) #f]
      [(debugger-source? path) (instrumenter-stamp)]
      [else (ordinary-compiled-stamp path compiled-paths compiled-roots compiled-check)]))
  ;; The manager's source reader goes through here: the bytes compiled are the
  ;; bytes captured, and their hash goes with the code.
  (define (open-for-manager path)
    (define resolved (simplify-path (path->complete-path path)))
    (define contents (or (hash-ref captured-sources resolved #f)
                         (call-with-input-file resolved port->bytes)))
    (hash-set! pending-compiles resolved (sha1 (open-input-bytes contents)))
    (open-input-bytes contents resolved))
  ;; Instruments the manager's compile of a selected file, as errortrace's handler
  ;; does; expansion's own compiles and evals pass through.
  (define (compile-for-manager form immediate?)
    (define source (and (syntax? form) (syntax-source form)))
    (define resolved (and (path? source) (simplify-path (path->complete-path source))))
    (define hash (and resolved (hash-ref pending-compiles resolved #f)))
    (cond
      [(not hash) (ordinary-compile form immediate?)]
      [else
       (hash-remove! pending-compiles resolved)
       ;; Every entry depends on the instrumenter; see instrumenter-stamp.
       (register-external-module instrumentation-runtime-path #:indirect? #t)
       (begin0
        (parameterize ([current-load/use-compiled load-selected])
         (cond
           [(selected-source? resolved)
            (define rec (recording (cached-unit resolved) hash
                                   (hash-has-key? captured-sources resolved) '()))
            (define code
              (parameterize ([current-recording rec]
                             [compile-enforce-module-constants #f])
                ((instrument-eval resolved #:top-level? #f #:recording rec
                                  #:finish (lambda (rewritten) (ordinary-compile rewritten immediate?)))
                 form)))
            (when (recording-live? rec) (hash-set! delivered-units resolved #t))
            ;; A dependency fell back during this expansion, so this code cannot
            ;; be recorded against it. It still runs: nothing need expand again.
            (unless cache-usable? (raise (abandoned-build resolved code)))
            (add-replay-log code hash (recording-unit rec) (reverse (recording-events rec))
                            (lambda (holder) (ordinary-compile holder #f)))]
           [else
            (parameterize ([compile-enforce-module-constants enforce-module-constants?])
              (ordinary-compile form immediate?))]))
        (set! compiled-unchecked (cons (cons resolved hash) compiled-unchecked)))]))
  (define (build-entry! resolved)
    (parameterize ([current-compiled-file-roots (list cache-root-path)]
                   [current-path->mode mode-for]
                   [use-compiled-file-check 'exists]
                   [manager-skip-file-handler skip-for-manager]
                   [current-compile compile-for-manager]
                   [moddep-current-open-input-file open-for-manager])
      (unless build-manager (set! build-manager (make-caching-managed-compile-zo)))
      (build-manager resolved))
    ;; A record that describes a later save than the code would pass for current
    ;; next time, and dependents would compile against the old code. Drop it.
    (for ([compiled (in-list compiled-unchecked)])
      (define mode (mode-for (car compiled)))
      (unless (entry-records-hash? cache-root-path mode (car compiled) (cdr compiled))
        (remove-entry! cache-root-path mode (car compiled))))
    (set! compiled-unchecked '()))
  ;; Read and declare the file's entry. Returns the replay log, or #f for plain code.
  (define (declare-entry! resolved selected? contents)
    (define mode (if selected? cache-mode plain-mode))
    (define stored (or (read-entry-bytes cache-root-path mode resolved)
                       (error 'debug-cache "damaged entry for ~a" resolved)))
    (define-values (directory _name _dir?) (split-path resolved))
    (define code
      (parameterize ([read-accept-compiled #t]
                     [read-on-demand-source #f]
                     [current-load-relative-directory directory])
        (read (open-input-bytes stored))))
    ;; Compare before declaring: the code of a different source must not be seen.
    (define-values (log program)
      (if selected?
          (take-replay-log code ordinary-eval)
          (values #f code)))
    (when (and log (not (equal? (replay-source-hash log) (sha1 (open-input-bytes contents)))))
      (error 'debug-cache "entry for ~a does not match the source" resolved))
    (parameterize ([current-load-relative-directory directory])
      (ordinary-eval program))
    (mark-entry-used! cache-root-path mode resolved)
    log)
  ;; Tell the session what expansion would have, in the order expansion did.
  (define (replay! resolved log)
    (define-values (directory _name _dir?) (split-path resolved))
    (define unit (hold-unit! (replay-unit log)))
    (for ([event (in-list (replay-events log))])
      (case (car event)
        [(language)
         (parameterize ([current-load-relative-directory directory])
           (declare-language-wrapper (cadr event) (caddr event) #f))]
        [(load) (module-declared? (string->path (cadr event)) #t)]
        [(form)
         (define descriptors
           (for/list ([entry (in-list (cadddr event))])
             (define-values (line column position span tail? visible?) (vector->values entry))
             (cons (site (fresh-id) resolved line column position span tail? #f) visible?)))
         (register-form-sites! unit (caddr event) (form-callback resolved (cadr event))
                               (map car descriptors))
         (on-sites (for/list ([descriptor (in-list descriptors)] #:when (cdr descriptor))
                     (car descriptor)))])))
  ;; Load one file through the cache. Falls back to the ordinary path on failure
  ;; of the cache; a failure of the program itself surfaces from that path.
  (define (load-through-cache resolved selected? expected)
    (define contents (and selected? (capture-source! resolved)))
    (when selected? (hash-set! captured-sources resolved contents))
    (define outermost? (not (current-build-output)))
    (define output (or (current-build-output) (open-output-bytes)))
    (define program-out (current-output-port))
    (define (flush-output!)
      (when outermost? (write-bytes (get-output-bytes output) program-out)))
    (define (from-source reason)
      (set! cache-usable? #f)
      (log-debug-cache-warning "using source for ~a: ~a" resolved reason)
      (when selected? (remove-entry! cache-root-path cache-mode resolved))
      (with-handlers ([(lambda (_) #t) (lambda (raised) (set! surfaced-failure raised) (raise raised))])
        (ordinary-load resolved expected)))
    (define outcome
      (with-handlers
          ([(lambda (raised) (and (abandoned-build? raised)
                                  (equal? (abandoned-build-source raised) resolved)))
            (lambda (raised)
              (flush-output!)
              (lambda ()
                (define-values (directory _name _dir?) (split-path resolved))
                (parameterize ([current-load-relative-directory directory])
                  (ordinary-eval (abandoned-build-code raised)))))]
           [abandoned-build? (lambda (raised) (lambda () (from-source "a dependency uses source")))]
           [(lambda (raised) (and (not (exn:break? raised)) (eq? raised surfaced-failure)))
            (lambda (raised) (flush-output!) (lambda () (raise raised)))]
           [exn:fail?
            (lambda (raised) (lambda () (from-source (exn-message raised))))])
        (parameterize ([current-build-output output]
                       [current-output-port (if outermost? output (current-output-port))]
                       [current-error-port (if outermost? output (current-error-port))])
          (build-entry! resolved)
          (define log (declare-entry! resolved selected? (or contents #"")))
          (hash-remove! captured-sources resolved)
          (define delivered? (hash-ref delivered-units resolved #f))
          (hash-remove! delivered-units resolved)
          (flush-output!)
          (lambda ()
            (when (and log (not delivered?)) (replay! resolved log))))))
    (outcome)
    (hash-remove! captured-sources resolved))
  (define (load-selected path expected)
    ;; Load handlers are dynamically inherited, including by a nested
    ;; run-module. Only this execution's module registry belongs to us. In
    ;; another registry, preserve a nested loader's evaluator and cache policy.
    (cond
      [(not (target-registry?))
       (if (and (selected-load-request)
                (eq? policy-owner (current-compilation-policy-owner)))
           ;; Expansion may create a foreign namespace and wrap the handler.
           ;; Restore only our own policy, preserving a nested loader's policy.
           (parameterize ([compile-enforce-module-constants enforce-module-constants?]
                          [use-compiled-file-paths compiled-paths]
                          [current-compiled-file-roots compiled-roots]
                          [use-compiled-file-check compiled-check]
                          [current-path->mode #f]
                          [current-compile ordinary-compile])
             (ordinary-load path expected))
           (ordinary-load path expected))]
      [else
       (define resolved (simplify-path (path->complete-path path)))
       (define selected? (selected-source? resolved))
       (define owner (current-compilation-policy-owner))
       (if (and (not selected?) owner (not (eq? owner policy-owner)))
           ;; A loader nested in this registry, such as a hosted debugger
           ;; library, owns the policy of its own request. Keep that policy.
           (ordinary-load path expected)
           ;; Compare source loads on both sides of the equivalence harness. Only
           ;; selected files bypass bytecode and permit binding assignment. Restore
           ;; the caller's compilation policy for dependencies loaded inside them.
           (parameterize ([compile-enforce-module-constants
                           (if (and selected? instrument?) #f enforce-module-constants?)]
                          [use-compiled-file-paths (if selected? '() compiled-paths)]
                          [current-compiled-file-roots compiled-roots]
                          [use-compiled-file-check compiled-check]
                          [current-path->mode #f]
                          [current-compile ordinary-compile]
                          [selected-load-request (and selected? resolved)]
                          [current-compilation-policy-owner policy-owner]
                          [current-eval ordinary-eval])
             (when (and selected? (current-recording))
               (record! (current-recording) (list 'load (path->string resolved))))
             (if (use-cache-for? resolved selected? expected)
                 (load-through-cache resolved selected? expected)
                 (ordinary-load path expected))))]))
  (define (use-cache-for? resolved selected? expected)
    (and cache-usable?
         ;; A false leading name asks for an independently loadable submodule;
         ;; nothing is read for that, and the real request follows.
         expected (not (and (pair? expected) (not (car expected))))
         (file-exists? resolved)
         (or selected?
             (and (not (debugger-source? resolved))
                  (not (ordinary-compiled-stamp resolved compiled-paths compiled-roots compiled-check))))))
  ;; Capture before either callback can edit the file. The reader consumes these
  ;; same bytes, and source consumers never need to reopen the path.
  (define (capture-source! resolved)
    (define contents (call-with-input-file resolved port->bytes))
    (define text (string->immutable-string (source-text contents)))
    (on-source resolved)
    (on-source-snapshot resolved text)
    contents)
  (define (open-source-snapshot resolved)
    (define contents (or (hash-ref captured-sources resolved #f)
                         (capture-source! resolved)))
    (define text (string->immutable-string (source-text contents)))
    (when (and test? (equal? resolved source))
      (define tests (discover-tests text))
      (when test-selection
        (unless (and tests (equal? (hash-ref test-selection 'sourceHash) (test-source-hash text))
                     (andmap (lambda (id) (findf (lambda (test) (= id (hash-ref test 'id))) tests))
                             (hash-ref test-selection 'ids)))
          (error 'test "Test selection is out of date or this file requires a whole-file run.")))
      (set! discovered-tests (or tests '())))
    (open-input-bytes contents resolved))
  (define (evaluate-loaded-form form)
    ;; Match load's per-form prompt: an abort leaves the whole load, rather than
    ;; proceeding to another source form inside this reader loop.
    (define tag (default-continuation-prompt-tag))
    (call-with-continuation-prompt
     (lambda () (eval form)) tag
     (lambda arguments (apply abort-current-continuation tag arguments))))
  (define (load-source-snapshot resolved expected)
    (cond
      [expected
       ;; The ordinary compiled-load handler has already selected this source
       ;; path. Read and check its module form using Racket's module reader,
       ;; then evaluate once in the current declaration namespace.
       (define ordinary-open (moddep-current-open-input-file))
       (parameterize ([moddep-current-open-input-file
                       (lambda (path)
                         (if (and (target-registry?)
                                  (equal? resolved (simplify-path (path->complete-path path))))
                             (open-source-snapshot resolved)
                             (ordinary-open path)))])
         (get-module-code resolved #:sub-path '() #:rkt-try-ss? #f
                          #:compile (lambda (form)
                                      (evaluate-loaded-form
                                       (if (and test? (equal? resolved source) (pair? discovered-tests))
                                           (wrap-discovered-tests form discovered-tests (and test-selection #t)) form)))))]
      [else
       (define input (open-source-snapshot resolved))
       (port-count-lines! input)
       (dynamic-wind
         void
         (lambda ()
           (let loop ([results (list (void))])
             ;; Plain loads retain the current readtable and other reader
             ;; settings, including changes made by earlier top-level forms.
             (define form
               (parameterize ([read-accept-compiled #t]
                              [read-accept-reader #t]
                              [read-accept-lang #t]
                              [read-on-demand-source
                               (and (load-on-demand-enabled) resolved)])
                 (read-syntax resolved input)))
             (if (eof-object? form)
                 (apply values results)
                 (call-with-values
                  (lambda ()
                    (evaluate-loaded-form
                     (if (compiled-expression? (syntax-e form))
                         form
                         (datum->syntax #f (cons '#%top-interaction form) form))))
                  (lambda results (loop results))))))
         (lambda () (close-input-port input)))]))
  (define (load-plain-source path expected)
    ;; `load` bypasses current-load/use-compiled. This source boundary handles
    ;; both entry routes after the ordinary loader has resolved source paths.
    (cond
      [(not (target-registry?)) (ordinary-source-load path expected)]
      ;; A false leading name requests an independently loadable submodule.
      ;; Source must not be read or evaluated in response to that request.
      [(and (pair? expected) (not (car expected)))
       (ordinary-source-load path expected)]
      [else
       (define resolved (simplify-path (path->complete-path path)))
       (define request (selected-load-request))
       (define selected?
         (and (not (excluded? resolved))
          (or (selected-source? resolved)
             ;; Preserve the ordinary loader's .rkt-to-.ss source fallback.
             (and expected request
                  (equal? (path-get-extension request) #".rkt")
                  (equal? resolved (path-replace-extension request #".ss"))))))
       (parameterize ([current-eval
                       (if (and selected? instrument?)
                           (instrument-eval resolved #:top-level? (not expected))
                           (if expected (current-eval) ordinary-eval))])
         (if selected?
             (load-source-snapshot resolved expected)
             (ordinary-source-load path expected)))]))
  (values load-selected load-plain-source
          (lambda (selected) (set! entry-submodule selected))
          (lambda () (set! entry-announced? #t))))

;; Load source in a fresh namespace and custodian. Stop callbacks run on the
;; target thread; selected modules bypass bytecode without writing caches.
(define (run-module path
                    #:instrument? [instrument? #t]
                    #:images? [images? #f]
                    #:coverage? [coverage? #f]
                    #:language [language #f]
                    #:on-sites [on-sites void]
                    #:on-event [on-event #f]
                    #:on-entry [on-entry #f]
                    #:on-exception [on-exception #f]
                    #:on-error [on-error void]
                    #:on-pause [on-pause #f]
                    #:on-source [on-source void]
                    #:on-source-snapshot [on-source-snapshot void]
                    #:source-selected? [source-selected? (lambda (_path) #f)]
                    #:sources [additional-sources '()]
                    #:source-roots [source-roots '()]
                    #:submodule [submodule '()]
                    #:main? [main? #f]
                    #:test? [test? #f]
                    #:test-selection [test-selection #f]
                    #:on-test-event [on-test-event void]
                    #:on-ready [on-ready #f]
                    #:entry [entry #f]
                    #:cache-directory [cache-directory #f])
  (define source (simplify-path (path->complete-path path)))
  (unless (and (list? submodule) (andmap symbol? submodule))
    (raise-argument-error 'run-module "list of submodule symbols" submodule))
  (when (and language (pair? submodule))
    (error 'run-module "A plain-file language cannot be combined with a submodule selection."))
  (when (and test? (or language (pair? submodule) main? entry on-ready))
    (error 'run-module "Test mode cannot be combined with language, submodule, main, entry, or interactive execution."))
  ;; Resolve launch paths before loading a language, which may change the
  ;; current directory while it initializes.
  (define (canonical path) (simplify-path (path->complete-path path)))
  (define selected-sources (map canonical additional-sources))
  (define roots (map canonical source-roots))
  (define target (if (null? submodule) source `(submod ,source ,@submodule)))
  (define namespace (make-base-namespace))
  ;; Image values and the debugger must share the conversion property identity.
  (when (or instrument? images?)
    (namespace-attach-module (namespace-anchor->namespace anchor) 'file/convertible namespace))
  (when language
    (unless (symbol? language) (raise-argument-error 'run-module "language module-path symbol" language))
    (parameterize ([current-namespace namespace]) (namespace-require language)))
  (define-values (load-selected load-plain-source select-entry! finish-entry!)
    (make-debug-loader namespace source
                       #:instrument? instrument? #:coverage? coverage? #:language language
                       #:on-sites on-sites #:on-event on-event #:on-entry on-entry
                       #:on-source on-source #:on-source-snapshot on-source-snapshot
                       #:source-selected? source-selected? #:sources selected-sources
                       #:source-roots roots #:test? test? #:test-selection test-selection
                       #:cache-directory cache-directory))
  (define program-custodian (make-custodian))
  (define ordinary-uncaught (uncaught-exception-handler))
  (define exception-handler-tag (make-continuation-prompt-tag 'module-exception-handler))
  (define report-test-error void)
  (define debug-exception-handler (make-debug-exception-handler on-exception on-pause))
  (define (exception-handler value)
    (begin0 (debug-exception-handler value)
      (on-error value)
      (report-test-error value)))
  (dynamic-wind
    void
    (lambda ()
      (parameterize ([current-custodian program-custodian]
                     [current-namespace namespace]
                     [current-load/use-compiled load-selected]
                     [current-load load-plain-source]
                     [uncaught-exception-handler
                      (lambda (value)
                        ;; The enclosing handler already observed this raise.
                        ;; Child threads inherit parameters, but not this prompt,
                        ;; so their uncaught errors still need observation.
                        (unless (continuation-prompt-available? exception-handler-tag)
                          (exception-handler value))
                        (ordinary-uncaught value))])
        (call-with-continuation-prompt
         (lambda ()
           (call-with-exception-handler
            exception-handler
            (lambda ()
              (define (execute)
                (define test-submodule?
                  (and test? (module-declared? `(submod ,source test) #t)))
                ;; Discover main before instantiation, so parent initialization
                ;; remains debuggable without consuming the automatic entry stop.
                ;; This loads the declaration through the same snapshot/expansion
                ;; path; dynamic-require below reuses it.
                (select-entry!
                 (cond
                   [(and on-entry (not language) main?
                         (module-declared? `(submod ,source main) #t)) '(main)]
                   [test-submodule? '(test)]
                   [else submodule]))
                (unless language
                  ;; Configure the launched module, not its dependencies. Tests
                  ;; use the enclosing file's configuration, as raco test does.
                  (define runtime-target (if test? source target))
                  (define config-module `(submod ,source ,@(if test? '() submodule) configure-runtime))
                  (when (module-declared? config-module #t)
                    (dynamic-require config-module #f))
                  ;; Racket also applies legacy language metadata after the
                  ;; submodule. raco test uses only the submodule protocol.
                  (define info (and (not test?) (module->language-info runtime-target #t)))
                  (define (invoke spec)
                    ((dynamic-require (vector-ref spec 0) (vector-ref spec 1)) (vector-ref spec 2)))
                  (when info
                    (for ([config (in-list ((invoke info) 'configure-runtime '()))])
                      (invoke config))))
                (if language
                    (begin
                      (when instrument?
                        (eval `(require (only-in (file ,(path->string instrumentation-runtime-path))))))
                      (load source))
                    (dynamic-require
                     (if test-submodule?
                         `(submod ,source test) target) #f))
                (when (and (not language) main? (module-declared? `(submod ,source main) #t))
                  (dynamic-require `(submod ,source main) #f))
                (begin0 (if entry ((if language (eval entry) (dynamic-require target entry))) (void))
                  ;; An empty entry module must not defer its entry stop to a
                  ;; subsequent Debug Console expression or GUI callback.
                  (finish-entry!)
                  (if on-ready
                      (on-ready (if language namespace (module->namespace target)))
                      ((executable-yield-handler) 0))))
              (if test?
                  (let-values ([(run-tests report-error)
                                ((dynamic-require testing-path 'make-test-runner) on-test-event
                                 (and test-selection (hash-ref test-selection 'ids))
                                 (if test-selection (hash-ref test-selection 'cases '()) '()))])
                    (set! report-test-error report-error)
                    (run-tests execute))
                  (execute)))))
         exception-handler-tag)))
    (lambda () (custodian-shutdown-all program-custodian))))
