#lang racket/base

(define (price subtotal rate)
  (define tax (* subtotal rate))
  (values (+ subtotal tax) tax))

(module+ main
  (define-values (total tax) (price 100 1/10))
  (displayln total)
  (displayln tax))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
