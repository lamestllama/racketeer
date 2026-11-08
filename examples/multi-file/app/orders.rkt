#lang racket/base
(require "../domain/pricing.rkt")
(provide order-total)

(define (order-total unit-price quantity discount-rate)
  (define subtotal (* unit-price quantity))
  (define discount (* subtotal discount-rate))
  (define net (- subtotal discount))
  (define-values (total tax) (price-with-tax net))
  (values total tax net))

(module+ test
  (require rackunit)
  (test-case "discount applies before tax"
    (check-equal? (call-with-values (lambda () (order-total 100 2 1/10)) list)
                  '(198 18 180))))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
