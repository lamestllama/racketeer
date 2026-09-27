#lang racket/base

(define (price subtotal rate)
  (define tax (* subtotal rate))
  (values (+ subtotal tax) tax))

(module+ main
  (define-values (total tax) (price 100 1/10))
  (displayln total)
  (displayln tax))
