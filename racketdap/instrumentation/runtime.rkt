#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list (for-syntax racket/base))
(provide (struct-out site) site-phases site-boundary-position (struct-out unavailable)
         debug-stop? stop-site stop-kind stop-frame-count stop-frame-site
         stop-locals stop-evaluate stop-results
         stop-binding-value stop-set-binding!
         stop-skip! stop-replace-results! stop-approximate?
         stop-token stop-contexts stop-return-token call-with-exception-stop call-with-pause-stop
         call-with-thread-stop debugger-active-key
         make-activation make-live-binding make-frame frame-key context-key
         announce-before announce-after announce-visit current-expression-token register-module-context!)

(struct site (id source line column position span tail? expression) #:transparent)
(define (site-phases descriptor)
  (unless (site? descriptor) (raise-argument-error 'site-phases "site?" descriptor))
  (if (site-tail? descriptor) '(before) '(before after)))
(define (site-boundary-position descriptor phase)
  (unless (memq phase (site-phases descriptor))
    (raise-arguments-error 'site-boundary-position "phase is unavailable for this site"
                           "phase" phase "available phases" (site-phases descriptor)))
  (define position (site-position descriptor))
  (define span (site-span descriptor))
  (and (exact-positive-integer? position)
       (if (eq? phase 'before)
           position
           (and (exact-positive-integer? span) (+ position span -1)))))
(struct unavailable (reason) #:transparent)
(struct live-binding (name read write) #:transparent)
(struct activation (identity return-token) #:transparent)
(struct frame (activation bindings module-bindings context-bindings namespace site parameters) #:transparent)
(struct debug-stop (site kind frames results token contexts return-token owner live action))
(define frame-key (make-continuation-mark-key 'racket-debug-frame))
(define context-key (make-continuation-mark-key 'racket-debug-expression))
(define debugger-active-key (make-continuation-mark-key 'racket-debugger-active))
(define debugging-enabled? (make-parameter #t))
;; A helper instance imported at transformer phase must not invoke callbacks.
(define runtime-phase-zero?
  (zero? (variable-reference->module-base-phase (#%variable-reference))))
;; Expansion contexts are opaque keys. Each namespace registry gets the live
;; namespace of the owning module instance, registered before its source forms.
;; Namespaces retain their registry and instrumented module context constants.
;; Both associations need ephemerons so those backreferences do not root a
;; completed target, while a live target keeps all of its registrations usable.
(define module-context-instances (make-ephemeron-hasheq))
(define (register-module-context! context reference [ancestors '()])
  (when (zero? (variable-reference->module-base-phase reference))
    (define namespace (variable-reference->namespace reference))
    (define registry (namespace-module-registry namespace))
    (define (register owner instance-namespace)
      (define instances
        (hash-ref! module-context-instances owner make-ephemeron-hasheq))
      (hash-set! instances registry instance-namespace))
    (register context namespace)
    ;; A parent consisting solely of transformer definitions has no runtime
    ;; initializer. An inherited child nevertheless has its instantiated parent
    ;; in the same registry; use actual module ancestry to locate that instance.
    (let loop ([owners ancestors]
               [name (resolved-module-path-name
                      (variable-reference->resolved-module-path reference))])
      (when (pair? owners)
        (unless (and (pair? name) (pair? (cdr name)))
          (error 'register-module-context! "inherited module has no parent"))
        (define parent-name
          (if (null? (cddr name)) (car name) (drop-right name 1)))
        (define instances (hash-ref module-context-instances (car owners) #f))
        (unless (and instances (hash-ref instances registry #f))
          (register (car owners)
                    (module->namespace (make-resolved-module-path parent-name) namespace)))
        (loop (cdr owners) parent-name)))))
(define (context-binding-namespace owner target-namespace)
  (define instances (hash-ref module-context-instances owner #f))
  (define owner-namespace
    (and instances
         (hash-ref instances (namespace-module-registry target-namespace) #f)))
  (unless owner-namespace
    (error 'stop-evaluate "module binding context has not been registered"))
  owner-namespace)
(define (context-binding-target owner id target-namespace)
  (define owner-namespace (context-binding-namespace owner target-namespace))
  (define binding (identifier-binding id))
  (unless (and (list? binding) (>= (length binding) 2))
    (error 'stop-evaluate "module binding has no resolved identity: ~a" (syntax-e id)))
  ;; The binding symbol is supplied by the expander. Never infer it by stripping
  ;; numeric suffixes or by matching similarly printed source identifiers.
  (parameterize ([current-namespace owner-namespace])
    (namespace-symbol->identifier (cadr binding))))

(define (current-expression-token)
  (continuation-mark-set-first #f context-key #f))
(define (make-activation)
  (activation (gensym 'activation) (current-expression-token)))
(define make-live-binding live-binding)
(define (make-frame activation bindings module-bindings context-bindings namespace site)
  (frame activation bindings module-bindings context-bindings namespace site
         (current-parameterization)))

(define (inspectable-frames [marks #f])
  (define seen (make-hasheq))
  (for/list ([f (in-list (continuation-mark-set->list marks frame-key))]
             #:unless (hash-ref seen (activation-identity (frame-activation f)) #f))
    (hash-set! seen (activation-identity (frame-activation f)) #t)
    f))
(define (check-stop s [who 'debug-stop])
  (unless (debug-stop? s) (raise-argument-error who "debug-stop?" s))
  (unless (eq? (debug-stop-owner s) (current-thread))
    (error who "stop belongs to a different thread"))
  (unless (unbox (debug-stop-live s)) (error who "stop has expired")))
(define (selected-frame s i who)
  (check-stop s who)
  (unless (and (exact-nonnegative-integer? i) (< i (length (debug-stop-frames s))))
    (raise-arguments-error who "invalid frame index" "index" i))
  (list-ref (debug-stop-frames s) i))
(define (stop-site s) (check-stop s 'stop-site) (debug-stop-site s))
(define (stop-kind s) (check-stop s 'stop-kind) (debug-stop-kind s))
(define (stop-approximate? s) (check-stop s 'stop-approximate?) (eq? (debug-stop-kind s) 'pause))
(define (stop-frame-count s) (check-stop s 'stop-frame-count) (length (debug-stop-frames s)))
(define (stop-frame-site s [i 0]) (frame-site (selected-frame s i 'stop-frame-site)))
(define (stop-results s)
  (check-stop s 'stop-results)
  (if (eq? (debug-stop-kind s) 'after)
      (or (unbox (debug-stop-action s)) (debug-stop-results s))
      (debug-stop-results s)))
(define (request-values! s supplied expected-kind who)
  (check-stop s who)
  (unless (eq? (debug-stop-kind s) expected-kind)
    (raise-arguments-error who "operation is not valid for this stop kind"
                           "expected kind" expected-kind
                           "stop kind" (debug-stop-kind s)))
  (unless (list? supplied) (raise-argument-error who "list?" supplied))
  (set-box! (debug-stop-action s) supplied)
  (void))
(define (stop-skip! s supplied)
  (request-values! s supplied 'before 'stop-skip!))
(define (stop-replace-results! s supplied)
  (request-values! s supplied 'after 'stop-replace-results!))
(define (stop-token s) (check-stop s 'stop-token) (debug-stop-token s))
(define (stop-contexts s) (check-stop s 'stop-contexts) (debug-stop-contexts s))
(define (stop-return-token s) (check-stop s 'stop-return-token) (debug-stop-return-token s))

(define (visible-bindings f)
  (define seen (make-hasheq))
  (for/list ([b (in-list (frame-bindings f))]
             #:unless (hash-ref seen (live-binding-name b) #f))
    (hash-set! seen (live-binding-name b) #t)
    b))
(define (read-binding b)
  (with-handlers ([exn:fail:contract:variable?
                   (lambda (e) (unavailable 'uninitialized))])
    ((live-binding-read b))))
(define (stop-locals s [i 0])
  (for/list ([b (in-list (visible-bindings (selected-frame s i 'stop-locals)))])
    (cons (live-binding-name b) (read-binding b))))

(define (frame-module-entries f)
  (append (if (frame-context-bindings f) ((frame-context-bindings f)) '())
          (map (lambda (id) (cons #f id)) (frame-module-bindings f))))
(define (binding-name name who)
  (cond [(symbol? name) name]
        [(string? name) (string->symbol name)]
        [else (raise-argument-error who "(or/c symbol? string?)" name)]))
(define (namespace-identifier name namespace)
  (parameterize ([current-namespace namespace]) (namespace-symbol->identifier name)))
(define (find-source-binding f name who [scope 'visible])
  (or
   (findf (lambda (b) (eq? name (live-binding-name b))) (visible-bindings f))
   (and (eq? scope 'lexical) (error who "no lexical binding named ~a" name))
   (let* ([namespace ((frame-namespace f))]
          [entry (findf (lambda (entry) (eq? name (syntax-e (cdr entry))))
                        (frame-module-entries f))])
     (cond
       [(and entry (car entry))
        (define owner-namespace (context-binding-namespace (car entry) namespace))
        (define id (context-binding-target (car entry) (cdr entry) namespace))
        (cons owner-namespace (syntax-e id))]
       [else
        (define mapped (namespace-identifier name namespace))
        (define internal-name
          (and entry
               (let ([binding (identifier-binding (cdr entry))])
                 (and (list? binding) (cadr binding)))))
        (cond
          [(and (identifier-binding mapped (namespace-base-phase namespace) #t)
                (or (not entry) (free-identifier=? mapped (cdr entry))))
           (cons namespace name)]
          [(and internal-name
                (free-identifier=? (cdr entry) (namespace-identifier internal-name namespace)))
           (cons namespace internal-name)]
          [else (error who "no source-visible variable named ~a" name)])]))))
(define (source-binding-value binding name who)
  (if (live-binding? binding)
      (read-binding binding)
      (with-handlers ([exn:fail:contract:variable? (lambda (_) (unavailable 'uninitialized))]
                      [exn:fail:syntax?
                       (lambda (_) (error who "binding ~a is syntax, not a variable" name))])
        (namespace-variable-value (cdr binding) #t #f (car binding)))))
(define (stop-binding-value s name [i 0])
  (define f (selected-frame s i 'stop-binding-value))
  (define symbol (binding-name name 'stop-binding-value))
  (source-binding-value (find-source-binding f symbol 'stop-binding-value)
                        symbol 'stop-binding-value))
(define (stop-set-binding! s name datum [i 0] #:scope [scope 'visible])
  (define f (selected-frame s i 'stop-set-binding!))
  (define symbol (binding-name name 'stop-set-binding!))
  (unless (memq scope '(lexical visible))
    (raise-argument-error 'stop-set-binding! "(or/c 'lexical 'visible)" scope))
  (define binding (find-source-binding f symbol 'stop-set-binding! scope))
  ;; Resolve and reject syntax before expanding the user's explicit replacement.
  (source-binding-value binding symbol 'stop-set-binding!)
  (cond
    [(live-binding? binding)
     (unless (live-binding-write binding)
       (error 'stop-set-binding! "binding ~a is read-only" symbol))
     ((live-binding-write binding) (evaluate-in-frame f datum))]
    [else
     ;; Retain the core assignment form even when a source binding is named set!.
     ;; The frame evaluator supplies the selected source alias and native checks.
     (evaluate-in-frame f #`(set! #,(datum->syntax #f symbol) #,(datum->syntax #f datum)))])
  (source-binding-value binding symbol 'stop-set-binding!))

;; Debugger transformers embed live access procedures as constants. They do not
;; mutate the target module namespace.
(define (binding-transformer b)
  (make-set!-transformer
   (lambda (use)
     (define getter #`((quote #,(live-binding-read b))))
     (syntax-case use (set!)
       [id (identifier? #'id) getter]
       [(set! id rhs)
        (if (live-binding-write b)
            #`((quote #,(live-binding-write b)) rhs)
            (raise-syntax-error #f "binding is read-only" use))]
       [(id . arguments) #`(#,getter . arguments)]))))
(define (evaluate-in-frame f datum)
  (define names (visible-bindings f))
  (define namespace ((frame-namespace f)))
  (define seen (make-hasheq))
  (for ([b (in-list names)]) (hash-set! seen (live-binding-name b) #t))
  (define module-aliases
    (for/list ([entry (in-list (frame-module-entries f))]
               #:unless (hash-ref seen (syntax-e (cdr entry)) #f))
      (define id (cdr entry))
      (hash-set! seen (syntax-e id) #t)
      (define target
        (if (car entry) (context-binding-target (car entry) id namespace) id))
      #`[#,(datum->syntax #f (syntax-e id))
         (quote #,(make-rename-transformer target))]))
  (define expression
    #`(let-syntax
        (#,@(for/list ([b (in-list names)])
              #`[#,(datum->syntax #f (live-binding-name b))
                 (quote #,(binding-transformer b))])
           #,@module-aliases)
        #,(datum->syntax #f datum)))
  (parameterize ([debugging-enabled? #f])
    (call-with-continuation-barrier
     (lambda () (eval expression namespace)))))
(define (stop-evaluate s datum [i 0])
  (evaluate-in-frame (selected-frame s i 'stop-evaluate) datum))
(define (deliver callback descriptor kind results token [marks #f] #:empty? [empty? #f])
  (and runtime-phase-zero? callback (debugging-enabled?)
       (let ([frames (inspectable-frames marks)])
         (and
          (or empty? (pair? frames))
          (let* ([contexts (continuation-mark-set->list marks context-key)]
                 [enclosing (if (and token (pair? contexts) (eq? token (car contexts)))
                                (cdr contexts) contexts)]
                 [action (box #f)]
                 [s (debug-stop descriptor kind frames results token enclosing
                                (and (pair? frames) (activation-return-token (frame-activation (car frames))))
                                (current-thread) (box #t) action)])
            (parameterize ([debugging-enabled? #f])
              (call-with-continuation-barrier
               (lambda ()
                 (dynamic-wind
                   (lambda () (check-stop s 'debug-callback))
                   (lambda ()
                     (with-continuation-mark debugger-active-key #t
                       (call-with-values (lambda () (callback s)) (lambda ignored (void)))))
                   (lambda () (set-box! (debug-stop-live s) #f))))))
            ;; Each delivery owns this decision. Continuation re-entry through an
            ;; expression completion creates a new stop and a fresh decision.
            (unbox action))))))
(define (announce-before descriptor token on-event)
  (deliver on-event descriptor 'before #f token))
;; Coverage records only that a site began. It needs no frames, results or
;; stop, so the callback receives the site itself.
(define (announce-visit descriptor on-visit)
  (when (and runtime-phase-zero? on-visit (debugging-enabled?))
    (on-visit descriptor)))
(define (announce-after descriptor token on-event results)
  (define replacement (deliver on-event descriptor 'after results token))
  (apply values (or replacement results)))
(define (call-with-exception-stop raised callback)
  (when (and callback (not (exn:break? raised)) (debugging-enabled?))
    (define exception-marks (and (exn? raised) (exn-continuation-marks raised)))
    (define marks
      (if (and exception-marks (pair? (inspectable-frames exception-marks)))
          exception-marks #f))
    (define frames (inspectable-frames marks))
    (when (pair? frames)
      (deliver callback (frame-site (car frames)) 'exception (list raised) #f marks)))
  raised)

;; Call only from an exception handler before unwinding the interrupted program.
;; The loader owns identifying its Pause request and invoking the break's resume
;; continuation after this function returns and the callback barrier is gone.
(define (call-with-pause-stop interruption callback)
  (unless (exn:break? interruption)
    (raise-argument-error 'call-with-pause-stop "exn:break?" interruption))
  (when (and runtime-phase-zero? callback (debugging-enabled?)
             (not (exn:break:hang-up? interruption))
             (not (exn:break:terminate? interruption)))
    (define marks (exn-continuation-marks interruption))
    (define frames (inspectable-frames marks))
    (when (pair? frames)
      (parameterize-break
       #f
       (deliver callback (frame-site (car frames)) 'pause #f #f marks))))
  interruption)

;; Pause must not raise an exception in application code. A library can handle
;; a break before the debugger sees it, causing arbitrary application effects.
;; Keep the selected thread suspended while a service thread handles inspection.
;; Its evaluation context comes from the innermost captured source frame; the
;; service thread has its own thread identity and thread cells.
(define (call-with-thread-stop target callback)
  (when (eq? target (current-thread))
    (raise-arguments-error 'call-with-thread-stop "cannot suspend the calling thread"))
  (define resume? (thread-running? target))
  (dynamic-wind
    (lambda () (when resume? (thread-suspend target)))
    (lambda ()
      (define marks (continuation-marks target))
      (cond
        [(or (thread-dead? target)
             (continuation-mark-set-first marks debugger-active-key #f)) #f]
        [else
         (define frames (inspectable-frames marks))
         (call-with-parameterization
          (if (pair? frames) (frame-parameters (car frames)) (current-parameterization))
          (lambda ()
            (deliver callback (and (pair? frames) (frame-site (car frames)))
                     'pause #f #f marks #:empty? #t)))
         #t]))
    (lambda () (when resume? (thread-resume target)))))
