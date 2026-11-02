#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list racket/path syntax/id-table "runtime.rkt"
         (only-in '#%unsafe unsafe-unbox* unsafe-vector*-ref unsafe-vector*-set!)
         (only-in '#%kernel [apply kernel-apply]))
(provide instrument-module
         make-module-binding-context record-module-bindings!
         module-binding-context-identifiers module-binding-context-child! module-binding-context-key
         (all-from-out "runtime.rkt"))

(define quoted-forms (syntax->list #'(quote quote-syntax)))
(define atomic-forms
  (syntax->list #'(quote quote-syntax #%datum #%top #%variable-reference
                        #%plain-lambda case-lambda)))
(define binding-forms (syntax->list #'(let-values letrec-values)))
(define (bound-form? identifier forms)
  (and (identifier? identifier)
       (for/or ([form (in-list forms)]) (free-identifier=? identifier form))))

;; A live binding pairs a source name with its runtime identifier. Generated
;; bindings never compete with these names merely because they print alike.
;; Syntax identifiers retain the expander's binding scopes.
(define (source-name source)
  (cond [(path? source) (path->string (simplify-path source #f))]
        [(string? source) (path->string (simplify-path (string->path source) #f))]
        [else source]))
(define (original-syntax? stx)
  (or (syntax-original? stx)
      (and (syntax-transforming?)
           (syntax-original? (syntax-local-introduce stx)))))
(define (original-binding? identifier source)
  (and (identifier? identifier)
       (original-syntax? identifier)
       (equal? (source-name (syntax-source identifier)) (source-name source))))
;; Metadata is shared across one module expansion, including module+ fragments.
;; A module's declarations are all recorded in its first expansion pass, and its
;; runtime expressions wait for the second, so the identifiers are complete when
;; the module's first form is instrumented. Children expand after their parents.
;; That first form hands them to the runtime as syntax literals under the key.
(struct module-binding-context (key [own-identifiers #:mutable] parent children [registered? #:mutable])
  #:constructor-name new-module-binding-context)
(define (make-module-binding-context [parent #f] [key (fresh-context-key)])
  (new-module-binding-context key '() parent (make-hasheq) #f))
(define (fresh-context-key)
  (string->symbol (symbol->string (gensym 'module-context))))
(define (module-binding-context-child! parent name [inherit? #t])
  (hash-ref! (module-binding-context-children parent) name
             (lambda ()
               (make-module-binding-context
                (and inherit? parent)
                (string->symbol (format "~a/~a" (module-binding-context-key parent) name))))))
(define (module-binding-context-ancestors context)
  (if (module-binding-context-parent context)
      (cons (module-binding-context-parent context)
            (module-binding-context-ancestors (module-binding-context-parent context)))
      '()))
(define (module-binding-context-identifiers context)
  (append-map module-binding-context-own-identifiers
              (cons context (module-binding-context-ancestors context))))
(define (record-module-bindings! context declaration source)
  (syntax-case* declaration (define-values define-syntaxes begin)
                free-identifier=?
    [(define-values (id ...) rhs)
     (set-module-binding-context-own-identifiers!
      context
      (append (filter (lambda (id) (original-binding? id source))
                      (syntax->list #'(id ...)))
              (module-binding-context-own-identifiers context)))]
    [(define-syntaxes (id ...) rhs)
     (set-module-binding-context-own-identifiers!
      context
      (append (filter (lambda (id) (original-binding? id source))
                      (syntax->list #'(id ...)))
              (module-binding-context-own-identifiers context)))]
    [(begin form ...)
     (for ([form (in-list (syntax->list #'(form ...)))])
       (record-module-bindings! context form source))]
    [_ (void)]))
(define (formal-identifiers stx)
  (let walk ([v stx])
    (cond [(identifier? v) (list v)]
          [(syntax? v) (walk (syntax-e v))]
          [(pair? v) (append (walk (car v)) (walk (cdr v)))]
          [else '()])))

;; An operator bound to a primitive that does not make ports. Fully expanded code
;; names primitives through modules whose names begin #%.
(define (primitive-operator? operator)
  (and (identifier? operator)
       (let ([binding (identifier-binding operator)])
         (and (list? binding)
              (let ([module-name (resolved-module-path-name (module-path-index-resolve (car binding)))])
                (and (symbol? module-name)
                     (regexp-match? #rx"^#%" (symbol->string module-name))
                     (not (port-constructor-name? (cadr binding)))))))))

(struct boundary (range authored? [visible? #:mutable]))
;; A call or module-level form being generated: the variable that will hold its frame,
;; how many slots the frame needs, and whether any site uses it.
(struct activation (frame [slots #:mutable] [used? #:mutable]))
(struct scope (variable slot parent bindings [reached? #:mutable] [sited? #:mutable]))

;; Returns the rewritten expression, the visible site descriptors, and every
;; descriptor in slot order paired with whether it is visible. form names the
;; form's entry in the runtime's table as (unit . index).
(define (instrument-module expanded source fresh-id
                           #:form [form (cons (fresh-context-key) 0)]
                           #:module-bindings [known-module-bindings '()]
                           #:module-context [module-context #f]
                           #:expression-boundary? [expression-boundary? #f]
                           #:coverage? [coverage? #f]
                           #:tail? [initial-tail? #f])
  (define descriptors '())
  (define table '())
  ;; Retain source-facing aliases for module bindings that expansion may rename.
  ;; Lexical evaluation alone cannot reconstruct these names from namespace maps.
  (define module-bindings known-module-bindings)
  (define seen-module-bindings (make-free-id-table))
  ;; Macros such as unit replace source bindings with fresh runtime identifiers.
  ;; The expander retains their aliases in disappeared-binding metadata. Match
  ;; their binding identities, never their printed names or source positions.
  (define lexical-aliases (make-free-id-table))
  (define (collect-aliases value)
    (cond
      [(identifier? value)
       (when (and (original-binding? value source)
                  (eq? (identifier-binding value) 'lexical))
         (free-id-table-set! lexical-aliases value (syntax-e value)))]
      [(pair? value) (collect-aliases (car value)) (collect-aliases (cdr value))]))
  (define (collect-bindings stx)
    (cond
      [(identifier? stx)
       ;; One entry per binding and name, however many times the form uses it.
       (when (and (original-binding? stx source) (list? (identifier-binding stx))
                  (not (memq (syntax-e stx) (free-id-table-ref seen-module-bindings stx '()))))
         (free-id-table-update! seen-module-bindings stx (lambda (names) (cons (syntax-e stx) names)) '())
         (set! module-bindings (cons stx module-bindings)))]
      [(syntax? stx)
       (define parts (syntax->list stx))
       (unless (and (pair? parts) (identifier? (car parts))
                    (bound-form? (car parts) quoted-forms))
         (collect-aliases (syntax-property stx 'disappeared-binding))
         (collect-bindings (syntax-e stx)))]
      [(pair? stx)
       (collect-bindings (car stx))
       (collect-bindings (cdr stx))]
      [else (void)]))
  (collect-bindings expanded)
  (define form-id (car (generate-temporaries '(form))))
  (define gate-id (car (generate-temporaries '(gate))))
  (define armed-id (car (generate-temporaries '(armed))))
  ;; A scope is the variable holding a procedure that returns the live bindings
  ;; visible in it, innermost first, and the frame slot it stores that procedure in.
  ;; Nothing is built for a scope no site or closure of a site can reach.
  (define (new-scope ids parent slot)
    (define live-bindings
      (if coverage?
          '()
          (for/list ([id (in-list ids)]
                     #:do [(define name (if (original-binding? id source)
                                            (syntax-e id)
                                            (free-id-table-ref lexical-aliases id #f)))]
                     #:when name)
            #`(#%plain-app make-live-binding '#,name
                           (case-lambda [() #,id] [(replacement) (set! #,id replacement)])))))
    (if (null? live-bindings)
        parent
        (scope (car (generate-temporaries '(variables))) slot parent live-bindings #f #f)))
  (define (scope-procedure this)
    (when (scope-parent this) (set-scope-reached?! (scope-parent this) #t))
    #`(#%plain-lambda ()
        (#%plain-app list* #,@(scope-bindings this)
                     #,(if (scope-parent this)
                           #`(#%plain-app #,(scope-variable (scope-parent this)))
                           #''()))))
  (define (store-scope this act)
    #`(#%plain-app unsafe-vector*-set! #,(activation-frame act) '#,(scope-slot this) #,(scope-variable this)))
  (define (fresh-scope-slot! act)
    (begin0 (activation-slots act)
      (set-activation-slots! act (add1 (activation-slots act)))))
  ;; Whether this binding form introduced the scope, rather than inheriting it.
  (define (own-scope? this parent) (and this (not (eq? this parent))))
  ;; Bind a scope's procedure around its body, which keeps its tail positions.
  (define (in-scope this parent act expressions)
    (if (and (own-scope? this parent) (scope-reached? this))
        (list #`(let-values ([(#,(scope-variable this)) #,(scope-procedure this)])
                  #,@(if (scope-sited? this) (list (store-scope this act)) '())
                  #,@expressions))
        expressions))
  (define (stoppable? expression)
    (and (not (identifier? expression))
         (let ([parts (syntax->list expression)])
           (and (pair? parts)
                (not (bound-form? (car parts) atomic-forms))))))
  (define (binding-container? expression)
    ;; Internal definitions inherit their body's range without an operator
    ;; source or expansion origin. Keep their frames for exceptions and Pause,
    ;; but their initializers and body own the executable stepping stops.
    (define parts (syntax->list expression))
    (and (pair? parts)
         (bound-form? (car parts) binding-forms)
         (not (syntax-source (car parts)))
         (not (syntax-property expression 'origin))))
  (define (in-source? stx)
    (and (syntax-position stx) (syntax-span stx)
         (equal? (source-name source) (source-name (syntax-source stx)))))
  ;; The syntax whose location an expression reports. A macro use written here
  ;; can expand to code located in the macro's own file or nowhere. The top of
  ;; that expansion reports the use instead, through the macro name that the
  ;; expander records in its origin.
  (define (location-of expression)
    (if (in-source? expression)
        expression
        (let walk ([origin (syntax-property expression 'origin)])
          (cond [(identifier? origin) (and (original-binding? origin source) (in-source? origin) origin)]
                [(pair? origin) (or (walk (car origin)) (walk (cdr origin)))]
                [else #f]))))
  (define enclosing-site (make-parameter 0))
  (define next-slot 0)
  ;; Source syntax or its expansion origin owns a range ahead of a generated
  ;; wrapper that borrowed it. A child can relinquish the wrapper's boundary
  ;; before its descriptor is emitted; sibling source executions stay distinct.
  (define enclosing-boundary (make-parameter #f))
  (define (authored? expression range)
    (and range
         (or (original-syntax? expression)
             (let walk ([origin (syntax-property expression 'origin)])
               (cond
                 [(identifier? origin)
                  (and (original-binding? origin source) (syntax-position origin)
                       (<= (car range) (syntax-position origin))
                       (< (syntax-position origin) (+ (car range) (cdr range))))]
                 [(pair? origin) (or (walk (car origin)) (walk (cdr origin)))]
                 [else #f])))))
  (define (body expressions environment act tail? [inferred-name #f])
    (for/list ([e (in-list expressions)] [i (in-naturals)])
      (define last? (= i (sub1 (length expressions))))
      (walk e environment act (and tail? last?) (and last? inferred-name))))
  ;; A frame is made only for a call that has a site to note in it. It holds the form,
  ;; the running site, the tokens made so far, and one slot per scope; the first scope
  ;; slot holds what the call started with.
  (define (frame-around act entry-scope expressions)
    (if (activation-used? act)
        (list #`(let-values ([(#,(activation-frame act))
                              (#%plain-app vector #,form-id '0 '#f
                                           #,(if (and entry-scope (scope-sited? entry-scope))
                                                 (scope-variable entry-scope)
                                                 #''#f)
                                           #,@(for/list ([_ (in-range (- (activation-slots act) first-scope-slot 1))])
                                                #''#f))])
                  (#%plain-app note-thread #,form-id)
                  (with-continuation-mark frame-key #,(activation-frame act)
                    (begin #,@expressions))))
        expressions))
  (define (lambda-clause formals expressions environment)
    (define act (activation (car (generate-temporaries '(frame))) (add1 first-scope-slot) #f))
    (define own (new-scope (formal-identifiers formals) environment first-scope-slot))
    ;; A call with no variables of its own starts with those it closes over.
    (define entry
      (if (eq? own environment)
          (and environment
               (scope (scope-variable environment) first-scope-slot environment #f #f #f))
          own))
    (define rewritten
      (parameterize ([enclosing-boundary #f] [enclosing-site 0])
        (body expressions entry act #t)))
    (when (and entry (eq? own environment) (scope-reached? entry))
      (set-scope-reached?! environment #t))
    #`[#,formals #,@(in-scope-binding-only own environment (frame-around act entry rewritten))])
  ;; A call's own scope is stored by the frame that starts with it.
  (define (in-scope-binding-only this parent expressions)
    (if (and (own-scope? this parent) (scope-reached? this))
        (list #`(let-values ([(#,(scope-variable this)) #,(scope-procedure this)])
                  #,@expressions))
        expressions))
  (define (application expressions environment act)
    (define rewritten (body expressions environment act #f))
    ;; A primitive other than a port constructor needs no check, and the compiler
    ;; keeps it inline. Any other operator might turn out to be a constructor.
    (if (primitive-operator? (car expressions))
        #`(#%plain-app #,@rewritten)
        #`(#%plain-app (#%plain-app checked-operator #,(car rewritten)) #,@(cdr rewritten))))
  (define (walk expression environment act tail? [context-name #f])
    (define located (location-of expression))
    (define range (and located (cons (syntax-position located) (syntax-span located))))
    (define parent (enclosing-boundary))
    (define current (boundary range (authored? expression range)
                              (not (binding-container? expression))))
    (when (and (boundary-visible? current) range parent
               (equal? range (boundary-range parent)))
      (if (and (stoppable? expression) (boundary-authored? current)
               (not (boundary-authored? parent)))
          (set-boundary-visible?! parent #f)
          (set-boundary-visible?! current #f)))
    (define inferred-name (or (syntax-property expression 'inferred-name) context-name))
    (define slot
      (and located
           (or coverage? (stoppable? expression)
               ;; A complete module expression is executable even when it is
               ;; only a constant or reference. Keep atomic operands inside
               ;; other expressions out of the ordinary stepping sequence.
               (and expression-boundary? (eq? expression expanded)))
           (begin (set! next-slot (add1 next-slot)) next-slot)))
    (define enclosing (enclosing-site))
    (define (remember-lambda rewritten)
      ;; Preserve source/properties, notably method-arity-error and inferred-name.
      ;; The registration call must not replace the compiler's contextual name
      ;; with a temporary binding or the instrumentation source location.
      (define original (datum->syntax expression (syntax-e rewritten) expression expression))
      (define named (if inferred-name (syntax-property original 'inferred-name inferred-name) original))
      #`(#%plain-app remember-procedure #,named))
    (define (rewrite)
      (syntax-case* expression (quote quote-syntax #%datum #%top #%variable-reference
                                    #%plain-lambda case-lambda if begin begin0
                                    let-values letrec-values set! with-continuation-mark
                                    #%plain-app #%expression)
                    free-identifier=?
        [id (identifier? #'id) expression]
        [(quote . ignored) expression]
        [(quote-syntax . ignored) expression]
        [(#%datum . ignored) expression]
        [(#%top . ignored) expression]
        [(#%variable-reference . ignored) expression]
        [(#%plain-lambda formals expression ...)
         (with-syntax ([(new-formals new-body ...) (lambda-clause #'formals (syntax->list #'(expression ...)) environment)])
           (remember-lambda #'(#%plain-lambda new-formals new-body ...)))]
        [(case-lambda [formals expression ...] ...)
         (with-syntax ([(clause ...)
                        (for/list ([f (in-list (syntax->list #'(formals ...)))]
                                   [es (in-list (syntax->list #'((expression ...) ...)))])
                          (lambda-clause f (syntax->list es) environment))])
           (remember-lambda #'(case-lambda clause ...)))]
        [(if test consequent alternative)
         #`(if #,(walk #'test environment act #f)
               #,(walk #'consequent environment act tail? inferred-name)
               #,(walk #'alternative environment act tail? inferred-name))]
        [(begin expression ...)
         #`(begin #,@(body (syntax->list #'(expression ...)) environment act tail? inferred-name))]
        [(begin0 expression)
         #`(begin0 #,(walk #'expression environment act tail? inferred-name))]
        [(begin0 expression rest ...)
         #`(begin0 #,(walk #'expression environment act #f inferred-name)
                   #,@(body (syntax->list #'(rest ...)) environment act #f))]
        [(let-values ([(id ...) rhs] ...) expression ...)
         (let* ([groups (syntax->list #'((id ...) ...))]
                [this (new-scope (apply append (map syntax->list groups)) environment
                                 (if coverage? first-scope-slot (fresh-scope-slot! act)))]
                [rhss (for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs environment act #f
                                         (and (= (length (syntax->list ids)) 1)
                                              (syntax-e (car (syntax->list ids)))))])]
                [bodies (body (syntax->list #'(expression ...)) this act tail? inferred-name)])
           #`(let-values #,rhss #,@(in-scope this environment act bodies)))]
        [(letrec-values ([(id ...) rhs] ...) expression ...)
         (let* ([groups (syntax->list #'((id ...) ...))]
                [this (new-scope (apply append (map syntax->list groups)) environment
                                 (if coverage? first-scope-slot (fresh-scope-slot! act)))]
                [rhss (for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs this act #f
                                         (and (= (length (syntax->list ids)) 1)
                                              (syntax-e (car (syntax->list ids)))))])]
                [bodies (body (syntax->list #'(expression ...)) this act tail? inferred-name)]
                [scope-clauses
                 (if (and (own-scope? this environment) (scope-reached? this))
                     (cons #`[(#,(scope-variable this)) #,(scope-procedure this)]
                           (if (scope-sited? this)
                               (list #`[(#,(car (generate-temporaries '(stored)))) #,(store-scope this act)])
                               '()))
                     '())])
           ;; The scope's procedure comes first: its getters may run in any initializer.
           #`(letrec-values (#,@scope-clauses #,@rhss) #,@bodies))]
        [(set! id rhs) #`(set! id #,(walk #'rhs environment act #f (syntax-e #'id)))]
        [(with-continuation-mark key value result)
         #`(with-continuation-mark #,(walk #'key environment act #f)
                                   #,(walk #'value environment act #f)
             ;; The body shares the marked continuation even when this entire
             ;; form has a pending completion. A body completion wrapper would
             ;; keep same-key marks that the program normally replaces.
             #,(walk #'result environment act #t inferred-name))]
        [(#%plain-app expression ...)
         (application (syntax->list #'(expression ...)) environment act)]
        [(#%expression expression)
         #`(#%expression #,(walk #'expression environment act tail? inferred-name))]
        [_ (raise-syntax-error 'instrument-module "unsupported expanded runtime form" expression)]))
    (define rewritten
      (parameterize ([enclosing-boundary
                      (if (and (boundary-visible? current) range (stoppable? expression))
                          current parent)]
                     [enclosing-site (or slot enclosing)])
        (rewrite)))
    (define visible? (boundary-visible? current))
    (cond
      [(not slot) rewritten]
      [else
       (define descriptor
         (site (fresh-id) (syntax-source located)
               (syntax-line located) (syntax-column located)
               (syntax-position located) (syntax-span located)
               tail? (syntax->datum expression) enclosing
               (if environment (scope-slot environment) first-scope-slot)))
       (when visible? (set! descriptors (cons descriptor descriptors)))
       (set! table (cons (cons slot (cons descriptor visible?)) table))
       (unless coverage?
         (set-activation-used?! act #t)
         (when environment
           (set-scope-reached?! environment #t)
           (set-scope-sited?! environment #t)))
       (emit-site slot rewritten tail? visible? enclosing act)]))
  ;; A site notes itself in its frame, and returns the frame to what encloses it when
  ;; it completes, as a mark would disappear. It enters the debugger only when the
  ;; gate is open or the site is armed; those reads are all it costs otherwise.
  (define (emit-site slot rewritten tail? visible? enclosing act)
    (define (attention?)
      #`(if (#%plain-app unsafe-unbox* #,gate-id) '#t (#%plain-app unsafe-vector*-ref #,armed-id '#,slot)))
    (cond
      [coverage?
       (if visible?
           #`(begin
               (if (#%plain-app unsafe-vector*-ref #,armed-id '#,slot)
                   (#%plain-app announce-visit #,form-id '#,slot)
                   '#f)
               #,rewritten)
           rewritten)]
      [else
       (define f (activation-frame act))
       (define enter #`(#%plain-app unsafe-vector*-set! #,f '1 '#,slot))
       (define leave #`(#%plain-app unsafe-vector*-set! #,f '1 '#,enclosing))
       (define decision (car (generate-temporaries '(decision))))
       (define start
         #`(if #,(attention?) (#%plain-app announce-before #,f '#,slot) '#f))
       (define single (car (generate-temporaries '(value))))
       (define results (car (generate-temporaries '(results))))
       (cond
         [(and tail? visible?)
          #`(begin #,enter
                   (let-values ([(#,decision) #,start])
                     (if #,decision (#%plain-app kernel-apply values #,decision) #,rewritten)))]
         [tail? #`(begin #,enter #,rewritten)]
         [visible?
          #`(begin
              #,enter
              (let-values ([(#,decision) #,start])
                (#%plain-app
                 call-with-values
                 (#%plain-lambda ()
                   (if #,decision (#%plain-app kernel-apply values #,decision) #,rewritten))
                 (case-lambda
                   [(#,single)
                    (if #,(attention?)
                        (#%plain-app announce-after #,f '#,slot (#%plain-app list #,single))
                        (begin #,leave #,single))]
                   [#,results (#%plain-app leave-with-values #,f '#,slot #,results)]))))]
         [else
          #`(begin
              #,enter
              (#%plain-app
               call-with-values
               (#%plain-lambda () #,rewritten)
               (case-lambda
                 [(#,single) (begin #,leave #,single)]
                 [#,results (begin #,leave (#%plain-app kernel-apply values #,results))])))])]))
  (define local-name (and (syntax-transforming?) (syntax-local-name)))
  (define form-activation (activation (car (generate-temporaries '(frame))) (add1 first-scope-slot) #f))
  (define result (walk expanded #f form-activation initial-tail?
                       (if (identifier? local-name) (syntax-e local-name) local-name)))
  (define (identifiers-thunk identifiers)
    #`(#%plain-lambda () (#%plain-app list #,@(for/list ([id (in-list identifiers)]) #`(quote-syntax #,id)))))
  ;; One registration per module: repeating the identifiers in each of its forms
  ;; would grow with forms times declarations.
  (define register-context
    (if (and module-context (not (module-binding-context-registered? module-context)))
        (begin
          (set-module-binding-context-registered?! module-context #t)
          (list #`(#%plain-app register-module-context!
                   '#,(module-binding-context-key module-context)
                   #,(datum->syntax expanded (list #'#%variable-reference) expanded)
                   #,(identifiers-thunk (module-binding-context-own-identifiers module-context))
                   (#%plain-app list #,@(for/list ([ancestor (in-list (module-binding-context-ancestors module-context))])
                              #`(#%plain-app cons '#,(module-binding-context-key ancestor)
                                      #,(identifiers-thunk (module-binding-context-own-identifiers ancestor))))))))
        '()))
  (define framed (car (frame-around form-activation #f (list result))))
  (values (if (and (zero? next-slot) (null? register-context))
              result
              #`(let-values ([(#,form-id)
                              (#%plain-app form-sites '#,(car form) '#,(cdr form) '#,next-slot
                                           #,(identifiers-thunk module-bindings)
                                           '#,(and module-context (module-binding-context-key module-context))
                                           (#%plain-lambda ()
                                             (#%plain-app variable-reference->namespace
                                                          #,(datum->syntax expanded (list #'#%variable-reference) expanded))))])
                  (let-values ([(#,gate-id) (#%plain-app form-gate #,form-id)]
                               [(#,armed-id) (#%plain-app form-armed #,form-id)])
                    #,@register-context
                    #,framed)))
          (reverse descriptors)
          (for/list ([entry (in-list (sort table < #:key car))]) (cdr entry))))
