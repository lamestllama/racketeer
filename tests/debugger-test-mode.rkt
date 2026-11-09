#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/file racket/port racket/runtime-path
         "../racketdap/worker/load.rkt")

(define-runtime-path checkpoint-suite "macro-stepper-checkpoint.rkt")
(define-runtime-path tests-root ".")
(define-runtime-path experiments-root "../experiments")

(define (debug-tests program)
  (define owner (make-custodian))
  (define summary #f)
  (define failure #f)
  (dynamic-wind
    void
    (lambda ()
      (define worker
        (parameterize ([current-custodian owner])
          (thread
           (lambda ()
             (with-handlers ([exn? (lambda (e) (set! failure e))])
               (run-module program #:test? #t #:gate (box #f)
                           #:source-roots (list tests-root experiments-root)
                           #:on-test-event
                           (lambda (event)
                             (when (equal? (hash-ref event 'kind) "summary")
                               (set! summary event)))))))))
      ;; Catch a nonterminating resource probe before it exhausts the process.
      ;; The limit only names a hang: coverage on a slow machine takes longer.
      (check-not-false (sync/timeout 60 (thread-dead-evt worker)))
      (when failure (raise failure))
      summary)
    (lambda () (custodian-shutdown-all owner))))

(module+ test
  (test-case "debugging allocation resource checks terminates"
    (define summary (debug-tests checkpoint-suite))
    (check-equal? (hash-ref summary 'status) "passed")
    (check-equal? (hash-ref summary 'total) 5))

  (test-case "debugging a test with an ordinary file binding"
    (define program (make-temporary-file "debug-test-binding-~a.rkt"))
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
         (string-append
          "#lang racket/base\n(require rackunit racket/runtime-path)\n"
          "(define-runtime-path file \"sample.rkt\")\n"
          "(module+ test (test-case \"file binding\" (check-true (path? file))))\n")
         program #:exists 'truncate)
        (define summary (debug-tests program))
        (check-equal? (hash-ref summary 'status) "passed")
        (check-equal? (hash-ref summary 'total) 1))
      (lambda () (delete-file program))))

  (test-case "an error in a child thread leaves the rest of the suite running"
    (define program (make-temporary-file "debug-test-thread-~a.rkt"))
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
         (string-append
          "#lang racket/base\n(require rackunit)\n"
          "(module+ test\n"
          "  (test-case \"child fails\" (sync (thread (lambda () (error 'child \"boom\")))) (check-true #t))\n"
          "  (test-case \"later\" (check-true #t)))\n")
         program #:exists 'truncate)
        (define summary
          (parameterize ([current-error-port (open-output-nowhere)])
            (debug-tests program)))
        (check-equal? (hash-ref summary 'status) "passed")
        (check-equal? (hash-ref summary 'total) 2))
      (lambda () (delete-file program)))))
