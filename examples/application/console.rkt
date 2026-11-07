#lang racket/base
(require "message.rkt")

(display (message))
(for ([argument (in-vector (current-command-line-arguments))])
  (displayln argument))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
