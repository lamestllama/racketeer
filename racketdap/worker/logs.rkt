#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/async-channel "../log-filter.rkt")
(provide make-application-log application-log-logger application-log-flush! application-log-filter!)

(struct application-log (logger commands))
(define (make-application-log filter emit)
  (define logger (make-logger #f (current-logger)))
  (define receiver (apply make-log-receiver logger (parse-log-filter filter)))
  (define commands (make-async-channel))
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
  (thread
   (lambda ()
     (let loop ([deadline (+ (current-inexact-monotonic-milliseconds) 100)])
       (define command (sync/timeout 0 commands))
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
          (async-channel-put (vector-ref command 2) #t)
          (loop (+ (current-inexact-monotonic-milliseconds) 100))]
         [else
          (define remaining (- deadline (current-inexact-monotonic-milliseconds)))
          (cond
            [(<= remaining 0) (flush!) (loop (+ (current-inexact-monotonic-milliseconds) 100))]
            [else
             (define entry (sync/timeout (min 0.01 (/ remaining 1000)) receiver))
             (when entry (append! entry))
             (loop deadline)])]))))
  (application-log logger commands))

(define (request! log filter [final? #f])
  (define response (make-async-channel))
  (async-channel-put (application-log-commands log) (vector filter final? response))
  (async-channel-get response)
  (void))
(define (application-log-flush! log #:final? [final? #f]) (request! log #f final?))
(define (application-log-filter! log filter) (request! log (parse-log-filter filter)))
