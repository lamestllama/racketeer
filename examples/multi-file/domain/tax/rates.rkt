#lang racket/base
(provide tax-amount)

(define (tax-amount taxable rate)
  (define tax (* taxable rate)) ; Set a breakpoint here.
  tax)

(module+ test
  (require rackunit)
  (test-case "tax uses exact arithmetic"
    (check-equal? (tax-amount 180 1/10) 18)))
