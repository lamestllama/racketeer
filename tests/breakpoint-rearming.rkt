#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; The program keeps running while another file's breakpoints change. A breakpoint that
;; has not changed must be armed at every moment of that, or the program can pass it.
(require rackunit racket/async-channel racket/file
         "../racketdap/protocol.rkt"
         "../racketdap/instrumentation/runtime.rkt"
         "../racketdap/worker/load.rkt"
         "../racketdap/worker/session.rkt")

(define target-text
  (string-append
   "#lang racket/base\n"
   "(provide run)\n"
   "(define (run proceed finished)\n"
   "  (semaphore-wait proceed)\n"
   "  (add1 1)\n"
   "  (semaphore-post finished))\n"))
(define breakpoint-line 5)

;; A session on the target program. Arming goes through the descriptor's vector and the
;; program reads the vector underneath, so a descriptor can report the moment its site is
;; disarmed and hold the session there, which is a thread switch the program may meet.
(define (with-session proc)
  (define directory (make-temporary-file "breakpoint-rearming-~a" 'directory))
  (define source (build-path directory "main.rkt"))
  (define other (build-path directory "other.rkt"))
  (display-to-file target-text source)
  (display-to-file "#lang racket/base\n(void)\n" other)
  (define proceed (make-semaphore))
  (define finished (make-semaphore))
  (define ready (make-semaphore))
  (define disarmed (make-semaphore))
  (define resume-session (make-semaphore))
  (define watching? #f)
  (define (watch-disarming site)
    (define armed (site-armed site))
    (define flags (car armed))
    (set-site-armed!
     site
     (cons (impersonate-vector
            flags
            (lambda (_ i value) value)
            (lambda (_ i value)
              (when (and watching? (not value))
                (vector-set! flags i value)
                (set! watching? #f)
                (semaphore-post disarmed)
                (semaphore-wait resume-session))
              value))
           (cdr armed))))
  (define run-program
    (make-keyword-procedure
     (lambda (keywords arguments path)
       (define options (for/hasheq ([k (in-list keywords)] [v (in-list arguments)]) (values k v)))
       (define namespace (make-base-namespace))
       (define-values (compiled plain _select _finish)
         (make-debug-loader
          namespace source
          #:on-sites (lambda (sites)
                       ((hash-ref options '#:on-sites) sites)
                       (for ([s (in-list sites)] #:when (= breakpoint-line (site-line s)))
                         (watch-disarming s)))
          #:on-event (hash-ref options '#:on-event)
          #:on-source-snapshot (hash-ref options '#:on-source-snapshot)
          #:on-thread (hash-ref options '#:on-thread)
          #:gate (hash-ref options '#:gate)))
       (parameterize ([current-namespace namespace]
                      [current-load/use-compiled compiled]
                      [current-load plain])
         (define run (dynamic-require source 'run))
         (set! watching? #t)
         (semaphore-post ready)
         (run proceed finished)))))
  (define owner (make-custodian))
  (dynamic-wind
    void
    (lambda ()
      (parameterize ([current-custodian owner])
        (define-values (input requests) (make-pipe))
        (define-values (messages output) (make-pipe))
        (define incoming (make-async-channel))
        (thread (lambda () (let loop () (async-channel-put incoming (read-message messages)) (loop))))
        (thread (lambda ()
                  (serve-session input output
                                 (hasheq 'program (path->string source) 'cwd (path->string directory)
                                         'debugCache #f)
                                 (hasheq) run-program)))
        (define sequence 0)
        (define (request! command arguments)
          (set! sequence (add1 sequence))
          (write-message (hasheq 'seq sequence 'command command 'arguments arguments) requests))
        (define (is-response? message)
          (and (equal? (hash-ref message 'type #f) "response")
               (= sequence (hash-ref message 'request_seq -1))))
        (define (next-message)
          (or (sync/timeout 10 incoming) (error "no message from the session")))
        (define (await-response)
          (let loop ()
            (define message (next-message))
            (if (is-response? message) message (loop))))
        (define (set-breakpoints! path lines)
          (request! "setBreakpoints"
                    (hasheq 'source (hasheq 'path (path->string path))
                            'breakpoints (for/list ([line (in-list lines)]) (hasheq 'line line)))))
        (set-breakpoints! source (list breakpoint-line))
        (await-response)
        (request! "configurationDone" (hasheq))
        (await-response)
        (semaphore-wait ready)
        (proc #:source source #:other other #:incoming incoming #:await-response await-response
              #:set-breakpoints! set-breakpoints! #:is-response? is-response? #:disarmed disarmed
              #:resume-session resume-session #:proceed proceed #:finished finished)))
    (lambda ()
      (custodian-shutdown-all owner)
      (delete-directory/files directory))))

(module+ test
  (test-case "another file's breakpoints leave an unchanged breakpoint armed throughout"
    (with-session
     (lambda (#:source source #:other other #:incoming incoming #:await-response await-response
              #:set-breakpoints! set-breakpoints! #:is-response? is-response? #:disarmed disarmed
              #:resume-session resume-session #:proceed proceed #:finished finished)
       (set-breakpoints! other '(2))
       ;; Either the session reports a disarmed moment, and the program runs in it, or it
       ;; finishes the request without one.
       (define disarmed-moment?
         (let loop ()
           (define next (sync/timeout 10 (wrap-evt disarmed (lambda (_) 'disarmed)) incoming))
           (cond
             [(not next) (error "the request did not finish")]
             [(eq? next 'disarmed) #t]
             [(is-response? next) #f]
             [else (loop)])))
       (semaphore-post proceed)
       (when disarmed-moment?
         (define passed? (sync/timeout 3 finished))
         (semaphore-post resume-session)
         (check-false passed? "the program passed its breakpoint"))
       (define stopped
         (let loop ()
           (define message (or (sync/timeout 5 incoming) (error "the breakpoint was missed")))
           (if (equal? (hash-ref message 'event #f) "stopped") message (loop))))
       (check-equal? (hash-ref (hash-ref stopped 'body) 'reason) "breakpoint"))))
  (test-case "a removed breakpoint comes off, and the program runs past it"
    (with-session
     (lambda (#:source source #:other other #:incoming incoming #:await-response await-response
              #:set-breakpoints! set-breakpoints! #:is-response? is-response? #:disarmed disarmed
              #:resume-session resume-session #:proceed proceed #:finished finished)
       (set-breakpoints! source '())
       (check-not-false (sync/timeout 10 disarmed) "the site stayed armed")
       (semaphore-post resume-session)
       (await-response)
       (semaphore-post proceed)
       (check-not-false (sync/timeout 10 finished))
       (check-false
        (let loop ()
          (define message (sync/timeout 0.2 incoming))
          (cond
            [(not message) #f]
            [(equal? (hash-ref message 'event #f) "stopped") #t]
            [else (loop)])))))))
