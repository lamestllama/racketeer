#lang racket/base
(provide run)
(define (run)
  (define saved #f)
  (define visits 0)
  (define effects '())
  (define (note x) (set! effects (cons x effects)))
  (define result
    (dynamic-wind
      (lambda () (note 'enter))
      (lambda () (call/cc (lambda (k) (set! saved k) 'first)))
      (lambda () (note 'leave))))
  (set! visits (add1 visits))
  (if (< visits 3)
      (saved visits)
      (list result visits (reverse effects))))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
