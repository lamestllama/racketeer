#lang racket/base

;; Hover the recursive calls. sum/tail returns the recursive call's result
;; directly; sum still has an addition to perform after its call returns.
;; Hover if or + to see their immediate tail-position relationships.

(define (sum n)
  (if (zero? n)
      0
      (+ n (sum (sub1 n)))))

(define (sum/tail n total)
  (if (zero? n)
      total
      (sum/tail (sub1 n) (+ total n))))

(sum 10)
(sum/tail 10 0)
