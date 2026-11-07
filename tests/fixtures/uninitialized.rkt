#lang racket/base
(provide run)
(define (run)
  (letrec ([x (+ 1 2)] [later (lambda () x)])
    (later)))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
