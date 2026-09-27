#lang racket/base

;; Use Racket: Open File in Macro Stepper to include this module's macro.
;; Expansion runs transformer code; the runtime error below is not executed.
(define-syntax-rule (twice expression)
  (let ([value expression]) (+ value value)))

(define answer (twice 21))

;; This complete expression also works with Open Line or Selection in Macro
;; Stepper, whose fresh namespace contains Racket's standard bindings.
(let ([x 21]) (or #f (+ x x)))

(module+ main
  (error 'example "This runtime body is not run by the macro stepper."))
