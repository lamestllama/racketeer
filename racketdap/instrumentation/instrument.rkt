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
;; That first form hands their names to the runtime under the key.
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
;; The variable holding the object in a class's methods and initialisers, whichever way
;; the source reaches it. The class form names it with a gensym in its own lexical
;; context, so no program's identifier can be taken for it.
(define (class-object? identifier)
  (and (identifier? identifier)
       (regexp-match? #rx"^self[0-9]+$" (symbol->string (syntax-e identifier)))
       (let ([module-source (syntax-source-module identifier #t)])
         (and (path? module-source)
              (let-values ([(base name directory?) (split-path module-source)])
                (equal? name (string->path "class-internal.rkt")))))))
(define (syntax-e* v) (and (syntax? v) (syntax-e v)))
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

;; The expressions a core form evaluates, in no particular order.
(define (runtime-subexpressions expression)
  (syntax-case* expression (quote quote-syntax #%plain-lambda case-lambda if begin begin0
                            let-values letrec-values set! with-continuation-mark
                            #%plain-app #%expression)
                free-identifier=?
    [(quote . _) '()]
    [(quote-syntax . _) '()]
    [(#%plain-lambda formals body ...) (syntax->list #'(body ...))]
    [(case-lambda [formals body ...] ...) (append-map syntax->list (syntax->list #'((body ...) ...)))]
    [(if test consequent alternative) (list #'test #'consequent #'alternative)]
    [(begin e ...) (syntax->list #'(e ...))]
    [(begin0 e ...) (syntax->list #'(e ...))]
    [(let-values ([ids rhs] ...) body ...) (syntax->list #'(rhs ... body ...))]
    [(letrec-values ([ids rhs] ...) body ...) (syntax->list #'(rhs ... body ...))]
    [(set! id rhs) (list #'rhs)]
    [(with-continuation-mark key value result) (list #'key #'value #'result)]
    [(#%plain-app e ...) (syntax->list #'(e ...))]
    [(#%expression e) (list #'e)]
    [_ '()]))
;; The subexpressions whose values are a core form's value.
(define (result-subexpressions expression)
  (syntax-case* expression (if begin begin0 let-values letrec-values with-continuation-mark #%expression)
                free-identifier=?
    [(if test consequent alternative) (list #'consequent #'alternative)]
    [(begin e ... last) (list #'last)]
    [(begin0 first . rest) (list #'first)]
    [(let-values bindings body ... last) (list #'last)]
    [(letrec-values bindings body ... last) (list #'last)]
    [(with-continuation-mark key value result) (list #'result)]
    [(#%expression e) (list #'e)]
    [_ '()]))
;; A call or module-level form being generated: the variable that will hold its frame,
;; and whether any site uses it.
(struct activation (frame [used? #:mutable]))
(struct scope (variable parent bindings [reached? #:mutable] [sited? #:mutable]))

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
  ;; The expander retains their aliases in disappeared-binding metadata. A binding
  ;; a macro generated has a source name too when an identifier in the file refers
  ;; to it, wherever in its scope that reference is. Match their binding identities,
  ;; never their printed names or source positions.
  (define lexical-aliases (make-free-id-table))
  ;; A field is no variable: the class form writes each read or assignment of one as a call
  ;; on the object, and declares its accessor and mutator together once. Only a name the
  ;; file wrote counts. One class has one field of a name the file can reach, so the name
  ;; ties an accessor and a mutator together across methods.
  (define class-fields (make-hasheq))
  (define method-fields (make-free-id-table))
  (define field-partners (make-free-id-table))
  (define (note-field! self name accessor mutator)
    (define field (hash-ref! (hash-ref! class-fields (syntax-e self) make-hasheq) name (lambda () (mcons #f #f))))
    (when accessor (set-mcar! field accessor))
    (when mutator (set-mcdr! field mutator))
    (free-id-table-update! method-fields self
                           (lambda (names) (if (memq name names) names (append names (list name)))) '()))
  ;; A marker followed by the read. Expansion splices a begin into a body, so they are
  ;; neighbours in whatever form holds them.
  (define (note-field-reads parts)
    (for ([marked (in-list parts)] [read (in-list (cdr parts))]
          #:when (let ([e (syntax-e marked)]) (and (pair? e) (eq? (syntax-e* (car e)) 'quote))))
      (syntax-case* #`(#,marked #,read) (quote let-values #%plain-app) free-identifier=?
        [((quote (marker name)) (let-values ([(object) self]) (#%plain-app (#%plain-app accessor o) . arguments)))
         (field-read? #'marker #'name #'self #'object #'o)
         (note-field! #'self (syntax-e #'name) #'accessor #f)]
        [((quote (marker name)) (let-values ([(object) self]) (#%plain-app accessor o)))
         (and (identifier? #'accessor) (field-read? #'marker #'name #'self #'object #'o))
         (note-field! #'self (syntax-e #'name) #'accessor #f)]
        [_ (void)])))
  (define (field-read? marker name self object o)
    (and (memq (syntax-e marker) '(declare-field-use declare-inherit-use))
         (class-object? self) (original-binding? name source) (free-identifier=? object o)))
  ;; The two shapes start in a binding form's first initialiser, which rules out nearly all.
  (define (class-field-form? clauses)
    (define clause (and (pair? clauses) (syntax->list (car clauses))))
    (define rhs (and clause (= (length clause) 2) (cadr clause)))
    (define parts (and rhs (syntax->list rhs)))
    (if (identifier? rhs)
        (class-object? rhs)
        (and parts (pair? parts) (pair? (cdr parts))
             (memq (syntax-e* (cadr parts)) '(make-struct-field-accessor make-struct-field-mutator)))))
  (define (note-class-field stx)
    (syntax-case* stx (let-values #%plain-app make-struct-field-accessor make-struct-field-mutator)
                  free-identifier=?
      ;; An inherited field's assignment has no marker; every assignment has this shape.
      [(let-values ([(object) self]) (let-values ([(id) value]) (#%plain-app mutator o argument)))
       (and (class-object? #'self) (original-binding? #'id source)
            (free-identifier=? #'object #'o) (free-identifier=? #'id #'argument))
       (note-field! #'self (syntax-e #'id) #f #'mutator)]
      [(let-values ([(id) (#%plain-app maker type (quote index) . rest)] ...) . body)
       (let ([made (map list (syntax->list #'(id ...)) (syntax->list #'(maker ...)) (syntax->datum #'(index ...)))])
         (for* ([accessor (in-list made)]
                #:when (free-identifier=? (cadr accessor) #'make-struct-field-accessor)
                [mutator (in-list made)]
                #:when (and (free-identifier=? (cadr mutator) #'make-struct-field-mutator)
                            (equal? (caddr accessor) (caddr mutator))))
           (free-id-table-set! field-partners (car accessor) (car mutator))
           (free-id-table-set! field-partners (car mutator) (car accessor))))]
      [_ (void)]))
  ;; A row for each field this method's code reads or assigns, on its object. With no setter
  ;; found, the row can only be read, and a program's chaperone is not run to fill it.
  (define (field-rows self)
    (for*/list ([name (in-list (free-id-table-ref method-fields self '()))]
                [field (in-value (hash-ref (hash-ref class-fields (syntax-e self)) name))]
                [partner (in-value (lambda (id) (and id (free-id-table-ref field-partners id #f))))]
                [getter (in-value (or (mcar field) (partner (mcdr field))))]
                [setter (in-value (or (mcdr field) (partner (mcar field))))]
                #:when getter)
      (with-syntax ([(value) (generate-temporaries '(value))])
        #`(#%plain-app make-field-binding '#,name
                       (case-lambda [() (#%plain-app #,getter #,self)]
                                    #,@(if setter (list #`[(value) (#%plain-app #,setter #,self value)]) '()))
                       #,self))))
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
       (collect-aliases stx)
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
         (when (pair? parts)
           (note-field-reads parts)
           (when (and (eq? (syntax-e* (car parts)) 'let-values) (pair? (cdr parts))
                      (class-field-form? (syntax->list (cadr parts))))
             (note-class-field stx)))
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
  ;; visible in it, innermost first. Nothing is built for a scope no site or closure
  ;; of a site can reach.
  (define (new-scope ids parent)
    (define live-bindings
      (if coverage?
          '()
          (append
           (for*/list ([id (in-list ids)]
                       [name (in-value (if (original-binding? id source)
                                           (syntax-e id)
                                           (free-id-table-ref lexical-aliases id #f)))]
                       #:when name)
             #`(#%plain-app make-live-binding '#,name
                            (case-lambda [() #,id] [(replacement) (set! #,id replacement)])))
           ;; After the source's names, one of which may be this. A class cannot assign
           ;; its object, so this code does not either and the variable stays immutable.
           (for*/list ([id (in-list ids)] #:when (class-object? id)
                       [row (in-list (cons #`(#%plain-app make-live-binding 'this (case-lambda [() #,id]))
                                           (field-rows id)))])
             row))))
    (if (null? live-bindings)
        parent
        (scope (car (generate-temporaries '(variables))) parent live-bindings #f #f)))
  (define (scope-procedure this)
    (when (scope-parent this) (set-scope-reached?! (scope-parent this) #t))
    #`(#%plain-lambda ()
        (#%plain-app list* #,@(scope-bindings this)
                     #,(if (scope-parent this)
                           #`(#%plain-app #,(scope-variable (scope-parent this)))
                           #''()))))
  ;; The mark naming the running call and the variables of the scope it is in. It belongs
  ;; to the continuation, so a re-entered continuation has its own variables back.
  (define (scope-mark variables act expressions)
    (list #`(with-continuation-mark frame-key
                (#%plain-app cons #,(activation-frame act) #,variables)
              (begin #,@expressions))))
  ;; Whether this binding form introduced the scope, rather than inheriting it.
  (define (own-scope? this parent) (and this (not (eq? this parent))))
  ;; Bind a scope's procedure around its body, which keeps its tail positions.
  (define (in-scope this parent act expressions)
    (if (and (own-scope? this parent) (scope-reached? this))
        (list #`(let-values ([(#,(scope-variable this)) #,(scope-procedure this)])
                  #,@(if (scope-sited? this)
                         (scope-mark (scope-variable this) act expressions)
                         expressions)))
        expressions))
  ;; Outside an expression context `lambda` expands to (#%expression (#%plain-lambda ...)),
  ;; which is as atomic as what it holds.
  (define (stoppable? expression)
    (and (not (identifier? expression))
         (let ([parts (syntax->list expression)])
           (and (pair? parts)
                (not (bound-form? (car parts) atomic-forms))
                (or (not (free-identifier=? (car parts) #'#%expression))
                    (stoppable? (cadr parts)))))))
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
  ;; The range of the nearest visible site around an expression in the same call, and
  ;; in the same form whatever the call. Sibling source executions stay distinct.
  (define enclosing-boundary (make-parameter #f))
  (define enclosing-owner (make-parameter #f))
  (define owner-results (make-parameter '()))
  ;; Whether a range takes in another. Source text inside a site is inside its range, so
  ;; generated code whose location takes in the site around it has borrowed the location.
  (define (range-holds? outer inner)
    (and inner
         (<= (car outer) (car inner))
         (<= (+ (car inner) (cdr inner)) (+ (car outer) (cdr outer)))))
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
  ;; Expansion can give generated code the source location of an expression it uses, as
  ;; `for` does with the expression that produces its sequence. A value reported against
  ;; that text has to be the text's value, so a range with authored code in this form
  ;; belongs to it. This is decided before any code is written: a generated site can come
  ;; before the authored code, or sit apart from it. A constant or a variable cannot stop,
  ;; so an operation written around one is the only stop its text has, and keeps it.
  (define authored-ranges (make-hash))
  (define (range-of located)
    (and located (cons (syntax-position located) (syntax-span located))))
  (define (authored-here? expression)
    (define range (range-of (location-of expression)))
    (and range (not (binding-container? expression)) (authored? expression range) range))
  (let note ([expression expanded])
    (define range (authored-here? expression))
    (when range
      (hash-update! authored-ranges range
                    (lambda (kind) (if (stoppable? expression) 'expression kind))
                    'operand))
    (for-each note (runtime-subexpressions expression)))
  ;; A stop kept for an operation around a constant or variable does not show the operation's
  ;; value against that text, unless the operation's value is the operand's.
  (define (shows-other-value? expression range)
    (and (not (authored? expression range))
         (eq? (hash-ref authored-ranges range #f) 'operand)
         (not (let gives-operand? ([e expression])
                (or (equal? (authored-here? e) range)
                    (ormap gives-operand? (result-subexpressions e)))))))
  (define (range-belongs-to-authored? expression range)
    (case (hash-ref authored-ranges range #f)
      [(expression) #t]
      [(operand)
       (not (let holds-operand? ([e expression])
              (or (equal? (authored-here? e) range)
                  (ormap holds-operand? (runtime-subexpressions e)))))]
      [else #f]))
  (define (body expressions environment act tail? [inferred-name #f])
    (for/list ([e (in-list expressions)] [i (in-naturals)])
      (define last? (= i (sub1 (length expressions))))
      (walk e environment act (and tail? last?) (and last? inferred-name))))
  ;; A frame is made only for a call that has a site to note in it. It holds the form,
  ;; the running site and the tokens made so far.
  (define (frame-around act entry-scope expressions)
    (if (activation-used? act)
        (list #`(let-values ([(#,(activation-frame act))
                              (#%plain-app vector #,form-id '0 '#f)])
                  (#%plain-app note-thread #,form-id)
                  #,@(scope-mark (if (and entry-scope (scope-sited? entry-scope))
                                     (scope-variable entry-scope)
                                     #''#f)
                                 act expressions)))
        expressions))
  (define (lambda-clause formals expressions environment)
    (define act (activation (car (generate-temporaries '(frame))) #f))
    (define own (new-scope (formal-identifiers formals) environment))
    ;; A call with no variables of its own starts with those it closes over.
    (define entry
      (if (eq? own environment)
          (and environment
               (scope (scope-variable environment) environment #f #f #f))
          own))
    (define rewritten
      (parameterize ([enclosing-boundary #f] [enclosing-site 0])
        (body expressions entry act #t)))
    (when (and entry (eq? own environment) (scope-reached? entry))
      (set-scope-reached?! environment #t))
    #`[#,formals #,@(in-scope-binding-only own environment (frame-around act entry rewritten))])
  ;; A call's own scope is marked by the frame that starts with it.
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
  ;; The expander writes a body's definitions as nested binding forms. Each binding form
  ;; adds a scope to everything below it when generated code is expanded again, which is
  ;; quadratic in the length of the body, and each must stay: a definition's variable is
  ;; allocated when its initialiser returns, once for each time it returns.
  ;;
  ;; So the nesting stays and stops at a limit. Every so many definitions, the rest of
  ;; the body moves out of line into a procedure that its predecessor tail-calls. The
  ;; procedure's code sits outside those binding forms and carries none of their scopes.
  ;; It reaches an earlier variable it uses through a getter and setter over the variable
  ;; itself, and the variables shown at a stop through the scope's procedure.
  (define body-nesting-limit 16)
  ;; The binding forms of one body, outermost first.
  (define (body-containers expression)
    (let loop ([expression expression] [containers '()])
      (if (binding-container? expression)
          (let ([bodies (cddr (syntax->list expression))])
            (if (null? (cdr bodies))
                (loop (car bodies) (cons expression containers))
                (reverse (cons expression containers))))
          (reverse containers))))
  (define (container-ids container)
    (syntax-case container ()
      [(_ ([(id ...) rhs] ...) . _) (syntax->list #'(id ... ...))]))
  (define (container-initializers container)
    (syntax-case container ()
      [(_ ([ids rhs] ...) . _) (syntax->list #'(rhs ...))]))
  ;; Decides where a long body moves out of line: for each container that starts a part,
  ;; the earlier variables that part or a later one uses.
  (define out-of-line (make-hasheq))
  (define planned-bodies (make-hasheq))
  (define (plan-body! top)
    (define containers (body-containers top))
    (define final (last containers))
    (define (part i) (quotient i body-nesting-limit))
    (define bound (make-free-id-table))
    (define last-used (make-free-id-table))
    (for ([container (in-list containers)] [i (in-naturals)])
      (hash-set! planned-bodies container #t)
      (for ([id (in-list (container-ids container))]) (free-id-table-set! bound id #t))
      ;; The body of all but the last container is the next container.
      (let note-uses ([v (if (eq? container final)
                             (append (container-initializers container) (cddr (syntax->list container)))
                             (container-initializers container))])
        (cond
          [(identifier? v)
           (when (free-id-table-ref bound v #f) (free-id-table-set! last-used v (part i)))]
          [(syntax? v)
           (define parts (syntax->list v))
           (unless (and (pair? parts) (identifier? (car parts)) (bound-form? (car parts) quoted-forms))
             (note-uses (syntax-e v)))]
          [(pair? v) (note-uses (car v)) (note-uses (cdr v))])))
    (for/fold ([earlier '()]) ([container (in-list containers)] [i (in-naturals)])
      (define live
        (cond
          [(and (positive? i) (zero? (remainder i body-nesting-limit)))
           (define used-later
             (filter (lambda (id) (>= (free-id-table-ref last-used id -1) (part i))) earlier))
           (hash-set! out-of-line container used-later)
           used-later]
          [else earlier]))
      (append (container-ids container) live))
    (> (length containers) body-nesting-limit))
  ;; The clauses of the procedures a body in progress has moved out of line, and how to
  ;; reach an earlier part's variables from the code being written.
  (define body-parts (make-parameter #f))
  (define accessors (make-parameter #f))
  (define (accessor-of id)
    (and (accessors) (free-id-table-ref (accessors) id #f)))
  (define (move-out-of-line ids environment rewrite)
    (define names (generate-temporaries ids))
    (define arguments
      (for/list ([id (in-list ids)])
        (or (accessor-of id)
            (let ([replacement (car (generate-temporaries '(replacement)))])
              #`(case-lambda [() #,id] [(#,replacement) (set! #,id #,replacement)])))))
    (define rewritten
      (parameterize ([accessors (for/fold ([known (or (accessors) (make-immutable-free-id-table))])
                                          ([id (in-list ids)] [name (in-list names)])
                                  (free-id-table-set known id name))])
        (rewrite)))
    ;; Known only now: whether anything in the moved code shows the variables.
    (define variables
      (if (and environment (scope-reached? environment)) (list (scope-variable environment)) '()))
    (define procedure (car (generate-temporaries '(rest-of-body))))
    (set-box! (body-parts)
              (cons #`[(#,procedure) (#%plain-lambda (#,@variables #,@names) #,rewritten)]
                    (unbox (body-parts))))
    #`(#%plain-app #,procedure #,@variables #,@arguments))
  (define (walk expression environment act tail? [context-name #f])
    (define located (location-of expression))
    (define range (range-of located))
    (define parent (enclosing-boundary))
    (define gives-owner-value? (memq expression (owner-results)))
    ;; A range an execution of authored code owns, once for each time it runs: not a copy
    ;; of what encloses it, and not generated code that borrowed the location.
    (define visible?
      (not (or (binding-container? expression)
               (and range (equal? range parent))
               (and range (not (authored? expression range))
                    (or (range-belongs-to-authored? expression range)
                        (and (not gives-owner-value?)
                             (range-holds? range (enclosing-owner))))))))
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
    (define (named-lambda rewritten)
      ;; Preserve source/properties, notably method-arity-error and inferred-name.
      ;; Generated bindings must not replace the compiler's contextual name with a
      ;; temporary binding or the instrumentation source location.
      (define original (datum->syntax expression (syntax-e rewritten) expression expression))
      (if inferred-name (syntax-property original 'inferred-name inferred-name) original))
    (define (rewrite-form)
      (syntax-case* expression (quote quote-syntax #%datum #%top #%variable-reference
                                    #%plain-lambda case-lambda if begin begin0
                                    let-values letrec-values set! with-continuation-mark
                                    #%plain-app #%expression)
                    free-identifier=?
        [id (identifier? #'id)
         (let ([accessor (accessor-of #'id)])
           (if accessor #`(#%plain-app #,accessor) expression))]
        [(quote . ignored) expression]
        [(quote-syntax . ignored) expression]
        [(#%datum . ignored) expression]
        [(#%top . ignored) expression]
        ;; A variable the moved code reaches through an accessor is not a constant it can
        ;; rely on. It has no variable here to refer to, so it refers to one that says so.
        [(#%variable-reference id)
         (and (identifier? #'id) (accessor-of #'id))
         #`(let-values ([(id) '#f]) (set! id '#f) (#%variable-reference id))]
        [(#%variable-reference . ignored) expression]
        [(#%plain-lambda formals expression ...)
         (with-syntax ([(new-formals new-body ...) (lambda-clause #'formals (syntax->list #'(expression ...)) environment)])
           (named-lambda #'(#%plain-lambda new-formals new-body ...)))]
        [(case-lambda [formals expression ...] ...)
         (with-syntax ([(clause ...)
                        (for/list ([f (in-list (syntax->list #'(formals ...)))]
                                   [es (in-list (syntax->list #'((expression ...) ...)))])
                          (lambda-clause f (syntax->list es) environment))])
           (named-lambda #'(case-lambda clause ...)))]
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
                [this (new-scope (apply append (map syntax->list groups)) environment)]
                [rhss (for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs environment act #f
                                         (and (= (length (syntax->list ids)) 1)
                                              (syntax-e (car (syntax->list ids)))))])]
                [bodies (body (syntax->list #'(expression ...)) this act tail? inferred-name)])
           #`(let-values #,rhss #,@(in-scope this environment act bodies)))]
        [(letrec-values ([(id ...) rhs] ...) expression ...)
         (let* ([groups (syntax->list #'((id ...) ...))]
                [initializers (syntax->list #'(rhs ...))]
                [this (new-scope (apply append (map syntax->list groups)) environment)]
                [rewritten-initializers
                 (for/list ([ids (in-list groups)] [rhs (in-list initializers)])
                   (walk rhs this act #f
                         (and (= (length (syntax->list ids)) 1)
                              (syntax-e (car (syntax->list ids))))))]
                [bodies (body (syntax->list #'(expression ...)) this act tail? inferred-name)]
                [own? (own-scope? this environment)]
                [marked? (and own? (scope-sited? this))]
                [mark (lambda (expressions)
                        (if marked? (scope-mark (scope-variable this) act expressions) expressions))]
                [rhss (for/list ([ids (in-list groups)] [rhs (in-list initializers)]
                                 [rewritten (in-list rewritten-initializers)])
                        ;; Only an initialiser that can stop needs the mark.
                        #`[#,ids #,@(if (stoppable? rhs) (mark (list rewritten)) (list rewritten))])])
           ;; The scope's procedure comes first: its getters may run in any initializer.
           #`(letrec-values (#,@(if (and own? (scope-reached? this))
                                    (list #`[(#,(scope-variable this)) #,(scope-procedure this)])
                                    '())
                             #,@rhss)
               #,@(mark bodies)))]
        [(set! id rhs)
         (let ([accessor (accessor-of #'id)]
               [value (walk #'rhs environment act #f (syntax-e #'id))])
           (if accessor #`(#%plain-app #,accessor #,value) #`(set! id #,value)))]
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
    (define (rewrite)
      (cond
        [(hash-ref out-of-line expression #f)
         => (lambda (ids) (move-out-of-line ids environment rewrite-form))]
        [(and (binding-container? expression)
              (not (hash-ref planned-bodies expression #f))
              (plan-body! expression))
         (define parts (box '()))
         (define first-part (parameterize ([body-parts parts]) (rewrite-form)))
         #`(letrec-values #,(reverse (unbox parts)) #,first-part)]
        [else (rewrite-form)]))
    (define rewritten
      (let ([owner? (and visible? range (stoppable? expression))])
        (parameterize ([enclosing-boundary (if owner? range parent)]
                       [enclosing-owner (if owner? range (enclosing-owner))]
                       [owner-results (if (or owner? gives-owner-value?)
                                          (result-subexpressions expression)
                                          '())]
                       [enclosing-site (or slot enclosing)])
          (rewrite))))
    (cond
      [(not slot) rewritten]
      [else
       (define descriptor
         (site (fresh-id) (syntax-source located)
               (syntax-line located) (syntax-column located)
               (syntax-position located) (syntax-span located)
               ;; A body's binding form holds all of the body after it.
               tail? (and (not (binding-container? expression)) (syntax->datum expression)) enclosing
               visible? (not (and range (shows-other-value? expression range)))))
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
  (define form-activation (activation (car (generate-temporaries '(frame))) #f))
  (define result (walk expanded #f form-activation initial-tail?
                       (if (identifier? local-name) (syntax-e local-name) local-name)))
  (define (identifiers-thunk identifiers)
    #`(#%plain-lambda () (#%plain-app list #,@(for/list ([id (in-list identifiers)]) #`(quote-syntax #,id)))))
  ;; A context's definitions as (source name . defined symbol). Names, not syntax: a
  ;; parent's identifier in a child's code keeps the module path indexes of the parent
  ;; as it expanded, which nothing shifts when the child is declared. Read back from a
  ;; file, they resolve against the current directory instead of the module.
  (define (defined-names identifiers)
    (for*/list ([id (in-list identifiers)]
                [binding (in-value (identifier-binding id))]
                #:when (list? binding))
      (cons (syntax-e id) (cadr binding))))
  ;; One registration per module: repeating the names in each of its forms would
  ;; grow with forms times declarations.
  (define register-context
    (if (and module-context (not (module-binding-context-registered? module-context)))
        (begin
          (set-module-binding-context-registered?! module-context #t)
          (list #`(#%plain-app register-module-context!
                   '#,(module-binding-context-key module-context)
                   #,(datum->syntax expanded (list #'#%variable-reference) expanded)
                   '#,(defined-names (module-binding-context-own-identifiers module-context))
                   '#,(for/list ([ancestor (in-list (module-binding-context-ancestors module-context))])
                        (cons (module-binding-context-key ancestor)
                              (defined-names (module-binding-context-own-identifiers ancestor)))))))
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
