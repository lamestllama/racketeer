#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require "../log-filter.rkt")
(provide make-application-log application-log-logger application-log-flush! application-log-filter! application-log-close!)

(struct application-log (logger commands services worker))
(define (make-application-log filter emit)
  (define logger (make-logger #f (current-logger)))
  (define receiver (apply make-log-receiver logger (parse-log-filter filter)))
  (define commands (make-channel))
  (define services (make-custodian))
  (define entries (make-vector 1000 #f))
  (define start 0)
  (define count 0)
  (define bytes 0)
  (define dropped 0)
  (define (remove-first!)
    (set! bytes (- bytes (cdr (vector-ref entries start))))
    (vector-set! entries start #f)
    (set! start (modulo (add1 start) 1000))
    (set! count (sub1 count))
    (set! dropped (add1 dropped)))
  (define (bounded text limit)
    (if (> (string-length text) limit) (string-append (substring text 0 limit) "… [truncated]") text))
  (define (append! entry)
    (define message (bounded (vector-ref entry 1) 16384))
    (define topic (and (vector-ref entry 3) (bounded (symbol->string (vector-ref entry 3)) 1024)))
    (define size (+ (bytes-length (string->bytes/utf-8 message))
                    (if topic (bytes-length (string->bytes/utf-8 topic)) 0)))
    (let trim ()
      (when (or (= count 1000) (> (+ bytes size) (* 1024 1024))) (remove-first!) (trim)))
    (vector-set! entries (modulo (+ start count) 1000)
                 (cons (hasheq 'level (symbol->string (vector-ref entry 0))
                               'message message 'topic topic) size))
    (set! bytes (+ bytes size))
    (set! count (add1 count)))
  (define (flush! [discarded-backlog? #f])
    (when (or (positive? count) (positive? dropped) discarded-backlog?)
      (define batch
        (for/list ([i (in-range count)])
          (define at (modulo (+ start i) 1000))
          (define value (car (vector-ref entries at)))
          (vector-set! entries at #f)
          value))
      (emit (hasheq 'entries batch 'dropped dropped 'discardedBacklog discarded-backlog?))
      (set! start 0) (set! count 0) (set! bytes 0) (set! dropped 0)))
  (define worker
    (parameterize ([current-custodian services])
      (thread
       (lambda ()
         (let loop ([deadline (+ (current-inexact-monotonic-milliseconds) 100)] [pending-command #f])
           (define command (or pending-command (sync/timeout 0 commands)))
           (cond
             [command
              ;; Include already queued messages, but keep control requests responsive
              ;; if another program thread is continuously logging.
              (let drain ([remaining 10000])
                (when (positive? remaining)
                  (define entry (sync/timeout 0 receiver))
                  (when entry (append! entry) (drain (sub1 remaining)))))
              (define filter (vector-ref command 0))
              (define final? (vector-ref command 1))
              (flush! (and (or filter final?) (sync/timeout 0 receiver) #t))
              (when filter
                (set! receiver (apply make-log-receiver logger filter)))
              (semaphore-post (vector-ref command 2))
              (loop (+ (current-inexact-monotonic-milliseconds) 100) #f)]
             [else
              (define remaining (- deadline (current-inexact-monotonic-milliseconds)))
              (cond
                [(<= remaining 0) (flush!) (loop (+ (current-inexact-monotonic-milliseconds) 100) #f)]
                [else
                 (define selected
                   (sync (handle-evt commands (lambda (command) (cons 'command command)))
                         (handle-evt receiver (lambda (entry) (cons 'entry entry)))
                         (alarm-evt deadline #t)))
                 (cond
                   [(and (pair? selected) (eq? (car selected) 'command))
                    (loop deadline (cdr selected))]
                   [(pair? selected) (append! (cdr selected)) (loop deadline #f)]
                   [else (loop deadline #f)])])]))))))
  (application-log logger commands services worker))

(define (application-log-close! log)
  (custodian-shutdown-all (application-log-services log)))
(define (request! log filter [final? #f])
  (define response (make-semaphore))
  (define closed
    (handle-evt (thread-dead-evt (application-log-worker log))
                (lambda (_) (error 'application-log "closed"))))
  (sync (channel-put-evt (application-log-commands log) (vector filter final? response)) closed)
  (sync response closed)
  (void))
(define (application-log-flush! log #:final? [final? #f]) (request! log #f final?))
(define (application-log-filter! log filter) (request! log (parse-log-filter filter)))
