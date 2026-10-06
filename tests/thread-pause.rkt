#lang racket/base
(require rackunit "../racketdap/instrumentation/runtime.rkt")

(module+ test
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
