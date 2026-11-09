#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(provide bind)

(define-syntax-rule (bind name rhs body ...)
  (begin (let () (let ([name rhs]) body ...))))
