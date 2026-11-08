#lang racket/gui
(require "message.rkt")

(define window (new frame% [label "Application example"] [width 420] [height 140]))
(new message% [parent window] [label (message)])
(new button% [parent window] [label "Close"]
     [callback (lambda (_button _event) (send window show #f))])
(send window show #t)

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
