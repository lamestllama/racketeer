#lang racket/base

(require (for-syntax racket/base))
(provide evaluate-bindings)

;; Bindings are (name getter setter-or-#f). Accessors point at the program's
;; actual cells. A returned closure deliberately retains that live access.
(define (binding-alias getter setter)
  (make-set!-transformer
   (lambda (stx)
     (syntax-case stx (set!)
       [(set! id rhs)
        (if setter
            #`(#%plain-app '#,setter rhs)
            (raise-syntax-error #f "debug binding is read-only" stx))]
       [(id . arguments) #`(#%app (#%plain-app '#,getter) . arguments)]
       [id (identifier? #'id) #`(#%plain-app '#,getter)]))))

(define (evaluate-bindings form bindings namespace)
  (eval
   #`(let-syntax
         (#,@(for/list ([binding (in-list bindings)])
               #`[#,(datum->syntax #f (car binding))
                  '#,(binding-alias (cadr binding) (caddr binding))]))
       #,(datum->syntax #f form))
   namespace))
