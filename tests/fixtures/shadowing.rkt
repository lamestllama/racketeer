#lang racket/base
(provide run)
(define private-value 7)
(define mutable-value 1)
(define (change-module-value!) (set! mutable-value (add1 mutable-value)))
(define-syntax-rule (add-private value) (+ private-value value))
(define-syntax-rule (hidden-x expression)
  (let ([x 'macro-private]) expression))
(define (callee value)
  (+ value 1))
(define (run)
  (define x 10)
  (define f add1)
  (define before
    (let ([x 20] [private-value 1000])
      (hidden-x (+ x private-value))))
  (define after (callee x))
  (list before after x mutable-value (f x)))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
