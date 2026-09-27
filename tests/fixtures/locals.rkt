#lang racket/base
(provide run)
(define private-value 7)
(define-syntax-rule (add-private value) (+ private-value value))
(define (price subtotal rate)
  (define tax (* subtotal rate))
  (values (+ subtotal tax) tax))
(define (run) (price 100 1/10))
