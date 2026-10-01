#lang racket/base

(require (for-syntax racket/base syntax/kerncase))
(provide instrument-form define-instrumented-module-begin)

(define-syntax-rule (define-instrumented-module-begin name language-module-begin rewrite runtime-path)
  (define-syntax (name stx)
    (syntax-case stx ()
      [(_ body (... ...))
       (with-syntax ([original-body
                      (datum->syntax stx
                        (cons #'language-module-begin (syntax->list #'(body (... ...))))
                        stx stx)])
         #'(instrument-language-body rewrite runtime-path original-body))])))

(define-syntax (instrument-language-body stx)
  (syntax-case stx ()
    [(_ rewrite runtime-path body)
     (let ([expanded (local-expand #'body 'module-begin (list #'#%plain-module-begin))])
       (syntax-case expanded (#%plain-module-begin)
         [(#%plain-module-begin form ...)
          (with-syntax ([(wrapped ...)
                         (for/list ([f (in-list (syntax->list #'(form ...)))])
                           (kernel-syntax-case f #f
                             [(define-syntaxes . _) f]
                             [(begin-for-syntax . _) f]
                             [(#%require . _) f]
                             [(#%provide . _) f]
                             [(#%declare . _) f]
                             [_ #`(instrument-form rewrite #,f)]))])
            #'(#%plain-module-begin
               (require (only-in (file runtime-path))) wrapped ...))]))]))

;; Expand only far enough to classify the module form. Compile-time forms
;; remain in the module's ordinary expansion pass. Only runtime expressions
;; undergo complete expansion before annotation; their lexical syntax has
;; already been consumed when the resulting core expression is compiled.
;; #%expression defers bare expressions to the same pass as definition RHSs,
;; preserving expansion order and the placement of shared lifted expressions.
(define-syntax (instrument-form stx)
  (syntax-case stx ()
    [(_ transform form)
     (syntax-case #'form (module+)
       [(module+ . _) ((syntax-e #'transform) 'module #'form)]
       [_
        (let ([expanded (local-expand #'form 'module (kernel-form-identifier-list))])
          (kernel-syntax-case expanded #f
            [(begin forms ...)
             #'(begin (instrument-form transform forms) ...)]
            [(define-values ids rhs)
             ((syntax-e #'transform) 'declaration expanded)
             #'(define-values ids (instrument-expression transform rhs))]
            [(define-syntaxes . _)
             ((syntax-e #'transform) 'declaration expanded)
             expanded]
            [(begin-for-syntax . _) expanded]
            [(#%require . _) expanded]
            [(#%provide . _) expanded]
            [(#%declare . _) expanded]
            [(module . _) ((syntax-e #'transform) 'module expanded)]
            [(module* . _) ((syntax-e #'transform) 'module expanded)]
            [else #`(#%expression (instrument-expression transform #,expanded))]))])]))

(define-syntax (instrument-expression stx)
  (syntax-case stx ()
    [(_ transform expression)
     ((syntax-e #'transform) 'expression
                            (local-expand #'expression 'expression null))]))
