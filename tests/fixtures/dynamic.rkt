#lang racket/base
(provide run)
(define current-label (make-parameter 'outer))
(define (helper) (+ 1 2))
(define (run)
  (parameterize ([current-label 'paused])
    (+ (helper) 40)))
