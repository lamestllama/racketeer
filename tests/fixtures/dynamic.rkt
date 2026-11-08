#lang racket/base
(provide run)
(define current-label (make-parameter 'outer))
(define (helper) (+ 1 2))
(define (run)
  (parameterize ([current-label 'paused])
    (+ (helper) 40)))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
