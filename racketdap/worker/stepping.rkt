#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require "../instrumentation/instrument.rkt")
(provide make-step step-reason)
(struct step (mode target))
(define (make-step mode stop)
  (define target
    (case mode
      [(next) (or (and (eq? (stop-kind stop) 'before) (stop-token stop))
                  (stop-return-token stop))]
      [(stepOut) (stop-return-token stop)]
      [else #f]))
  ;; A callback entered from uninstrumented code has no observable caller.
  ;; Without a target, the next source boundary is the only available step.
  (step (if (or (and (eq? mode 'next) (eq? (stop-kind stop) 'after))
                (and (memq mode '(next stepOut)) (not target)))
            'stepIn mode)
        target))

;; Context identity survives continuation capture/re-entry. Each thread owns
;; its own command; a continuation cannot carry a command to another thread.
(define (step-reason command stop)
  (and command
       (cond
         [(eq? (step-mode command) 'stepIn)
          (case (stop-kind stop)
            [(before) "Before expression"]
            [(after) "Expression returned"]
            [else #f])]
         [(not (step-target command)) #f]
         [(and (eq? (stop-kind stop) 'after)
               (eq? (step-target command) (stop-token stop))) "Expression returned"]
         [(not (memq (step-target command) (stop-contexts stop)))
          "Control transferred outside the step target"]
         [else #f])))
