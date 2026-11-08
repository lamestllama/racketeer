;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

;; Expansion checkpoints are independent of memory and answer ceilings.
(provide current-step-checkpoint stop-expansion exn:fail:step-stop?)
(define macro-step-checkpoint 40000)
(define current-step-checkpoint (make-parameter macro-step-checkpoint))
(struct exn:fail:step-stop exn:fail ())
(define (stop-expansion)
  (raise (exn:fail:step-stop "Macro expansion was stopped because it took too many steps."
                             (current-continuation-marks))))
