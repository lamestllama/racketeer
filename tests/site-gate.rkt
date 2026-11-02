#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; With the gate closed and no site armed, a site does not enter the debugger, and
;; everything a stop can read must still be there when one happens.
(require rackunit racket/file racket/list
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt"
         "../racketdap/worker/stepping.rkt")

(define (with-program text proc)
  (define program (make-temporary-file "site-gate-~a.rkt"))
  (dynamic-wind
    void
    (lambda ()
      (display-to-file (string-append "#lang racket/base\n" text) program #:exists 'truncate)
      (proc program))
    (lambda () (delete-file program))))
;; Run a program, arming the sites on one line as they load.
(define (run-gated program #:gate [gate (box #f)] #:armed-line [line #f] #:on-event on-event
                   #:on-exception [on-exception #f] #:entry [entry #f])
  (run-module program #:gate gate #:on-event on-event #:on-exception on-exception #:entry entry
              #:on-sites (lambda (sites)
                           (for ([s (in-list sites)] #:when (eqv? (site-line s) line))
                             (arm-site! s #t)))))

(define fib "(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(define result (fib 15))\n")

(module+ test
  (test-case "with the gate closed and nothing armed, nothing enters the debugger"
    (with-program fib
      (lambda (program)
        (define deliveries 0)
        (run-gated program #:on-event (lambda (stop) (set! deliveries (add1 deliveries))))
        (check-equal? deliveries 0))))
  (test-case "an armed site is the only site delivered, at both of its phases"
    (with-program "(define (f x)\n  (add1 x))\n(define a (f 1))\n(define b (add1 a))\n"
      (lambda (program)
        (define lines '())
        (run-gated program #:armed-line 4
                   #:on-event (lambda (stop)
                                (set! lines (cons (cons (site-line (stop-site stop)) (stop-kind stop)) lines))))
        (check-equal? (remove-duplicates (map car lines)) '(4))
        (check-not-false (member '(4 . before) lines))
        (check-not-false (member '(4 . after) lines)))))
  (test-case "opening the gate from a stop delivers later sites, and closing it stops them"
    (with-program "(define (f x) (add1 x))\n(define a (f 1))\n(define b (f 2))\n(define c (f 3))\n"
      (lambda (program)
        (define gate (box #f))
        (define lines '())
        (run-gated program #:gate gate #:armed-line 3
                   #:on-event (lambda (stop)
                                (define line (site-line (stop-site stop)))
                                (set! lines (cons line lines))
                                (cond [(and (= line 3) (eq? (stop-kind stop) 'before)) (set-box! gate #t)]
                                      [(= line 2) (set-box! gate #f)])))
        (check-not-false (memv 2 lines))
        (check-false (memv 4 lines)))))
  (test-case "a stop reached with the gate closed reads every caller's site and variables"
    (with-program
     (string-append
      "(define (down n)\n"
      "  (if (zero? n)\n"
      "      (let ([bottom 'here])\n"
      "        (list bottom))\n"
      "      (cons n\n"
      "            (down (sub1 n)))))\n"
      "(define result (down 3))\n")
     (lambda (program)
       (define seen #f)
       (run-gated program #:armed-line 4
                  #:on-event
                  (lambda (stop)
                    (when (and (not seen) (eq? (stop-kind stop) 'before))
                      (set! seen
                            (for/list ([i (in-range (stop-frame-count stop))])
                              (list (site-line (stop-frame-site stop i))
                                    (cdr (or (assq 'n (stop-locals stop i)) '(#f . none)))))))))
       (check-equal? (take seen 4) '((4 0) (7 1) (7 2) (7 3)))
       (check-equal? (length seen) 5))))
  (test-case "exception stops see the failing site and variables with the gate closed"
    (with-program
     (string-append
      "(provide run)\n"
      "(define (id v) v)\n"
      "(define (helper outer)\n"
      "  (+ (let ([inner 1])\n"
      "       (id inner))\n"
      "     (id outer)\n"
      "     \"not a number\"))\n"
      "(define (run)\n"
      "  (define local 7)\n"
      "  (add1 (helper local)))\n")
     (lambda (program)
       (define found #f)
       (check-exn
        exn:fail:contract?
        (lambda ()
          (run-gated program #:entry 'run
                     #:on-event void
                     #:on-exception
                     (lambda (stop)
                       (set! found
                             (list (site-line (stop-site stop))
                                   (map car (stop-locals stop))
                                   (cdr (assq 'local (stop-locals stop 1)))
                                   (stop-frame-count stop)))))))
       ;; The + spans lines 5-8 of the file; the completed (id outer) has given way to it.
       (check-equal? found (list 5 '(outer) 7 2)))))
  (test-case "step out from a stop reached with the gate closed finds the caller's completion"
    (with-program
     (string-append
      "(define (inner x)\n"
      "  (add1 x))\n"
      "(define (outer y)\n"
      "  (* 2 (inner y)))\n"
      "(define result (outer 1))\n")
     (lambda (program)
       (define gate (box #f))
       (define command #f)
       (define landed #f)
       (run-gated program #:gate gate #:armed-line 3
                  #:on-event
                  (lambda (stop)
                    (cond
                      [(and command (step-reason command stop))
                       (unless landed
                         (set! landed (list (site-line (stop-site stop)) (stop-kind stop) (stop-results stop))))
                       (set! command #f)
                       (set-box! gate #f)]
                      [(and (not landed) (not command) (eq? (stop-kind stop) 'before))
                       (set! command (make-step 'stepOut stop))
                       (set-box! gate #t)])))
       (check-equal? landed '(5 after (2))))))
  (test-case "a closed site allocates nothing: a call's cost does not grow with its sites"
    (define (bytes-per-iteration body)
      (with-program
       (string-append
        "(provide run)\n"
        "(define (spin n)\n"
        "  (let loop ([i 0])\n"
        "    (if (< i n) (loop (add1 " body ")) i)))\n"
        "(define (run)\n"
        "  (define before (current-memory-use 'cumulative))\n"
        "  (spin 100000)\n"
        "  (/ (- (current-memory-use 'cumulative) before) 100000.0))\n")
       (lambda (program)
         (run-gated program #:entry 'run #:on-event void))))
    (define few (bytes-per-iteration "i"))
    (define many (bytes-per-iteration "(sub1 (add1 (sub1 (add1 (sub1 (add1 i))))))"))
    (check-true (< many 300) (format "~a bytes per iteration" many))
    (check-true (< (- many few) 16) (format "~a and ~a bytes per iteration" few many))))
