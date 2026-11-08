#lang racket/base
;; The annotator these stops are compared with keeps one table of positions across files. So
;; the expressions here start past the end of lib.rkt, whose positions would otherwise collide
;; with them and lose their stops there. This comment is long enough to carry them past it.
(require "lib.rkt")
(define (f n)
  (announce-twice (+ n 1)))
(define (g n)
  (clamped (* n 2) 5))
(displayln (f 1))
(displayln (g 1))
(displayln (g 9))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
