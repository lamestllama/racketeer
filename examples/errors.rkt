#lang racket/base

(define (reciprocal value)
  (/ 1 value))

(define (broken)
  (reciprocal 0))

;; Run in Interactions and evaluate (broken). Continue if execution pauses,
;; then click the error's source location.
;; Edit the definition and click again to inspect the source used by that run.
