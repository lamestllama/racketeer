#lang racket/base
(require "app/orders.rkt")
(provide quote-order)

(define (quote-order [quantity 2])
  (define-values (total tax net) (order-total 100 quantity 1/10))
  (values total tax net))

(module+ main
  (define-values (total tax net) (quote-order))
  (printf "Total: ~a; tax: ~a; net: ~a\n" total tax net))

(module+ test
  (require rackunit)
  (test-case "two items with discount and tax"
    (check-equal? (call-with-values quote-order list) '(198 18 180))))

;; Load this file in Debug REPL, then enter (quote-order) in Debug Console.
;; Or select just the expression below (without ;;) and evaluate the selection.
;; (quote-order 3)
