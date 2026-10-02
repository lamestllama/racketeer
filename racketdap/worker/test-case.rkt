#lang racket/base

(require (for-syntax racket/base) (only-in rackunit test-case) "testing.rkt")
(provide discovered-test-case)

;; Validate the binding at the original call site, after module imports and
;; definitions have their normal scopes. Discovery alone cannot establish it.
(define-syntax (discovered-test-case stx)
  (syntax-case stx ()
    [(_ id selected? (operator name body ...))
     (if (free-identifier=? #'operator #'test-case)
         #'(call-with-discovered-test id name (lambda () (operator name body ...)))
         (if (syntax-e #'selected?)
             (raise-syntax-error #f "The selected form is not RackUnit test-case" #'operator)
             #'(operator name body ...)))]))
