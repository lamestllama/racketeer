#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/promise racket/string
         "../racketdap/tools/macro-steps/expansion.rkt"
         (submod "../racketdap/tools/macro-steps/expansion.rkt" test-support)
         "../racketdap/tools/macro-steps/internal-error.rkt"
         "../racketdap/tools/macro-steps/printing.rkt")
(module+ test
  (define stx #'(let ([x 1]) x))
  (define (check-stage stage)
    (define inspector #f)
    (define original (exn:fail "test detail marker" (current-continuation-marks)))
    (define summary
      (parameterize ([(if (eq? stage 'steps) current-reductions current-parse-derivation)
                      (lambda (_) (raise original))]
                     [current-namespace (make-base-namespace)])
        (expansion-steps stx "none" #:schema-version 2
                         #:retain-inspector (lambda (query) (set! inspector query)))))
    (check-equal? (hash-ref summary 'error) "internal")
    (define p (inspector (hasheq 'mode "position" 'position 1)))
    (define d (hash-ref (hash-ref p 'diagnostics) 'internal))
    (check-equal? (hash-ref d 'message)
                  (if (eq? stage 'steps) "Macro stepper error (steps) [details].  Original syntax:\n"
                      "Macro stepper error (derivation) [details].  \n"))
    (check-equal? (hash? (hash-ref d 'program)) (eq? stage 'steps))
    (define reported #f)
    (define details
      (parameterize ([error-display-handler
                      (lambda (message exception)
                        (check-eq? exception original)
                        (check-eq? (exn-continuation-marks exception) (exn-continuation-marks original))
                        (set! reported #t)
                        (display message (current-error-port)))])
        (inspector (hasheq 'mode "internalDetails"))))
    (check-true reported)
    (check-equal? (hash-ref details 'report) "test detail marker")
    (check-equal? (hash-ref details 'message) "Internal error:\ntest detail marker")
    (check-true (string-contains? (hash-ref details 'diagnostic) "Recorded expansion events"))
    (check-true (string-contains? (hash-ref details 'diagnostic) "test detail marker"))
    (check-true (string-contains? (hash-ref details 'diagnostic) "Stack context")))
  (check-stage 'derivation)
  (check-stage 'steps)
  (for ([value (list 'unexpected (exn:fail "long\nmessage" (current-continuation-marks))
                           (let/ec escape (exn:break "interrupted" (current-continuation-marks) escape)))])
    (define query #f)
    (internal-error-answer 'derivation value stx #f 'null (lambda (q) (set! query q)) (new-foreground-partition))
    (define d (hash-ref (hash-ref (query (hasheq 'mode "position" 'position 1)) 'diagnostics) 'internal))
    (check-equal? (hash-ref d 'details) (exn? value))
    (unless (exn? value) (check-false (string-contains? (hash-ref d 'message) "[details]")))
    (when (exn? value) (check-false (hash-ref (query (hasheq 'mode "internalDetails")) 'diagnostic)))
    (when (exn:break? value) (check-equal? (hash-ref d 'message) "Macro stepper was interrupted (derivation) [details].  \n")))
  (parameterize ([current-namespace (make-base-namespace)])
    (define summary (expansion-steps #'(if) "none" #:schema-version 2))
    (check-not-equal? (hash-ref summary 'error) "internal")))
