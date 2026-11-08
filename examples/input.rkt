#lang racket/base

(module+ main
  (display "Name: ")
  (flush-output)
  (define name (read-line))
  (unless (eof-object? name)
    (displayln (string-append "Hello, " name "!"))))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
