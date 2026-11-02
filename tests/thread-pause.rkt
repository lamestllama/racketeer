#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file "../racketdap/instrumentation/runtime.rkt" "../racketdap/worker/load.rkt")

;; What Evaluate gives for a parameter in a suspended thread, once the thread has run
;; `start` with the program's procedures and reached (blocked ready) or a blocked closure.
(define (evaluate-while-suspended start)
  (define program (make-temporary-file "thread-pause-~a.rkt"))
  (display-to-file
   (string-append
    "#lang racket/base\n"
    "(define p (make-parameter 'first))\n"
    "(define (touch) (void))\n"
    "(define (blocked ready) (semaphore-post ready) (sync never-evt))\n"
    "(define (make-blocked ready) (lambda () (blocked ready)))\n")
   program #:exists 'truncate)
  (define result #f)
  (dynamic-wind
    void
    (lambda ()
      (run-module
       program #:gate (box #f)
       #:on-ready
       (lambda (namespace)
         (define ready (make-semaphore))
         (define (program-value name) (eval name namespace))
         (define target (thread (lambda () (start program-value ready))))
         (dynamic-wind
           void
           (lambda ()
             (semaphore-wait ready)
             (call-with-thread-stop
              target
              (lambda (stop) (set! result (stop-evaluate stop '(p))))))
           (lambda () (kill-thread target))))))
    (lambda () (delete-file program)))
  result)

(module+ test
  (test-case "Evaluate in a suspended thread sees parameters set beyond its nearest prompt"
    (check-equal?
     (evaluate-while-suspended
      (lambda (program-value ready)
        ((program-value 'touch))
        (parameterize ([(program-value 'p) 'second])
          (call-with-continuation-prompt (lambda () ((program-value 'blocked) ready))))))
     'second))
  (test-case "Evaluate in a suspended thread sees the parameters of the call, not of the closure"
    (check-equal?
     (evaluate-while-suspended
      (lambda (program-value ready)
        (define blocked ((program-value 'make-blocked) ready))
        (parameterize ([(program-value 'p) 'second])
          (call-with-continuation-prompt blocked))))
     'second))
  (test-case "Evaluate in a suspended thread sees parameters set inside its nearest prompt"
    (check-equal?
     (evaluate-while-suspended
      (lambda (program-value ready)
        (parameterize ([(program-value 'p) 'outer])
          (call-with-continuation-prompt
           (lambda ()
             (parameterize ([(program-value 'p) 'inner])
               ((program-value 'blocked) ready)))))))
     'inner))
  (test-case "a suspended thread without source frames resumes after inspection fails"
    (define gate (make-semaphore))
    (define target (thread (lambda () (semaphore-wait gate))))
    (define saved #f)
    (dynamic-wind
      void
      (lambda ()
        (check-exn
         #rx"inspection failed"
         (lambda ()
           (call-with-thread-stop
            target
            (lambda (stop)
              (set! saved stop)
              (check-false (thread-running? target))
              (check-equal? (stop-frame-count stop) 0)
              (check-true (stop-approximate? stop))
              (error "inspection failed")))))
        (check-true (thread-running? target))
        (check-exn #rx"expired" (lambda () (stop-frame-count saved)))
        (semaphore-post gate)
        (check-eq? (sync/timeout 2 target) target))
      (lambda () (kill-thread target))))

  (test-case "a debugger critical section is resumed without exposing a stop"
    (define ready (make-semaphore))
    (define gate (make-semaphore))
    (define target
      (thread (lambda ()
                (with-continuation-mark debugger-active-key #t
                  (begin (semaphore-post ready) (semaphore-wait gate))))))
    (semaphore-wait ready)
    (dynamic-wind
      void
      (lambda ()
        (check-false (call-with-thread-stop target (lambda (_) (error "must retry"))))
        (check-true (thread-running? target))
        (semaphore-post gate)
        (check-eq? (sync/timeout 2 target) target))
      (lambda () (kill-thread target))))

  (test-case "inspection does not take ownership of an existing suspension"
    (define gate (make-semaphore))
    (define target (thread (lambda () (semaphore-wait gate))))
    (thread-suspend target)
    (dynamic-wind
      void
      (lambda ()
        (check-true (call-with-thread-stop target (lambda (stop) (check-equal? (stop-kind stop) 'pause))))
        (check-false (thread-running? target)))
      (lambda () (kill-thread target)))))
