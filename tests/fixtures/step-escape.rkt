#lang racket/base
(provide run)
(define (run)
  (define result
    (call/cc (lambda (escape) (+ 1 (escape 40)))))
  (+ result 2))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
