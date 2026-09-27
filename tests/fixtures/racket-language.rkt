#lang racket
(provide run)
(define counter%
  (class object%
    (super-new)
    (init-field [n 0])
    (define/public (increment) (set! n (add1 n)) n)))
(define (run)
  (define c (new counter% [n 10]))
  (list (send c increment) (send c increment)))
