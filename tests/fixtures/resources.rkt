#lang racket/base
(provide run)
(define background (thread (lambda () (sync never-evt))))
(define (run) (list background))
