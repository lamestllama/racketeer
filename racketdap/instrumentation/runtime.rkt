#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list '#%paramz ffi/unsafe/vm (for-syntax racket/base))
(provide (struct-out site) site-phases site-boundary-position arm-site! (struct-out unavailable)
         debug-stop? stop-site stop-kind stop-frame-count stop-frame-site
         stop-locals stop-evaluate stop-results
         stop-binding-value stop-set-binding!
         stop-skip! stop-replace-results! stop-approximate?
         stop-token stop-contexts stop-return-token call-with-exception-stop call-with-pause-stop
         call-with-thread-stop debugger-active-key
         make-live-binding frame-key context-key first-scope-slot note-thread
         announce-before announce-after leave-with-values announce-visit register-module-context!
         form-sites form-gate form-armed register-form-sites! forget-noted-thread!
         plain-procedure-name
         port-constructor-name? checked-operator instrumented-port?)

;; An applicable structure is a procedure to Racket but a record to the machine, so the
;; machine tells a real procedure from a structure, however opaque, whose prop:object-name
;; could run program code. A real procedure's name is inert.
(define machine-record? (vm-primitive 'record?))
(define (plain-procedure-name value)
  (and (procedure? value) (not (machine-record? value)) (object-name value)))

;; Port predicates also recognize user structures; object-name and port-closed?
;; cannot be queried safely until a real port constructor proves provenance.
;; Compare the actual operator by identity, so aliases work and shadowed or
;; wrapped constructors never enroll arbitrary return values. Keep registration
;; private and weak, as with procedure names.
(define port-constructors
  (for/hasheq ([constructor (in-list (list open-input-string open-input-bytes
                                         open-output-string open-output-bytes
                                         open-input-file open-output-file open-input-output-file
                                         make-pipe make-input-port make-output-port))])
    (values constructor #t)))
(define (port-constructor-name? name)
  (for/or ([constructor (in-hash-keys port-constructors)]) (eq? name (object-name constructor))))
(define ports (make-weak-hasheq))
(define (remember-ports . results)
  (for ([value (in-list results)]) (hash-set! ports value #t))
  (apply values results))
;; What an application whose operator is not a known primitive calls: the operator
;; itself, unless it is a port constructor, whose results are recorded.
(define (checked-operator operator)
  (if (hash-ref port-constructors operator #f)
      (lambda arguments (call-with-values (lambda () (apply operator arguments)) remember-ports))
      operator))
(define (instrumented-port? value) (hash-ref ports value #f))

;; parent and scope are the slot of the enclosing site in the same activation (0
;; for none), and the frame slot holding this site's variables. armed is where a
;; registered site's flag lives, as (vector . index).
(struct site (id source line column position span tail? expression parent scope [armed #:auto #:mutable])
  #:auto-value #f #:transparent)
(define (arm-site! descriptor on?)
  (define armed (site-armed descriptor))
  (when armed (vector-set! (car armed) (cdr armed) on?)))
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
(struct live-binding (name access) #:transparent)
;; A frame is one function call, or the run of one module-level form. It is a vector
;; that generated code makes with `vector` and writes with unsafe-vector*-set!, so
;; these are the only costs a site has: slot 1 is the site running now, as a frame
;; in Python holds its last instruction, and each scope that binds source names
;; stores its variables, a procedure returning its live bindings, in its own slot
;; from first-scope-slot on. Everything else about a frame is read at a stop.
(define first-scope-slot 3)
(define (frame-form f) (vector-ref f 0))
(define (frame-slot f) (vector-ref f 1))
(define (frame-site f) (vector-ref (form-descriptors (frame-form f)) (frame-slot f)))
(define (frame-bindings f)
  (define variables (vector-ref f (site-scope (frame-site f))))
  (if variables (variables) '()))
;; An expression evaluation's identity is its frame and site, named by a token made
;; the first time something asks. Slot 2 keeps them, so the identity stays eq?.
(define (frame-token f slot)
  (define known (vector-ref f 2))
  (cond
    [(and known (assv slot known)) => cdr]
    [else
     (define token (gensym 'expression))
     (vector-set! f 2 (cons (cons slot token) (or known '())))
     token]))
(struct debug-stop (site kind results marks origin slot owner live action [frames #:mutable] [contexts #:mutable]))
(define frame-key (make-continuation-mark-key 'racket-debug-frame))
;; Marks a host's boundary around attached code, which contexts report too.
(define context-key (make-continuation-mark-key 'racket-debug-expression))
(define debugger-active-key (make-continuation-mark-key 'racket-debugger-active))
(define debugging-enabled? (make-parameter #t))
;; A helper instance imported at transformer phase must not invoke callbacks.
(define runtime-phase-zero?
  (zero? (variable-reference->module-base-phase (#%variable-reference))))
;; Generated code holds no debugger state: it names its form by a unit symbol and
;; an index, and reads its descriptors and the callback from this table when the
;; form is instantiated. Slot 0 is the callback; the descriptors follow. An
;; instance with no registration delivers nothing, which is what an instance
;; above phase zero needs. A key's symbol lives as long as code that quotes it.
;;
;; A site does nothing but note itself in its frame unless the gate box holds a true
;; value or the site's armed flag is set. The gate belongs to the loader: whoever
;; owns it opens it while a step, Pause or entry stop is pending. A flag is set while
;; a breakpoint or run-to target is at the site. An unopened gate and unset flag cost
;; two reads and a branch.
(struct registered (gate armed descriptors callback on-thread))
(define form-tables (make-ephemeron-hasheq))
(define (register-form-sites! unit index callback descriptors
                              #:gate [gate (box #t)] #:on-thread [on-thread #f] #:armed? [armed? #f])
  (define armed (make-vector (add1 (length descriptors)) armed?))
  (vector-set! armed 0 #f)
  (for ([descriptor (in-list descriptors)] [slot (in-naturals 1)])
    (set-site-armed! descriptor (cons armed slot)))
  (hash-set! (hash-ref! form-tables unit make-hasheqv) index
             (registered gate armed (list->vector (cons #f descriptors)) callback on-thread)))
;; One instance of a form. module-bindings, context and namespace are what stops need
;; from the program; they can differ between instances of one registration.
(struct form (gate armed descriptors callback on-thread module-bindings context namespace))
(define (form-sites unit index size module-bindings context namespace)
  (define forms (and runtime-phase-zero? (hash-ref form-tables unit #f)))
  (define entry (and forms (hash-ref forms index #f)))
  (if entry
      (form (registered-gate entry) (registered-armed entry) (registered-descriptors entry)
            (registered-callback entry) (registered-on-thread entry)
            module-bindings context namespace)
      (form (box #f) (make-vector (add1 size) #f) (make-vector (add1 size) #f) #f #f
            module-bindings context namespace)))
;; Who has been told about the running thread. Starting a call compares threads,
;; and a thread running instrumented code for the first time is reported, which
;; sites are too quiet to do. Its parameters are kept for inspecting it from
;; outside: see call-with-thread-stop.
(define noted-thread (make-weak-box #f))
(define thread-parameterizations (make-ephemeron-hasheq))
(define (note-thread f)
  (unless (eq? (current-thread) (weak-box-value noted-thread))
    (note-new-thread f)))
(define (note-new-thread f)
  (define thread (current-thread))
  (set! noted-thread (make-weak-box thread))
  (hash-ref! thread-parameterizations thread current-parameterization)
  (define on-thread (form-on-thread f))
  (when (and on-thread (debugging-enabled?)) (on-thread)))
(define (forget-noted-thread!) (set! noted-thread (make-weak-box #f)))
;; Module contexts are keyed by symbols. Each namespace registry gets the live
;; namespace of the owning module instance, registered before its source forms,
;; and each context records the identifiers it owns and the context it inherits.
;; Namespaces retain their registry and the symbols their code quotes.
;; Both associations need ephemerons so those backreferences do not root a
;; completed target, while a live target keeps all of its registrations usable.
(define module-context-instances (make-ephemeron-hasheq))
(define module-context-owned (make-ephemeron-hasheq))
(define (owned-module-bindings context)
  (define owned (hash-ref module-context-owned context #f))
  (if owned
      (append (for/list ([id (in-list ((car owned)))]) (cons context id))
              (if (cdr owned) (owned-module-bindings (cdr owned)) '()))
      '()))
;; ancestors lists the inherited contexts as (key . identifiers), nearest first.
(define (register-module-context! context reference identifiers [ancestors '()])
  (when (zero? (variable-reference->module-base-phase reference))
    (let loop ([key context] [thunk identifiers] [rest ancestors])
      (hash-set! module-context-owned key (cons thunk (and (pair? rest) (caar rest))))
      (when (pair? rest) (loop (caar rest) (cdar rest) (cdr rest))))
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
    (let loop ([owners (map car ancestors)]
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

(define make-live-binding live-binding)

;; A frame between its sites has nothing to show, as if its call had not begun.
(define (inspectable-frames marks)
  (for/list ([f (in-list (continuation-mark-set->list marks frame-key))]
             #:unless (zero? (frame-slot f)))
    f))
(define (stop-frames s)
  (or (debug-stop-frames s)
      (let ([frames (inspectable-frames (debug-stop-marks s))])
        (set-debug-stop-frames! s frames)
        frames)))
(define (check-stop s [who 'debug-stop])
  (unless (debug-stop? s) (raise-argument-error who "debug-stop?" s))
  (unless (eq? (debug-stop-owner s) (current-thread))
    (error who "stop belongs to a different thread"))
  (unless (unbox (debug-stop-live s)) (error who "stop has expired")))
(define (selected-frame s i who)
  (check-stop s who)
  (unless (and (exact-nonnegative-integer? i) (< i (length (stop-frames s))))
    (raise-arguments-error who "invalid frame index" "index" i))
  (list-ref (stop-frames s) i))
(define (stop-site s) (check-stop s 'stop-site) (debug-stop-site s))
(define (stop-kind s) (check-stop s 'stop-kind) (debug-stop-kind s))
(define (stop-approximate? s) (check-stop s 'stop-approximate?) (eq? (debug-stop-kind s) 'pause))
(define (stop-frame-count s) (check-stop s 'stop-frame-count) (length (stop-frames s)))
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
(define (stop-token s)
  (check-stop s 'stop-token)
  (and (debug-stop-origin s) (not (site-tail? (debug-stop-site s)))
       (frame-token (debug-stop-origin s) (debug-stop-slot s))))
;; The evaluations in progress in one frame from a site outward. A tail site has no
;; completion to wait for, so it has no identity here.
(define (frame-contexts f slot)
  (let loop ([slot slot])
    (cond
      [(zero? slot) '()]
      [else
       (define descriptor (vector-ref (form-descriptors (frame-form f)) slot))
       (if (site-tail? descriptor)
           (loop (site-parent descriptor))
           (cons (frame-token f slot) (loop (site-parent descriptor))))])))
;; Each entry is one activation's evaluations, then a boundary token if any.
(define (context-entries s)
  (define origin (debug-stop-origin s))
  (for/list ([entry (in-list (continuation-mark-set->list* (debug-stop-marks s)
                                                           (list frame-key context-key)))])
    (define f (vector-ref entry 0))
    (define boundary (vector-ref entry 1))
    (cons f
          (append (cond
                    [(not f) '()]
                    ;; A stop is reported apart from what encloses it.
                    [(eq? f origin) (frame-contexts f (site-parent (debug-stop-site s)))]
                    [else (frame-contexts f (frame-slot f))])
                  (if boundary (list boundary) '())))))
(define (stop-contexts s)
  (check-stop s 'stop-contexts)
  (or (debug-stop-contexts s)
      (let ([contexts (append-map cdr (context-entries s))])
        (set-debug-stop-contexts! s contexts)
        contexts)))
;; What the innermost activation returns to: the first evaluation outside it.
(define (stop-return-token s)
  (check-stop s 'stop-return-token)
  (define frames (stop-frames s))
  (and (pair? frames)
       (let loop ([entries (context-entries s)])
         (cond
           [(null? entries) #f]
           [(eq? (caar entries) (car frames))
            (define outside (append-map cdr (cdr entries)))
            (and (pair? outside) (car outside))]
           [else (loop (cdr entries))]))))

(define (visible-bindings f)
  (define seen (make-hasheq))
  (for/list ([b (in-list (frame-bindings f))]
             #:unless (hash-ref seen (live-binding-name b) #f))
    (hash-set! seen (live-binding-name b) #t)
    b))
(define (read-binding b)
  (with-handlers ([exn:fail:contract:variable?
                   (lambda (e) (unavailable 'uninitialized))])
    ((live-binding-access b))))
(define (stop-locals s [i 0])
  (for/list ([b (in-list (visible-bindings (selected-frame s i 'stop-locals)))])
    (cons (live-binding-name b) (read-binding b))))

(define (frame-module-entries f)
  (define context (form-context (frame-form f)))
  (append (if context (owned-module-bindings context) '())
          (map (lambda (id) (cons #f id)) ((form-module-bindings (frame-form f))))))
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
   (let* ([namespace ((form-namespace (frame-form f)))]
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
     ((live-binding-access binding) (evaluate-in-frame f datum))]
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
     (define access #`(quote #,(live-binding-access b)))
     (syntax-case use (set!)
       [id (identifier? #'id) #`(#,access)]
       [(set! id rhs) #`(#,access rhs)]
       [(id . arguments) #`((#,access) . arguments)]))))
(define (evaluate-in-frame f datum)
  (define names (visible-bindings f))
  (define namespace ((form-namespace (frame-form f))))
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
;; A stop's frames and contexts are read from its marks when asked: a callback that
;; lets the program go on pays nothing for the depth of the stack.
(define (deliver callback descriptor kind results marks origin slot)
  (define action (box #f))
  (define s (debug-stop descriptor kind results marks origin slot
                        (current-thread) (box #t) action #f #f))
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
  (unbox action))
(define (deliver-site f slot kind results)
  (define callback (form-callback (frame-form f)))
  (and callback (debugging-enabled?)
       (deliver callback (vector-ref (form-descriptors (frame-form f)) slot) kind results
                (current-continuation-marks) f slot)))
(define (announce-before f slot)
  (deliver-site f slot 'before #f))
(define (announce-after f slot results)
  (vector-set! f 1 slot)
  (define replacement (deliver-site f slot 'after results))
  (vector-set! f 1 (site-parent (vector-ref (form-descriptors (frame-form f)) slot)))
  (apply values (or replacement results)))
;; A site completing with other than one value, which generated code does not inline.
(define (leave-with-values f slot results)
  (define armed (form-armed (frame-form f)))
  (if (or (unbox (form-gate (frame-form f))) (vector-ref armed slot))
      (announce-after f slot results)
      (begin
        (vector-set! f 1 (site-parent (vector-ref (form-descriptors (frame-form f)) slot)))
        (apply values results))))
;; Coverage records only that a site began, so a site clears its flag at its first
;; visit. It needs no frames, results or stop: the callback receives the site itself.
(define (announce-visit f slot)
  (define on-visit (form-callback f))
  (when (and on-visit (debugging-enabled?))
    (vector-set! (form-armed f) slot #f)
    (on-visit (vector-ref (form-descriptors f) slot))))
(define (call-with-exception-stop raised callback)
  (when (and callback (not (exn:break? raised)) (debugging-enabled?))
    (define exception-marks (and (exn? raised) (exn-continuation-marks raised)))
    (define marks
      (and exception-marks (pair? (inspectable-frames exception-marks)) exception-marks))
    (define frames (inspectable-frames (or marks (current-continuation-marks))))
    (when (pair? frames)
      (deliver callback (frame-site (car frames)) 'exception (list raised)
               (or marks (current-continuation-marks)) #f #f)))
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
       (and (debugging-enabled?)
            (deliver callback (frame-site (car frames)) 'pause #f marks #f #f)))))
  interruption)

;; The parameters a suspended thread sees. Marks stop at its nearest prompt, so those
;; set beyond that come from when the thread first ran instrumented code.
(define (target-parameterization target marks)
  (define inner (continuation-mark-set->list marks parameterization-key))
  (cond
    [(pair? inner) (car inner)]
    [else (hash-ref thread-parameterizations target current-parameterization)]))

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
          (target-parameterization target marks)
          (lambda ()
            (when (debugging-enabled?)
              (deliver callback (and (pair? frames) (frame-site (car frames)))
                       'pause #f marks #f #f))))
         #t]))
    (lambda () (when resume? (thread-resume target)))))
