#lang racket/base

(define amount 7)

;; Hover amount inside the syntax template: its binding is predicted.
;; Expansion can give a template identifier a different binding.
(define template #'amount)

;; This ordinary use has a confirmed binding and no prediction label.
(define (total extra)
  (+ amount extra))

(total 3)
