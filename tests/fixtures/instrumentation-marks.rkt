#lang racket/base

(provide nested/non-tail nested/tail separate-continuations compound-path values-result zero-result
         evaluation-order marked-loop controlled-values marked-call read-private)

(define private-value 11)

(define (nested/non-tail)
  (list
   (with-continuation-mark 'key 1
     (with-continuation-mark 'key 2
       (continuation-mark-set->list #f 'key)))))

(define (nested/tail)
  (with-continuation-mark 'key 1
    (with-continuation-mark 'key 2
      (continuation-mark-set->list #f 'key))))

(define (separate-continuations)
  (with-continuation-mark 'key 1
    (list (with-continuation-mark 'key 2
            (continuation-mark-set->list #f 'key)))))

(define (compound-path)
  (define result
    (with-continuation-mark 'key 1
      (if #t
          (begin
            (void)
            (let ([value 2])
              (letrec ([read (lambda () (continuation-mark-set->list #f 'key))])
                (begin0 (with-continuation-mark 'key value (read))))))
          #f)))
  result)

(define (values-result)
  (define-values (a b)
    (with-continuation-mark 'key 1
      (with-continuation-mark 'key 2
        (values (continuation-mark-set->list #f 'key) 'second))))
  (values a b))

(define (zero-result)
  (define-values ()
    (with-continuation-mark 'key 1
      (with-continuation-mark 'key 2 (values))))
  (values))

(define (evaluation-order)
  (define effects '())
  (define (note label value)
    (set! effects (cons label effects))
    value)
  (define result
    (with-continuation-mark (note 'outer-key 'key) (note 'outer-value 1)
      (with-continuation-mark (note 'inner-key 'key) (note 'inner-value 2)
        (note 'body (continuation-mark-set->list #f 'key)))))
  (list result (reverse effects)))

(define (marked-loop)
  (define result
    (with-continuation-mark 'key 'outside
      (let loop ([n 5000])
        (with-continuation-mark 'key n
          (if (zero? n)
              (continuation-mark-set->list #f 'key)
              (loop (sub1 n)))))))
  result)

(define (controlled-values)
  (define-values (a b)
    (with-continuation-mark 'key 'outer
      (with-continuation-mark 'key 'inner (values 1 2))))
  (list a b))

(define (callee value) (+ value 1))
(define (marked-call)
  (define result
    (with-continuation-mark 'key 'outer
      (with-continuation-mark 'key 'inner (callee 4))))
  result)

(define (read-private) (+ private-value 1))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
