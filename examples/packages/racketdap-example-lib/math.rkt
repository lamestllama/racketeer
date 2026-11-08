#lang racket/base
(provide twice)

(define (twice value)
  (+ value value))

(module+ test
  (require rackunit)
  (check-equal? (twice 21) 42))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
