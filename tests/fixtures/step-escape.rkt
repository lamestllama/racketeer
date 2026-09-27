#lang racket/base
(provide run)
(define (run)
  (define result
    (call/cc (lambda (escape) (+ 1 (escape 40)))))
  (+ result 2))
