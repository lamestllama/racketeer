;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

;; A separate entry point injects the small threshold only for tests.
(require racket/runtime-path
         "../../racketdap/tool-worker.rkt"
         "../../racketdap/tools/macro-steps/limits.rkt"
         "../../racketdap/tools/macro-steps/session.rkt"
         (submod "../../racketdap/tools/macro-steps/expansion.rkt" test-support))
(define-runtime-path self "macro-checkpoint-worker.rkt")
(module+ main
  (run-tool-worker self (lambda (request)
                          (parameterize ([current-step-checkpoint 16])
                            (if (hash-has-key? request 'testMemoryLimit)
                                (unless (call-with-memory-limit (hash-ref request 'testMemoryLimit)
                                          (lambda () (run-worker request) #t))
                                  (displayln (answer-text (failure-answer "memory" "Showing these macro steps would need more than 1 GB of memory.")))
                                  (flush-output))
                                (run-worker request))))
                   #:session? #t))
