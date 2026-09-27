#lang racket/base
(require rackunit racket/runtime-path racket/list
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt"
         "../racketdap/worker/stepping.rkt")
(define-runtime-path fixtures "fixtures")
(module+ test
  (for ([name '("semantics.rkt" "reentry.rkt" "cross-thread.rkt" "tail.rkt" "racket-forms.rkt")])
    (test-case (format "completion instrumentation preserves ~a" name)
      (define (execute events)
        (call-with-values
         (lambda () (run-module (build-path fixtures name) #:entry 'run #:on-event events)) list))
      (define max-depth 0)
      (check-equal? (execute (lambda (s) (set! max-depth (max max-depth (stop-frame-count s)))))
                    (execute #f))
      (when (equal? name "tail.rkt") (check-true (<= max-depth 3)))))
  (test-case "step over completes the exact expression and exposes its results"
    (define command #f)
    (define found #f)
    (run-module
     (build-path fixtures "locals.rkt") #:entry 'run
     #:on-event
     (lambda (stop)
       (cond
         [(and command (step-reason command stop))
          (check-equal? (step-reason command stop) "Expression returned")
          (check-equal? (stop-results stop) '(10))
          (set! found #t) (set! command #f)]
         [(and (not found) (eq? (stop-kind stop) 'before)
               (equal? (site-expression (stop-site stop)) '(#%app * subtotal rate)))
          (set! command (make-step 'next stop))])))
    (check-true found))
  (test-case "step out follows the actual non-tail call's return context"
    (define command #f)
    (define found #f)
    (run-module
     (build-path fixtures "shadowing.rkt") #:entry 'run
     #:on-event
     (lambda (stop)
       (cond
         [(and command (step-reason command stop))
          (check-equal? (step-reason command stop) "Expression returned")
          (check-equal? (stop-results stop) '(11))
          (set! found #t) (set! command #f)]
         [(and (not found) (eq? (stop-kind stop) 'before)
               (equal? (site-expression (stop-site stop)) '(#%app + value '1)))
          (set! command (make-step 'stepOut stop))])))
    (check-true found))
  (test-case "continuation escape abandons the exact step target"
    (define command #f)
    (define reason #f)
    (check-equal?
     (run-module
      (build-path fixtures "step-escape.rkt") #:entry 'run
      #:on-event
      (lambda (stop)
        (cond
          [(and command (step-reason command stop))
           (set! reason (step-reason command stop)) (set! command #f)]
          [(and (not reason) (eq? (stop-kind stop) 'before)
                (equal? (site-expression (stop-site stop)) '(#%app escape '40)))
           (set! command (make-step 'next stop))])))
     42)
    (check-equal? reason "Control transferred outside the step target")))
