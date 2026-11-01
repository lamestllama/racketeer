#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require (for-syntax racket/base) (only-in rackunit test-case)
         (only-in rackunit/text-ui run-tests) "testing.rkt")
(provide discovered-test-case)

;; Validate the binding at the original call site, after module imports and
;; definitions have their normal scopes. Discovery alone cannot establish it.
(define-syntax (discovered-test-case stx)
  (syntax-case stx ()
    [(_ id selected? (runner test argument ...))
     (and (identifier? #'runner) (eq? (syntax-e #'runner) 'run-tests))
     (if (free-identifier=? #'runner #'run-tests)
         #'(call-with-discovered-test id "RackUnit tests"
             (lambda () (run-discovered-tests id test argument ...)) #t)
         (if (syntax-e #'selected?)
             (raise-syntax-error #f "The selected form is not RackUnit run-tests" #'runner)
             #'(runner test argument ...)))]
    [(_ id selected? (operator name body ...))
     (if (free-identifier=? #'operator #'test-case)
         #'(call-with-discovered-test id name (lambda () (operator name body ...)))
         (if (syntax-e #'selected?)
             (raise-syntax-error #f "The selected form is not RackUnit test-case" #'operator)
             #'(operator name body ...)))]))
