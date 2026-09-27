#lang racket/base
(require (for-syntax racket/base))
(provide run)
(begin-for-syntax (displayln 'module-phase-effect))
(define-syntax (define-run stx)
  (displayln 'definition-transformer-use)
  (syntax-case stx ()
    [(_ name)
     #'(define (name)
         (let-syntax ([expression
                       (begin
                         (displayln 'local-transformer-create)
                         (lambda (stx)
                           (displayln 'local-transformer-use)
                           #'(+ 1 2)))])
           (expression)))]))
(define-run run)
