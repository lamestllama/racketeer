#lang racket/base
(provide announce-twice clamped)
(define-syntax-rule (announce-twice v)
  (begin
    (displayln "first")
    (let ([copy v])
      (displayln copy)
      (list copy copy))))
(define-syntax-rule (clamped v low)
  (let ([value v])
    (if (< value low)
        low
        value)))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
