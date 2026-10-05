#lang racket/base

(require racket/runtime-path "macro-source.rkt" "../tool-worker.rkt")
(provide open-macro-stepper wait-for-macro-stepper)

(define-runtime-path self "macro-stepper.rkt")

;; The expansion engine and GUI are the upstream macro-debugger package.
;; Public API: https://docs.racket-lang.org/macro-debugger/index.html
(define (open-macro-stepper request)
  (define expand/step (dynamic-require 'macro-debugger/stepper 'expand/step))
  (call-with-macro-source request expand/step))

(define (wait-for-macro-stepper)
  (define windows (dynamic-require 'racket/gui/base 'get-top-level-windows))
  (define sleep/yield (dynamic-require 'racket/gui/base 'sleep/yield))
  ;; No timer or callback is kept alive after the last owned window closes.
  (let loop ()
    (unless (null? (windows))
      (sleep/yield 0.1)
      (loop))))

(define (run-worker request)
  (open-macro-stepper request)
  (displayln "Racket macro stepper opened. Close its windows or its editor terminal to finish.")
  (flush-output)
  (wait-for-macro-stepper))

(module+ main (run-tool-worker self run-worker))
