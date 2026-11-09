#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Trace an expansion once and reduce it under the selected hiding policy.
(require racket/promise
         "../../language-adapters.rkt"
         macro-debugger/model/trace macro-debugger/model/reductions
         macro-debugger/model/reductions-util
         "printing.rkt" "policy.rkt" "facts.rkt" "answer.rkt" "checkpoint.rkt" "internal-error.rkt" "limits.rkt")
(provide expansion-steps)

;; Test hooks are process-local parameters, never request options.
(module+ test-support (provide current-step-checkpoint current-parse-derivation current-reductions))
(define current-parse-derivation (make-parameter force))
(define current-reductions (make-parameter reductions+))
(struct recording (derivation events adapter-fingerprint))

;; Every rewrite of an expansion, with the requested macro policy. Scope
;; transitions are filtered only after the model has applied hiding.
(define (expansion-steps stx hiding [lines #f]
                         #:schema-version [version 1] #:snapshot [snapshot 'null]
                         #:inspection-phases [requested-phases null]
                         #:retain-inspector [retain-inspector void]
                         #:partition [partition (new-foreground-partition)]
                         #:derivation [cached-derivation #f]
                         #:checkpoint [checkpoint (lambda (_) 'stop)]
                         #:custom [custom #f] #:origin [origin #f]
                         #:retain-derivation [retain-derivation void]
                         #:on-language-adapter [on-language-adapter void]
                         #:include-renaming? [include-renaming? #f]
                         #:one-term? [one-term? #f]
                         #:syntax-identity [syntax-identity (make-syntax-identity)]
                         #:suffix-option [suffix-option 'over-limit])
  (let/ec failed
    (define adapter (syntax-property stx 'racketeer:language-profile))
    (define fingerprint (and adapter (hash-ref adapter 'fingerprint #f)))
    (define (check-adapter!)
      (unless (and (language-adapter-current? adapter)
                   (or (not (recording? cached-derivation))
                       (equal? fingerprint (recording-adapter-fingerprint cached-derivation))))
        (incompatible "Language adapter changed. Open a fresh macro expansion.")))
    (check-adapter!)
    (on-language-adapter adapter)
    (define stage 'derivation)
    (define events #f)
    (define (internal value)
      (failed (internal-error-answer stage value stx events snapshot retain-inspector partition)))
    (with-handlers ([(lambda (value) (not (exn:worker? value))) internal])
      (define select-policy (prepare-hiding-policy stx hiding lines))
      (define derivation
        (or cached-derivation
            (parameterize ([trace-macro-limit (current-step-checkpoint)]
                           [trace-limit-handler
                            (lambda (count)
                              (check-adapter!)
                              (if (eq? (checkpoint count) 'stop)
                                  (stop-expansion)
                                  (* 2 count)))])
              (let-values ([(result events derivation) (trace* stx)]) (recording derivation events fingerprint)))))
      (check-adapter!)
      (retain-derivation derivation)
      (set! events (and (recording? derivation) (recording-events derivation)))
      (define parsed ((current-parse-derivation) (if (recording? derivation) (recording-derivation derivation) derivation)))
      (define rule-context (derivation-rule-context parsed origin))
      (set! stage 'steps)
      (define-values (steps binders definites expanded failure)
        (parameterize ([macro-policy (select-policy custom rule-context)])
          ((current-reductions) parsed)))
      (begin0
        (cond [(= version 2)
               (expansion-answer steps binders definites expanded failure stx snapshot requested-phases
                                 #:retain-inspector
                                 (lambda (query)
                                   (retain-inspector
                                    (and query
                                         (lambda (request)
                                           (check-adapter!)
                                           (begin0 (query request) (check-adapter!))))))
                                 #:rule-context rule-context
                                 #:expanded-phases (derivation-phases parsed)
                                 #:relocations (module-relocations parsed)
                                 #:partition partition #:include-renaming? include-renaming?
                                 #:one-term? one-term?
                                 #:syntax-identity syntax-identity
                                 #:suffix-option suffix-option)]
              [else
               (hasheq 'steps (for/list ([step (in-list steps)] #:when (visible-step? step include-renaming?))
                                (step->json step partition #:suffix-option suffix-option))
                       'final (and (syntax? expanded)
                                   (let-values ([(text _ranges) (layout expanded #:partition partition #:suffix-option suffix-option)]) text))
                       'error (and (exn? failure) (exn-message failure)))])
      (check-adapter!)))))
