#lang racket/base

(require rackunit
         racket/async-channel
         "../../lsp/safedoc.rkt")

(provide analyze!)

(define (analyze! sd [state 'succeeded])
  (define analyzed (make-async-channel))
  (safedoc-run-check-syntax!
    (lambda (_method _params)
      (async-channel-put analyzed (current-thread)))
    sd)
  (define worker (sync/timeout 20 analyzed))
  (check-true (thread? worker) "analysis publishes diagnostics")
  (check-eq? (sync/timeout 20 worker) worker "analysis finishes publication")
  (check-eq?
    (Check-Syntax-Status-state
      (with-read-safedoc sd SafeDoc-check-syntax-status))
    state))
