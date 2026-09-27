#lang racket/base
(require "math.rkt")

(define (show-price subtotal)
  (define-values (total tax) (price subtotal 1/10))
  (printf "Total: ~a; tax: ~a\n" total tax))

(module+ main
  (show-price 100))

(module+ test
  (require rackunit)
  (check-not-exn (lambda () (show-price 50))))

;; Load this file in Debug REPL, select the following expression, and use
;; Evaluate Selection in Debug REPL. A breakpoint in math.rkt also works here.
;; (show-price 200)
