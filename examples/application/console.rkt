#lang racket/base
(require "message.rkt")

(display (message))
(for ([argument (in-vector (current-command-line-arguments))])
  (displayln argument))
