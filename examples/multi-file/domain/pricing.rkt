#lang racket/base
(require "tax/rates.rkt")
(provide price-with-tax)

(define (price-with-tax net)
  (define tax (tax-amount net 1/10))
  (define total (+ net tax))
  (values total tax))

(module+ test
  (require rackunit)
  (test-case "price returns both total and tax"
    (check-equal? (call-with-values (lambda () (price-with-tax 180)) list)
                  '(198 18))))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
