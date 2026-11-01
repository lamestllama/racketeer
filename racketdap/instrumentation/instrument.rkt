#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list racket/path syntax/id-table "runtime.rkt")
(provide instrument-module instrumented-procedure-name instrumented-port?
         make-module-binding-context record-module-bindings!
         module-binding-context-identifiers module-binding-context-child!
         (all-from-out "runtime.rkt"))

;; Only the lambda/case-lambda rewrite below can register a value. Keeping this
;; operation private lets inspection trust these names without querying an
;; arbitrary callable structure's prop:object-name. Weak keys do not retain
;; closures (or their captured debuggee state) after the program drops them.
(define procedure-names (make-weak-hasheq))
(define (remember-procedure procedure)
  (hash-set! procedure-names procedure (object-name procedure))
  procedure)
(define (instrumented-procedure-name value)
  (hash-ref procedure-names value #f))

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
(define ports (make-weak-hasheq))
(define (port-constructor? value) (hash-ref port-constructors value #f))
(define (remember-ports . results)
  (for ([value (in-list results)]) (hash-set! ports value #t))
  (apply values results))
(define (instrumented-port? value) (hash-ref ports value #f))

(define quoted-forms (syntax->list #'(quote quote-syntax)))
(define atomic-forms
  (syntax->list #'(quote quote-syntax #%datum #%top #%variable-reference
                        lambda #%plain-lambda case-lambda)))
(define binding-forms (syntax->list #'(let-values letrec-values)))
(define (bound-form? identifier forms)
  (and (identifier? identifier)
       (for/or ([form (in-list forms)]) (free-identifier=? identifier form))))

;; An environment pairs source names with runtime identifiers in lexical order.
;; Generated bindings never compete with these names merely because they print
;; alike. Syntax identifiers retain the expander's binding scopes.
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
;; Parent links remain live so a later parent declaration becomes visible.
(struct module-binding-context ([own-identifiers #:mutable] parent children)
  #:constructor-name new-module-binding-context)
(define (make-module-binding-context [parent #f])
  (new-module-binding-context '() parent (make-hasheq)))
(define (module-binding-context-child! parent name [inherit? #t])
  (hash-ref! (module-binding-context-children parent) name
             (lambda () (make-module-binding-context (and inherit? parent)))))
(define (module-binding-context-owned context)
  (append
   (for/list ([id (in-list (module-binding-context-own-identifiers context))])
     (cons context id))
   (if (module-binding-context-parent context)
       (module-binding-context-owned (module-binding-context-parent context))
       '())))
(define (module-binding-context-ancestors context)
  (if (module-binding-context-parent context)
      (cons (module-binding-context-parent context)
            (module-binding-context-ancestors (module-binding-context-parent context)))
      '()))
(define (module-binding-context-identifiers context)
  (map cdr (module-binding-context-owned context)))
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

(struct boundary (range authored? [visible? #:mutable]))

(define (instrument-module expanded source fresh-id on-event
                           #:module-bindings [known-module-bindings '()]
                           #:module-context [module-context #f]
                           #:expression-boundary? [expression-boundary? #f]
                           #:coverage? [coverage? #f]
                           #:tail? [initial-tail? #f])
  (define descriptors '())
  ;; Retain source-facing aliases for module bindings that expansion may rename.
  ;; Lexical evaluation alone cannot reconstruct these names from namespace maps.
  (define module-bindings known-module-bindings)
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
       (when (and (original-binding? stx source) (list? (identifier-binding stx)))
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
  (define activation-id (car (generate-temporaries '(activation))))
  (define (literal v) #`(quote #,v))
  (define (extend ids environment)
    (append (for/list ([id (in-list ids)]
                       #:do [(define name (if (original-binding? id source)
                                              (syntax-e id)
                                              (free-id-table-ref lexical-aliases id #f)))]
                       #:when name)
              (cons name id))
            environment))
  (define (bindings-expression environment)
    #`(list
       #,@(for/list ([binding (in-list environment)])
            (define id (cdr binding))
            #`(make-live-binding
               '#,(car binding)
               (lambda () #,id)
               (lambda (replacement) (set! #,id replacement))))))
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
  (define (site-for expression tail? visible?)
    (and (or coverage? (stoppable? expression)
             ;; A complete module expression is executable even when it is
             ;; only a constant or reference. Keep atomic operands inside
             ;; other expressions out of the ordinary stepping sequence.
             (and expression-boundary? (eq? expression expanded)))
         (syntax-position expression)
         (equal? (source-name source) (source-name (syntax-source expression)))
         (let ([s (site (fresh-id) (syntax-source expression)
                        (syntax-line expression) (syntax-column expression)
                        (syntax-position expression) (syntax-span expression)
                        tail? (syntax->datum expression))])
           (when visible? (set! descriptors (cons s descriptors)))
           s)))
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
  (define (lambda-clause formals expressions environment)
    (define act (car (generate-temporaries '(activation))))
    (define env (extend (formal-identifiers formals) environment))
    #`[#,formals
       (let ([#,act (make-activation)])
         #,@(parameterize ([enclosing-boundary #f])
              (body expressions env act #t)))])
  (define (application operator expressions environment act)
    (define rewritten (body expressions environment act #f))
    (cond
      [(null? rewritten) #`(#,operator)]
      [else
       (define function (car (generate-temporaries '(function))))
       (define call #`(#,operator #,function #,@(cdr rewritten)))
       ;; Evaluate the operator once and arguments in their original order.
       ;; Ordinary calls remain tail calls; only known primitive constructors
       ;; need a receiver to record their one or more unchanged port results.
       #`(let ([#,function #,(car rewritten)])
           (if (#%plain-app #,(literal port-constructor?) #,function)
               (call-with-values (lambda () #,call) #,(literal remember-ports))
               #,call))]))
  (define (walk expression environment act tail? [context-name #f])
    (define range
      (and (syntax-position expression) (syntax-span expression)
           (equal? (source-name source) (source-name (syntax-source expression)))
           (cons (syntax-position expression) (syntax-span expression))))
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
    (define (remember-lambda rewritten)
      ;; Preserve source/properties, notably method-arity-error and inferred-name.
      ;; The registration call must not replace the compiler's contextual name
      ;; with a temporary binding or the instrumentation source location.
      (define original (datum->syntax expression (syntax-e rewritten) expression expression))
      (define named (if inferred-name (syntax-property original 'inferred-name inferred-name) original))
      #`(#%plain-app #,(literal remember-procedure) #,named))
    (define (rewrite)
      (syntax-case* expression (quote quote-syntax #%datum #%top #%variable-reference
                                    lambda #%plain-lambda case-lambda if begin begin0
                                    let-values letrec-values set! with-continuation-mark
                                    #%app #%plain-app #%expression)
                    free-identifier=?
        [id (identifier? #'id) expression]
        [(quote . ignored) expression]
        [(quote-syntax . ignored) expression]
        [(#%datum . ignored) expression]
        [(#%top . ignored) expression]
        [(#%variable-reference . ignored) expression]
        [(lambda formals expression ...)
         (with-syntax ([(new-formals new-body ...) (lambda-clause #'formals (syntax->list #'(expression ...)) environment)])
           (remember-lambda #'(lambda new-formals new-body ...)))]
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
                [env (extend (apply append (map syntax->list groups)) environment)])
           #`(let-values
                 (#,@(for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs environment act #f
                                         (and (= (length (syntax->list ids)) 1)
                                              (syntax-e (car (syntax->list ids)))))]))
               #,@(body (syntax->list #'(expression ...)) env act tail? inferred-name)))]
        [(letrec-values ([(id ...) rhs] ...) expression ...)
         (let* ([groups (syntax->list #'((id ...) ...))]
                [env (extend (apply append (map syntax->list groups)) environment)])
           #`(letrec-values
                 (#,@(for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs env act #f
                                         (and (= (length (syntax->list ids)) 1)
                                              (syntax-e (car (syntax->list ids)))))]))
               #,@(body (syntax->list #'(expression ...)) env act tail? inferred-name)))]
        [(set! id rhs) #`(set! id #,(walk #'rhs environment act #f (syntax-e #'id)))]
        [(with-continuation-mark key value result)
         #`(with-continuation-mark #,(walk #'key environment act #f)
                                   #,(walk #'value environment act #f)
             ;; The body shares the marked continuation even when this entire
             ;; form has a pending completion. A body completion wrapper would
             ;; keep same-key marks that the program normally replaces.
             #,(walk #'result environment act #t inferred-name))]
        [(#%app expression ...)
         (application #'#%app (syntax->list #'(expression ...)) environment act)]
        [(#%plain-app expression ...)
         (application #'#%plain-app (syntax->list #'(expression ...)) environment act)]
        [(#%expression expression)
         #`(#%expression #,(walk #'expression environment act tail? inferred-name))]
        [_ (raise-syntax-error 'instrument-module "unsupported expanded runtime form" expression)]))
    (define rewritten
      (parameterize ([enclosing-boundary
                      (if (and (boundary-visible? current) range (stoppable? expression))
                          current parent)])
        (rewrite)))
    (define visible? (boundary-visible? current))
    (define descriptor (site-for expression tail? visible?))
    (define callback (and visible? on-event))
    (cond
      [(not descriptor) rewritten]
      ;; Coverage runs without debugging, so a visit is the only event.
      [coverage?
       (if callback
           #`(begin (announce-visit #,(literal descriptor) #,(literal callback)) #,rewritten)
           rewritten)]
      [else
        (let* ([token (car (generate-temporaries '(token)))]
               [decision (car (generate-temporaries '(decision)))]
               [frame-expression
                #`(make-frame #,act (quote-syntax #,expression)
                              #,(bindings-expression environment)
                              (list #,@(for/list ([id (in-list module-bindings)]) #`(quote-syntax #,id)))
                              #,(literal (and module-context
                                             (lambda () (module-binding-context-owned module-context))))
                              (lambda ()
                                (variable-reference->namespace
                                 #,(datum->syntax expression (list #'#%variable-reference) expression)))
                              #,(literal descriptor))]
               [before #`(announce-before #,(literal descriptor) #,(if tail? #'#f token)
                                           #,(literal callback))])
          (if tail?
              #`(with-continuation-mark frame-key #,frame-expression
                  (let ([#,decision #,before])
                    (if #,decision (apply values #,decision) #,rewritten)))
              #`(let ([#,token (gensym 'expression)])
                  (with-continuation-mark context-key #,token
                    (with-continuation-mark frame-key #,frame-expression
                      (let ([#,decision #,before])
                        (call-with-values
                         (lambda ()
                           (if #,decision (apply values #,decision) #,rewritten))
                         (lambda results
                           (announce-after #,(literal descriptor) #,token
                                           #,(literal callback) results)))))))))]))
  (define local-name (and (syntax-transforming?) (syntax-local-name)))
  (define result (walk expanded '() activation-id initial-tail?
                       (if (identifier? local-name) (syntax-e local-name) local-name)))
  (values #`(let ([#,activation-id (make-activation)])
              #,@(if module-context
                     (list #`(register-module-context!
                               (quote #,module-context)
                               #,(datum->syntax expanded (list #'#%variable-reference) expanded)
                               (quote #,(module-binding-context-ancestors module-context))))
                     '())
              #,result)
          (reverse descriptors)))
