#lang racket/base
(require racket/list racket/path "runtime.rkt")
(provide instrument-module
         make-module-binding-context record-module-bindings!
         module-binding-context-identifiers module-binding-context-child!
         (all-from-out "runtime.rkt"))

(define quoted-forms (syntax->list #'(quote quote-syntax)))
(define atomic-forms
  (syntax->list #'(quote quote-syntax #%datum #%top #%variable-reference
                        lambda #%plain-lambda case-lambda)))
(define (bound-form? identifier forms)
  (and (identifier? identifier)
       (for/or ([form (in-list forms)]) (free-identifier=? identifier form))))

;; An environment is a lexical-order list of source-authored identifiers.
;; Generated bindings never compete with these names merely because they print
;; alike. Syntax identifiers retain the expander's binding scopes.
(define (source-name source)
  (cond [(path? source) (path->string (simplify-path source #f))]
        [(string? source) (path->string (simplify-path (string->path source) #f))]
        [else source]))
(define (original-binding? identifier source)
  (and (identifier? identifier)
       (or (syntax-original? identifier)
           (and (syntax-transforming?)
                (syntax-original? (syntax-local-introduce identifier))))
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

(define (instrument-module expanded source fresh-id on-event
                           #:module-bindings [known-module-bindings '()]
                           #:module-context [module-context #f]
                           #:tail? [initial-tail? #f])
  (define descriptors '())
  ;; Retain source-facing aliases for module bindings that expansion may rename.
  ;; Lexical evaluation alone cannot reconstruct these names from namespace maps.
  (define module-bindings known-module-bindings)
  (define (collect-module-bindings stx)
    (cond
      [(identifier? stx)
       (when (and (original-binding? stx source) (list? (identifier-binding stx)))
         (set! module-bindings (cons stx module-bindings)))]
      [(syntax? stx)
       (define parts (syntax->list stx))
       (unless (and (pair? parts) (identifier? (car parts))
                    (bound-form? (car parts) quoted-forms))
         (collect-module-bindings (syntax-e stx)))]
      [(pair? stx)
       (collect-module-bindings (car stx))
       (collect-module-bindings (cdr stx))]
      [else (void)]))
  (collect-module-bindings expanded)
  (define activation-id (car (generate-temporaries '(activation))))
  (define (literal v) #`(quote #,v))
  (define (extend ids environment)
    (append (filter (lambda (id) (original-binding? id source)) ids) environment))
  (define (bindings-expression environment)
    #`(list
       #,@(for/list ([id (in-list environment)])
            #`(make-live-binding
               '#,(syntax-e id)
               (lambda () #,id)
               (lambda (replacement) (set! #,id replacement))))))
  (define (stoppable? expression)
    (and (not (identifier? expression))
         (let ([parts (syntax->list expression)])
           (and (pair? parts)
                (not (bound-form? (car parts) atomic-forms))))))
  (define (site-for expression tail?)
    (and (stoppable? expression)
         (syntax-position expression)
         (equal? (source-name source) (source-name (syntax-source expression)))
         (let ([s (site (fresh-id) (syntax-source expression)
                        (syntax-line expression) (syntax-column expression)
                        (syntax-position expression) (syntax-span expression)
                        tail? (syntax->datum expression))])
           (set! descriptors (cons s descriptors))
           s)))
  (define (body expressions environment act tail?)
    (for/list ([e (in-list expressions)] [i (in-naturals)])
      (walk e environment act (and tail? (= i (sub1 (length expressions)))))))
  (define (lambda-clause formals expressions environment)
    (define act (car (generate-temporaries '(activation))))
    (define env (extend (formal-identifiers formals) environment))
    #`[#,formals
       (let ([#,act (make-activation)])
         #,@(body expressions env act #t))])
  (define (walk expression environment act tail?)
    (define rewritten
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
           #'(lambda new-formals new-body ...))]
        [(#%plain-lambda formals expression ...)
         (with-syntax ([(new-formals new-body ...) (lambda-clause #'formals (syntax->list #'(expression ...)) environment)])
           #'(#%plain-lambda new-formals new-body ...))]
        [(case-lambda [formals expression ...] ...)
         (with-syntax ([(clause ...)
                        (for/list ([f (in-list (syntax->list #'(formals ...)))]
                                   [es (in-list (syntax->list #'((expression ...) ...)))])
                          (lambda-clause f (syntax->list es) environment))])
           #'(case-lambda clause ...))]
        [(if test consequent alternative)
         #`(if #,(walk #'test environment act #f)
               #,(walk #'consequent environment act tail?)
               #,(walk #'alternative environment act tail?))]
        [(begin expression ...)
         #`(begin #,@(body (syntax->list #'(expression ...)) environment act tail?))]
        [(begin0 expression)
         #`(begin0 #,(walk #'expression environment act tail?))]
        [(begin0 expression rest ...)
         #`(begin0 #,(walk #'expression environment act #f)
                   #,@(body (syntax->list #'(rest ...)) environment act #f))]
        [(let-values ([(id ...) rhs] ...) expression ...)
         (let* ([groups (syntax->list #'((id ...) ...))]
                [env (extend (apply append (map syntax->list groups)) environment)])
           #`(let-values
                 (#,@(for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs environment act #f)]))
               #,@(body (syntax->list #'(expression ...)) env act tail?)))]
        [(letrec-values ([(id ...) rhs] ...) expression ...)
         (let* ([groups (syntax->list #'((id ...) ...))]
                [env (extend (apply append (map syntax->list groups)) environment)])
           #`(letrec-values
                 (#,@(for/list ([ids (in-list groups)] [rhs (in-list (syntax->list #'(rhs ...)))])
                        #`[#,ids #,(walk rhs env act #f)]))
               #,@(body (syntax->list #'(expression ...)) env act tail?)))]
        [(set! id rhs) #`(set! id #,(walk #'rhs environment act #f))]
        [(with-continuation-mark key value result)
         #`(with-continuation-mark #,(walk #'key environment act #f)
                                   #,(walk #'value environment act #f)
             ;; The body shares the marked continuation even when this entire
             ;; form has a pending completion. A body completion wrapper would
             ;; keep same-key marks that the program normally replaces.
             #,(walk #'result environment act #t))]
        [(#%app expression ...)
         #`(#%app #,@(body (syntax->list #'(expression ...)) environment act #f))]
        [(#%plain-app expression ...)
         #`(#%plain-app #,@(body (syntax->list #'(expression ...)) environment act #f))]
        [(#%expression expression)
         #`(#%expression #,(walk #'expression environment act tail?))]
        [_ (raise-syntax-error 'instrument-module "unsupported expanded runtime form" expression)]))
    (define descriptor (site-for expression tail?))
    (if (not descriptor)
        rewritten
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
                                           #,(literal on-event))])
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
                                           #,(literal on-event) results)))))))))))
  (define result (walk expanded '() activation-id initial-tail?))
  (values #`(let ([#,activation-id (make-activation)])
              #,@(if module-context
                     (list #`(register-module-context!
                               (quote #,module-context)
                               #,(datum->syntax expanded (list #'#%variable-reference) expanded)
                               (quote #,(module-binding-context-ancestors module-context))))
                     '())
              #,result)
          (reverse descriptors)))
