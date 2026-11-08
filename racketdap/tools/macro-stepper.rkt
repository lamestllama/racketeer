#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Entry point and compatibility API for the macro steps worker.
(require racket/runtime-path
         "../tool-worker.rkt"
         "macro-steps/expansion.rkt" "macro-steps/answer.rkt"
         "macro-steps/limits.rkt" "macro-steps/session.rkt")
(provide expansion-steps call-with-memory-limit answer-text decode-term)

(define-runtime-path self "macro-stepper.rkt")

(module+ main (run-tool-worker self run-worker #:session? #t))
