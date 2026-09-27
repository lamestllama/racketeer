#lang racket/base
(provide run)
(define (run)
  (let loop ([n 20000] [sum 0])
    (if (zero? n) sum (loop (sub1 n) (+ sum n)))))
