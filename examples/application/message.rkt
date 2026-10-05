#lang racket/base
(require racket/runtime-path racket/file)
(provide message)

(define-runtime-path message-file "message.txt")
(define (message) (file->string message-file))
