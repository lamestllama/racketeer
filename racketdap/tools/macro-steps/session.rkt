#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Serve resident worker requests under the memory and answer limits.
(require json racket/port
         "../macro-source.rkt" "printing.rkt" "expansion.rkt" "facts.rkt" "limits.rkt")
(provide run-worker)

(define (validate-request request)
  (unless (and (boolean? (hash-ref request 'includeRenamingSteps #f))
               (boolean? (hash-ref request 'oneTermAtATime #f))
               (member (hash-ref request 'suffixOption "over-limit") '("over-limit" "always")))
    (incompatible "Invalid macro step options."))
  (unless (and (member (hash-ref request 'grouping "macro") '("macro" "all"))
               (exact-positive-integer? (hash-ref request 'nextGroup 1)))
    (incompatible "Invalid foreground numbering."))
  (unless (member (hash-ref request 'schemaVersion 1) '(1 2))
    (incompatible "Unsupported macro steps schema version."))
  (when (= (hash-ref request 'schemaVersion 1) 2)
    (unless (eq? (hash-ref request 'session #f) #t)
      (incompatible "Schema 2 requires an expansion session."))
    (define snapshot (hash-ref request 'snapshot #f))
    (unless (and (hash? snapshot)
                 (string? (hash-ref snapshot 'sourceHash #f))
                 (regexp-match? #px"^[0-9a-f]{64}$" (hash-ref snapshot 'sourceHash))
                 (exact-nonnegative-integer? (hash-ref snapshot 'sourceVersion #f)))
      (incompatible "Schema 2 requires a source hash and document version."))
    (define phases (hash-ref request 'inspectionPhases null))
    (validate-phases phases)))
(define (run-worker request)
  (define out (current-output-port))
  (define expanding? #f)
  (define emitted? #f)
  (define inspector #f)
  (define partition #f)
  (define derivation #f)
  (define captured-syntax #f)
  (define views (make-hash))
  (define (save-view! name) (hash-set! views name (list request partition inspector)))
  (define (restore-view! name)
    (define saved (hash-ref views name (lambda () (incompatible "Unknown stepper view."))))
    (set! request (car saved)) (set! partition (cadr saved)) (set! inspector (caddr saved)))
  (define syntax-identity (make-syntax-identity))
  (define session? (and (= (hash-ref request 'schemaVersion 1) 2) (hash-ref request 'session #f)))
  (define checkpoint-failure #f)
  (define (emit answer)
    (display (answer-text answer) out)
    (newline out)
    (flush-output out)
    (set! emitted? #t))
  (define (checkpoint count)
    (cond
      [session?
       (emit (hasheq 'schemaVersion 2 'mode "checkpoint"
                     'snapshot (hash-ref request 'snapshot) 'count count))
       (define line (read-line (current-input-port) 'any))
       (cond
         [(eof-object? line)
          (set! checkpoint-failure (failure-answer "cancelled" "Expansion cancelled."))
          (error "Expansion cancelled.")]
         [else
          (with-handlers ([exn:fail? (lambda (e)
                                      (set! checkpoint-failure (failure-answer "incompatible" "Invalid checkpoint decision."))
                                      (raise e))])
            (define decision (string->jsexpr line))
            (unless (and (hash? decision)
                         (equal? (hash-ref decision 'mode #f) "checkpointDecision")
                         (equal? (hash-ref decision 'snapshot #f) (hash-ref request 'snapshot))
                         (equal? (hash-ref decision 'count #f) count)
                         (member (hash-ref decision 'decision #f) '("continue" "stop")))
              (error "Invalid checkpoint decision."))
            (string->symbol (hash-ref decision 'decision)))])]
      [else 'stop]))
  (define text
    (with-handlers ([exn:worker? (lambda (e) (answer-text (failure-answer (exn:worker-code e) (exn-message e))))]
                    [exn:fail? (lambda (e) (answer-text (failure-answer (if expanding? "expansion" "source")
                                                                       (if expanding? (exn-message e)
                                                                           (string-append (exn-message e) "\nNo expansion context was obtained.")))))])
      (validate-request request)
      ;; read-json leaves the initial request's line terminator. Consume it
      ;; before tracing, since the first subsequent line may be a decision.
      (when session? (read-line (current-input-port) 'any))
      (set! partition (new-foreground-partition (string->symbol (hash-ref request 'grouping "macro"))
                                              (hash-ref request 'nextGroup 1)))
      (or (call-with-memory-limit
           memory-limit
           (lambda ()
             ;; Compile-time code can print. Only protocol answers use out.
             (parameterize ([current-output-port (open-output-nowhere)])
               (define (expand-request)
                 (set! inspector #f)
                 (define (with-syntax work)
                   (if captured-syntax (work captured-syntax)
                       (call-with-macro-source request
                         (lambda (stx) (set! captured-syntax stx) (work stx)))))
                 (with-syntax
                  (lambda (stx)
                    (set! expanding? #t)
                    (expansion-steps stx (hash-ref request 'hiding "standard")
                                     (hash-ref request 'lines #f)
                                     #:schema-version (hash-ref request 'schemaVersion 1)
                                     #:snapshot (hash-ref request 'snapshot 'null)
                                     #:inspection-phases (hash-ref request 'inspectionPhases null)
                                     #:retain-inspector (lambda (query) (when session? (set! inspector query)))
                                     #:include-renaming? (hash-ref request 'includeRenamingSteps #f)
                                     #:one-term? (hash-ref request 'oneTermAtATime #f)
                                     #:syntax-identity syntax-identity
                                     #:suffix-option (string->symbol (hash-ref request 'suffixOption "over-limit"))
                                     #:custom (hash-ref request 'custom #f)
                                     #:origin (list (hash-ref request 'source) (hash-ref request 'snapshot 'null))
                                     #:partition partition #:derivation derivation
                                     #:checkpoint checkpoint
                                     #:retain-derivation (lambda (value) (set! derivation value))))))
               (define answer (expand-request))
               (cond
                 [session?
                  ;; Retained syntax and every query remain under the SAME
                  ;; custodian ceiling. The host bounds resident sessions and ends
                  ;; hidden ones; EOF/disposal releases this custodian.
                  (save-view! "main")
                  (emit (or checkpoint-failure answer))
                  (when (and inspector (not checkpoint-failure))
                    (let loop ()
                      (when (sync (current-input-port))
                        (define line (read-line (current-input-port) 'any))
                        (unless (eof-object? line)
                          (with-handlers ([exn:fail? (lambda (e) (emit (failure-answer "incompatible" (exn-message e))))])
                            (define query (string->jsexpr line))
                            (unless (equal? (hash-ref query 'snapshot #f) (hash-ref request 'snapshot))
                              (incompatible "Request does not name this expansion snapshot."))
                            (define view (hash-ref query 'view "main"))
                            (restore-view! view)
                            (cond
                              [(equal? (hash-ref query 'mode #f) "duplicate")
                               (define name (hash-ref query 'newView #f))
                               (unless (and (string? name) (<= 1 (string-length name) 200)
                                            (not (hash-has-key? views name)))
                                 (incompatible "Invalid duplicate view identity."))
                               (set! request (hash-set* request
                                                        'hiding (hash-ref query 'hiding "standard")
                                                        'custom (hash-ref query 'custom #f)
                                                        'lines (hash-ref query 'lines #f)
                                                        'includeRenamingSteps (hash-ref query 'includeRenamingSteps #f)
                                                        'oneTermAtATime (hash-ref query 'oneTermAtATime #f)
                                                        'suffixOption "over-limit" 'grouping "macro" 'nextGroup 1))
                               (validate-request request)
                               (set! partition (new-foreground-partition))
                               (emit (expand-request))
                               (save-view! name)]
                              [(equal? (hash-ref query 'mode #f) "closeView")
                               (hash-remove! views view)
                               (set! inspector #f)
                               (when (positive? (hash-count views)) (restore-view! (car (hash-keys views))))
                               (emit (hasheq 'mode "closed"))]
                              [(equal? (hash-ref query 'mode #f) "reexpand")
                               (unless (member (hash-ref query 'hiding #f) '("standard" "none" "line" "custom"))
                                 (incompatible "Invalid hiding policy."))
                               (set! inspector #f)
                               (set! request (hash-set* request 'hiding (hash-ref query 'hiding)
                                                        'lines (hash-ref query 'lines #f)
                                                        'custom (hash-ref query 'custom #f)
                                                        'oneTermAtATime (hash-ref query 'oneTermAtATime (hash-ref request 'oneTermAtATime #f))
                                                        'includeRenamingSteps (hash-ref query 'includeRenamingSteps
                                                                                       (hash-ref request 'includeRenamingSteps #f))))
                               (validate-request request)
                               (emit (expand-request))]
                              [(equal? (hash-ref query 'mode #f) "configure")
                               (define grouping (hash-ref query 'grouping "macro"))
                               (unless (member grouping '("macro" "all")) (incompatible "Invalid foreground grouping."))
                               (set! partition (new-foreground-partition (string->symbol grouping)))
                               (emit (expand-request))]
                              [else (emit (inspector query))])
                            (unless (member (hash-ref query 'mode #f) '("duplicate" "closeView"))
                              (save-view! view)))
                          (loop)))))
                  ""]
                 [else (answer-text answer)]))))
          (answer-text (failure-answer "memory" "Showing these macro steps would need more than 1 GB of memory.")))))
  (unless (and emitted? (equal? text ""))
    (display text out)
    (when session? (newline out))
    (flush-output out)))
