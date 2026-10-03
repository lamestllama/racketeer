#lang racket/base

(require (only-in ffi/unsafe/global get-place-table)
         file/convertible
         racket/path
         racket/port
         racket/runtime-path
         syntax/modcode
         "../test-discovery.rkt"
         "../instrumentation/instrument.rkt")
(provide run-module make-debug-exception-handler)

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

;; The worker loads this module before starting debuggee threads. Its first
;; instantiation establishes one parameter per place; later loader copies in
;; other registries or phases reuse it. A parameter carries dynamic ownership
;; through forwarding handlers, continuation prompts, and inherited threads.
(define current-compilation-policy-owner
  (hash-ref! (get-place-table) 'racketeer/worker/load:compilation-policy-owner
             (lambda () (make-parameter #f))))

;; Load source in a fresh namespace and custodian. Stop callbacks run on the
;; target thread; selected modules bypass bytecode without writing caches.
(define (run-module path
                    #:instrument? [instrument? #t]
                    #:coverage? [coverage? #f]
                    #:language [language #f]
                    #:on-sites [on-sites void]
                    #:on-event [on-event #f]
                    #:on-exception [on-exception #f]
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
                    #:entry [entry #f])
  (define source (simplify-path (path->complete-path path)))
  (unless (and (list? submodule) (andmap symbol? submodule))
    (raise-argument-error 'run-module "list of submodule symbols" submodule))
  (when (and language (pair? submodule))
    (error 'run-module "A plain-file language cannot be combined with a submodule selection."))
  (when (and test? (or language (pair? submodule) main? entry on-ready))
    (error 'run-module "Test mode cannot be combined with language, submodule, main, entry, or interactive execution."))
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
    (and (not (debugger-source? resolved))
         (or (member resolved selected-sources) (under-root? resolved)
             (source-selected? resolved))))
  (define target (if (null? submodule) source `(submod ,source ,@submodule)))
  (define namespace (make-base-namespace))
  ;; Image values and the debugger must share the conversion property identity.
  (when instrument?
    (namespace-attach-module (namespace-anchor->namespace anchor) 'file/convertible namespace))
  (when language
    (unless (symbol? language) (raise-argument-error 'run-module "language module-path symbol" language))
    (parameterize ([current-namespace namespace]) (namespace-require language)))
  (when instrument?
    (namespace-attach-module (namespace-anchor->namespace anchor)
                             instrumentation-path namespace)
    (namespace-attach-module (namespace-anchor->namespace anchor)
                             instrumentation-runtime-path namespace))
  (define ordinary-load (current-load/use-compiled))
  (define ordinary-source-load (current-load))
  (define ordinary-eval (current-eval))
  (define compiled-paths (use-compiled-file-paths))
  (define enforce-module-constants? (compile-enforce-module-constants))
  (define selected-load-request (make-parameter #f))
  (define policy-owner (gensym 'compilation-policy))
  (define registry (namespace-module-registry namespace))
  (define (target-registry?)
    (eq? registry (namespace-module-registry (current-namespace))))
  (define next-id 0)
  (define discovered-tests '())
  (define (fresh-id)
    (begin0 next-id (set! next-id (add1 next-id))))
  (define (instrument-eval selected-source #:top-level? [top-level? language])
    (lambda (form)
      (parameterize ([current-eval ordinary-eval])
        (define wrapper-name (gensym 'racketdap-form))
        (define (language-wrapper language context bindings)
          (define name (gensym 'racketdap-language))
          (define rewrite (make-transform bindings))
          (parameterize ([current-module-declare-name #f]
                         [current-namespace namespace])
            (eval
             (datum->syntax
              #f
              `(module ,name racket/base
                 (require racket/provide (for-syntax racket/base)
                          (prefix-in original: ,(syntax->datum language))
                          (file ,(path->string expander-path)))
                 (provide (filtered-out
                           (lambda (name)
                             (and (regexp-match? #rx"^original:" name)
                                  (not (equal? name "original:#%module-begin"))
                                  (substring name 9)))
                           (all-from-out ,(syntax->datum language)))
                          (rename-out [debug-module-begin #%module-begin]))
                 (define-instrumented-module-begin debug-module-begin original:#%module-begin ,rewrite ,(path->string instrumentation-runtime-path))))))
          (datum->syntax context `(quote ,name)))
        (define (annotate expanded [bindings #f])
          (define-values (annotated sites)
            (instrument-module expanded selected-source fresh-id on-event #:module-context bindings
                               #:coverage? coverage?))
          (on-sites sites)
          annotated)
        (define (make-transform bindings)
          (lambda (kind stx)
            (case kind
              [(declaration) (record-module-bindings! bindings stx selected-source)]
              [(expression) (annotate stx bindings)]
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
                  (if (syntax-e #'language)
                      #`(head name #,(language-wrapper #'language item child) form ...)
                      #`(head name language #,@(wrap-body (syntax->list #'(form ...)) item child))))]
               [_ #`(#,wrapper #,transform #,item)]))))
        (define (rewrite-submodule form [parent-bindings #f])
          (define (context-for name inherit?)
            (if parent-bindings
                (module-binding-context-child! parent-bindings (syntax-e name) inherit?)
                (make-module-binding-context)))
          ;; Keep declaration bindings when a module is loaded during expansion.
          (define rewritten
            (syntax-case form (module module* module+ begin)
            [(module . _) (not (equal? (syntax-source form) selected-source)) form]
            [(module* . _) (not (equal? (syntax-source form) selected-source)) form]
            [(module name language (mb body ...))
             (and (memq (syntax-e #'language) '(racket/base racket))
                  (eq? (syntax-e #'mb) '#%module-begin))
             #`(#,(car (syntax-e form)) name language
                 (mb #,@(wrap-body (syntax->list #'(body ...)) #'mb (context-for #'name #f))))]
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
              (datum->syntax rewritten (syntax-e rewritten) form form)
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
             (ordinary-eval #`(define-values ids #,(annotate (expand-syntax #'rhs))))]
            [(define-syntaxes . _) (ordinary-eval partial)]
            [(begin-for-syntax . _) (ordinary-eval partial)]
            [(#%require . _) (ordinary-eval partial)]
            [(module . _) (ordinary-eval (rewrite-submodule partial))]
            [_ (ordinary-eval (annotate (expand-syntax partial)))]))
        (if (and top-level? (not (compiled-expression? form)))
            (eval-top form)
            (ordinary-eval (rewrite-submodule form))))))
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
                          [use-compiled-file-paths compiled-paths])
             (ordinary-load path expected))
           (ordinary-load path expected))]
      [else
       (define resolved (simplify-path (path->complete-path path)))
       (define selected? (selected-source? resolved))
       ;; Compare source loads on both sides of the equivalence harness. Only
       ;; selected files bypass bytecode and permit binding assignment. Restore
       ;; the caller's compilation policy for dependencies loaded inside them.
       (parameterize ([compile-enforce-module-constants
                       (if (and selected? instrument?) #f enforce-module-constants?)]
                      [use-compiled-file-paths (if selected? '() compiled-paths)]
                      [selected-load-request (and selected? resolved)]
                      [current-compilation-policy-owner policy-owner]
                      [current-eval ordinary-eval])
         (ordinary-load path expected))]))
  (define (open-source-snapshot resolved)
    ;; Capture before either callback can edit the file. The reader consumes
    ;; these same bytes, and source consumers never need to reopen the path.
    (define contents (call-with-input-file resolved port->bytes))
    (define text (string->immutable-string (bytes->string/utf-8 contents #\uFFFD)))
    (when (and test? (equal? resolved source))
      (define tests (discover-tests text))
      (when test-selection
        (unless (and tests (equal? (hash-ref test-selection 'sourceHash) (test-source-hash text))
                     (andmap (lambda (id) (findf (lambda (test) (= id (hash-ref test 'id))) tests))
                             (hash-ref test-selection 'ids)))
          (error 'test "Test selection is out of date or this file requires a whole-file run.")))
      (set! discovered-tests (or tests '())))
    (on-source resolved)
    (on-source-snapshot resolved text)
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
         (or (selected-source? resolved)
             ;; Preserve the ordinary loader's .rkt-to-.ss source fallback.
             (and expected request
                  (equal? (path-get-extension request) #".rkt")
                  (equal? resolved (path-replace-extension request #".ss")))))
       (parameterize ([current-eval
                       (if (and selected? instrument?)
                           (instrument-eval resolved #:top-level? (not expected))
                           (if expected (current-eval) ordinary-eval))])
         (if selected?
             (load-source-snapshot resolved expected)
             (ordinary-source-load path expected)))]))
  (define program-custodian (make-custodian))
  (define ordinary-uncaught (uncaught-exception-handler))
  (define report-test-error void)
  (define debug-exception-handler (make-debug-exception-handler on-exception on-pause))
  (define (exception-handler value)
    (begin0 (debug-exception-handler value)
      (report-test-error value)))
  (dynamic-wind
    void
    (lambda ()
      (parameterize ([current-custodian program-custodian]
                     [current-namespace namespace]
                     [current-load/use-compiled load-selected]
                     [current-load load-plain-source]
                     [uncaught-exception-handler
                      (lambda (value) (exception-handler value) (ordinary-uncaught value))])
        (call-with-exception-handler
         exception-handler
         (lambda ()
           (define (execute)
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
                  (if (and test? (module-declared? `(submod ,source test) #t))
                      `(submod ,source test) target) #f))
             (when (and (not language) main? (module-declared? `(submod ,source main) #t))
               (dynamic-require `(submod ,source main) #f))
             (begin0 (if entry ((if language (eval entry) (dynamic-require target entry))) (void))
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
               (execute))))))
    (lambda () (custodian-shutdown-all program-custodian))))
