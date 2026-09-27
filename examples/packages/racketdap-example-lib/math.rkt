#lang racket/base
(provide twice)

(define (twice value)
  (+ value value))

(module+ test
  (require rackunit)
  (check-equal? (twice 21) 42))
