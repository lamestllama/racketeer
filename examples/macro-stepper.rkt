#lang racket/base
(provide answer swapped)

;; Use Racket: Step Through Macros in This File to see this module's macros expand.
;; Expansion runs transformer code; the runtime error below is not executed.
(define-syntax-rule (twice expression)
  (let ([value expression]) (+ value value)))

(define answer (twice 21))

;; swap! introduces its own tmp, which stays apart from the caller's tmp.
(define-syntax-rule (swap! a b)
  (let ([tmp a]) (set! a b) (set! b tmp)))

(define (swapped)
  (define tmp 1)
  (define other 2)
  (swap! tmp other)
  (list tmp other))

;; This line uses only Racket's macros, so Racket: Step Through Macros on This
;; Line opens on them.
(let ([x 21]) (or #f (+ x x)))

(module+ main
  (error 'example "This runtime body is not run by the macro stepper."))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
