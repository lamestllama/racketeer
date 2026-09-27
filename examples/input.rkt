#lang racket/base

(module+ main
  (display "Name: ")
  (flush-output)
  (define name (read-line))
  (unless (eof-object? name)
    (displayln (string-append "Hello, " name "!"))))
