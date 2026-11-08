#lang racket/base
(require "support.rkt" (for-syntax racket/base "support.rkt"))
(provide run)
(begin-for-syntax (displayln 'expand-parent))
(displayln 'load-parent)
(define (run) (+ (support) 1))
(module+ main (displayln 'main))
(module+ test (displayln 'test))
(module nested racket/base
  (provide run)
  (define private-value 99)
  (define (run) (+ private-value 1)))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
