#lang racket/base
(require racket/control racket/match)
(provide run)

(define (run)
  (define effects '())
  (define (note value)
    (set! effects (cons value effects))
    value)
  (define values-result
    (call-with-values
     (lambda () (begin0 (values (note 'a) (note 'b)) (note 'after))) list))
  (define zero-result
    (call-with-values (lambda () (begin0 (values) (note 'zero))) list))
  (define void-result (call-with-values void list))
  (define (factorial n) (if (zero? n) 1 (* n (factorial (sub1 n)))))
  (define rest-result ((case-lambda [(a) a] [(a b . rest) (cons (+ a b) rest)]) 1 2 3 4))
  (define escape-result
    (call/cc
     (lambda (escape)
       (dynamic-wind
         (lambda () (note 'enter))
         (lambda () (escape 'escaped))
         (lambda () (note 'leave))))))
  (define composable-result
    (reset (+ 1 (shift k (+ (k 2) (k 3))))))
  (define marked-result
    (with-continuation-mark (note 'key) (note 'value)
      (continuation-mark-set-first #f 'key)))
  (define raised-result (with-handlers ([(lambda (v) (eq? v 'raised)) values]) (raise 'raised)))
  (define macro-result
    (for/list ([x (in-range 4)]) (match (list x) [(list y) (+ y 10)])))
  (values values-result zero-result (map void? void-result) (factorial 8)
          rest-result escape-result composable-result marked-result raised-result
          macro-result (reverse effects)))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
