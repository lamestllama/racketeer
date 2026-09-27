#lang racket/base
(provide run)
(define (run)
  (letrec ([x (+ 1 2)] [later (lambda () x)])
    (later)))
