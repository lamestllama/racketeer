#lang racket/base
(provide price)

(define (tax-for subtotal rate)
  (* subtotal rate))

(define (price subtotal rate)
  (define tax (tax-for subtotal rate))
  (values (+ subtotal tax) tax))

(module+ test
  (require rackunit)
  (test-case "price returns the total and tax"
    (define-values (total tax) (price 100 1/10))
    (check-equal? total 110)
    (check-equal? tax 10)))
