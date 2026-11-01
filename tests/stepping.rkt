#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/runtime-path racket/list racket/file
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt"
         "../racketdap/worker/stepping.rkt")
(define-runtime-path fixtures "fixtures")
(module+ test
  (test-case "callback steps without an observable caller reach the next source expression"
    (define program (make-temporary-file "callback-step-~a.rkt"))
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
         "#lang racket/base\n(define (callback x) (* (+ x 1) 2))\n"
         program #:exists 'truncate)
        (for ([mode '(next stepOut)])
          (define command #f)
          (define found? #f)
          (run-module
           program
           #:on-ready (lambda (namespace)
                        (parameterize ([current-namespace namespace])
                          (check-equal? (eval '(callback 7)) 16)))
           #:on-event
           (lambda (stop)
             (cond
               [(and command (step-reason command stop))
                (check-equal? (site-expression (stop-site stop)) '(#%app + x '1))
                (set! found? #t)
                (set! command #f)]
               [(and (not found?) (eq? (stop-kind stop) 'before)
                     (equal? (site-expression (stop-site stop)) '(#%app * (#%app + x '1) '2)))
                (check-false (stop-token stop))
                (check-false (stop-return-token stop))
                (set! command (make-step mode stop))])))
          (check-true found?)))
      (lambda () (delete-file program))))
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
  (test-case "step into a function reaches its initializer before step over returns it"
    (define command #f)
    (define stages '())
    (run-module
     (build-path fixtures "locals.rkt") #:entry 'run
     #:on-event
     (lambda (stop)
       (cond
         [(and command (step-reason command stop))
          (case (length stages)
            [(1)
             (check-equal? (site-line (stop-site stop)) 6)
             (check-equal? (site-expression (stop-site stop)) '(#%app * subtotal rate))
             (check-equal? (stop-evaluate stop 'subtotal) 100)
             (set! stages (cons 'initializer stages))
             (set! command (make-step 'next stop))]
            [(2)
             (check-equal? (stop-kind stop) 'after)
             (check-equal? (site-line (stop-site stop)) 6)
             (check-equal? (stop-results stop) '(10))
             (set! stages (cons 'result stages))
             (set! command (make-step 'next stop))]
            [(3)
             (check-equal? (stop-kind stop) 'before)
             (check-equal? (site-line (stop-site stop)) 7)
             (set! stages (cons 'body stages))
             (set! command #f)])]
         [(and (null? stages) (eq? (stop-kind stop) 'before)
               (equal? (site-expression (stop-site stop)) '(#%app price '100 '1/10)))
          (set! stages '(call))
          (set! command (make-step 'stepIn stop))])))
    (check-equal? stages '(body result initializer call)))
  (test-case "explicit binding forms keep their source stop and uninitialized locals"
    (define found? #f)
    (run-module
     (build-path fixtures "uninitialized.rkt") #:entry 'run
     #:on-event
     (lambda (stop)
       (when (and (eq? (stop-kind stop) 'before)
                  (eq? (car (site-expression (stop-site stop))) 'letrec-values))
         (check-equal? (site-line (stop-site stop)) 4)
         (set! found? #t))
       (when (and (eq? (stop-kind stop) 'before)
                  (equal? (site-expression (stop-site stop)) '(#%app + '1 '2)))
         (check-true (unavailable? (cdr (assq 'x (stop-locals stop))))))))
    (check-true found?))
  (test-case "hidden binding containers retain the failing activation and its locals"
    (define program (make-temporary-file "binding-frame-~a.rkt"))
    (define found? #f)
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
         (string-append "#lang racket/base\n(provide run)\n"
                        "(define (run)\n (define earlier 10)\n"
                        " (define x y)\n (define y 1)\n (+ earlier x y))\n")
         program #:exists 'truncate)
        (check-exn
         exn:fail:contract:variable?
         (lambda ()
           (run-module
            program #:entry 'run
            #:on-exception
            (lambda (stop)
              (set! found? #t)
              (check-equal? (stop-kind stop) 'exception)
              (check-equal? (stop-frame-count stop) 1)
              (check-equal? (site-line (stop-site stop)) 3)
              (check-equal? (cdr (assq 'earlier (stop-locals stop))) 10)))))
        (check-true found?))
      (lambda () (delete-file program))))
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
