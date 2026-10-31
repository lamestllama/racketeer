#lang racket/base

(define (reciprocal value)
  (/ 1 value))

(define (broken)
  (reciprocal 0))

;; Debug Current File stops at the failing expression for inspection.
;; Continue to report the error in Results, then click its source location.
;; Run Current File reports the error without stopping.
(module+ main (broken))
