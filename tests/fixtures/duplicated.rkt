#lang racket/base
(provide run)
(define-syntax-rule (twice expression) (list expression expression))
(define (run)
  (define x 0)
  (twice (begin (set! x (add1 x)) x)))
