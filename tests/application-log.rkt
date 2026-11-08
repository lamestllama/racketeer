#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/runtime-path "../racketdap/worker/logs.rkt")
(define-runtime-path logs "../racketdap/worker/logs.rkt")
(module+ test
  (test-case "idle logger waits for commands and retains bounded flush and filter behavior"
    (define batches '())
    (define log
      (parameterize ([current-logger (make-logger)])
        (make-application-log "error" (lambda (batch) (set! batches (cons batch batches))))))
    (dynamic-wind void
      (lambda ()
        ;; Once every runnable thread is blocked, a command must already be
        ;; among the logger's waiting events; no timer or log entry wakes it.
        (sync (system-idle-evt))
        (define commands
          ((parameterize ([current-namespace (module->namespace logs)])
             (eval 'application-log-commands)) log))
        (define response (make-semaphore))
        (check-not-false (sync/timeout 0 (channel-put-evt commands (vector #f #f response))))
        (sync response)
        (check-equal? batches '())
        (define logger (application-log-logger log))
        (check-false (log-level? logger 'info))
        (application-log-filter! log "info")
        ;; Every row must be accounted for even if periodic batches interleave.
        (for ([i (in-range 10000)]) (log-message logger 'info (number->string i) #f))
        (application-log-flush! log)
        (check-equal? (apply + (map (lambda (batch) (+ (length (hash-ref batch 'entries))
                                                     (hash-ref batch 'dropped))) batches)) 10000)
        (check-true (andmap (lambda (batch) (<= (length (hash-ref batch 'entries)) 1000)) batches))
        (set! batches '())
        (log-message logger 'error "queued before filter" #f)
        (application-log-filter! log "none")
        (check-equal? (map (lambda (entry) (hash-ref entry 'message))
                           (apply append (map (lambda (batch) (hash-ref batch 'entries)) (reverse batches))))
                      '("queued before filter"))
        (set! batches '())
        ;; Receiver subscriptions are weak; the old filter remains visible to
        ;; log-level? until its receiver is collected.
        (collect-garbage)
        (check-false (log-level? logger 'fatal))
        (application-log-flush! log #:final? #t)
        (check-equal? batches '())
        (application-log-filter! log "error")
        (log-message logger 'error "final message" #f)
        (application-log-flush! log #:final? #t)
        (check-equal? (map (lambda (entry) (hash-ref entry 'message))
                           (apply append (map (lambda (batch) (hash-ref batch 'entries)) batches)))
                      '("final message")))
      (lambda () (application-log-close! log)))))
