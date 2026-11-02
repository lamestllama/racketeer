#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Re-entering a continuation shares a call's frame but not its variables. What a stop
;; reads and assigns must be the variables of the continuation it stopped in.
(require rackunit racket/file racket/list racket/runtime-path racket/string
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt")

(define-runtime-path runtime "../racketdap/instrumentation/runtime.rkt")
(define (with-program text proc)
  (define program (make-temporary-file "continuation-reentry-~a.rkt"))
  (dynamic-wind
    void
    (lambda ()
      (display-to-file (string-append "#lang racket/base\n" text) program #:exists 'truncate)
      (proc program))
    (lambda () (delete-file program))))
(define preamble
  (string-append
   "(provide run)\n"
   "(define tag (make-continuation-prompt-tag))\n"
   "(define saved #f)\n"
   "(define first? #t)\n"
   "(define (capture v) (call-with-composable-continuation (lambda (k) (set! saved k) v) tag))\n"
   "(define (again v) (when first? (set! first? #f) (saved v)))\n"
   "(define (run) (call-with-continuation-prompt body tag))\n"))
;; The line of the marker comment in a program, counting the #lang line.
(define (line-of text marker)
  (add1 (for/first ([line (in-list (string-split (string-append "#lang racket/base\n" text) "\n"))]
                    [i (in-naturals)]
                    #:when (string-contains? line marker))
          i)))
;; Reads x at each stop before the marked line, checking Evaluate agrees, and assigns it
;; at the second stop. Returns what was read and the program's result.
(define (read-and-assign text)
  (define line (sub1 (line-of text ";; reads x")))
  (with-program text
    (lambda (program)
      (define seen '())
      (define result
        (run-module
         program #:entry 'run
         #:on-event
         (lambda (stop)
           (when (and (eq? (stop-kind stop) 'before) (= (site-line (stop-site stop)) line))
             (define value (cdr (assq 'x (stop-locals stop))))
             (set! seen (append seen (list value)))
             (check-equal? (stop-evaluate stop 'x) value)
             (check-equal? (stop-binding-value stop 'x) value)
             (when (= (length seen) 2) (stop-set-binding! stop 'x 11))))))
      (list seen result))))

(module+ test
  (test-case "each return of an initializer has its own variable at a stop"
    (check-equal?
     (read-and-assign
      (string-append
       preamble
       "(define (body)\n"
       "  (let ([x (capture 1)])\n"
       "    (again 2)\n"
       "    (list x)\n"
       "    ;; reads x\n"
       "    (list x)))\n"))
     ;; The inner return reaches the stop first with 2; the assignment is to the outer's.
     '((2 1) (11))))
  (test-case "a definition's variable is its own after re-entry, in any part of a long body"
    (for ([before '(0 15 16 30)])
      (check-equal?
       (read-and-assign
        (string-append
         preamble
         "(define (body)\n"
         (string-join (for/list ([i (in-range before)]) (format "  (define v~a ~a)" i i)) "\n") "\n"
         "  (define x (capture 1))\n"
         "  (define later x)\n"
         (string-join (for/list ([i (in-range 40)]) (format "  (define w~a ~a)" i i)) "\n") "\n"
         "  (again 2)\n"
         "  (list later)\n"
         "  ;; reads x\n"
         "  (list x))\n"))
       '((2 1) (11)))))
  (test-case "a call re-entered through another call shows each return's own variable"
    (define text
      (string-append
       preamble
       "(define (reenter) (again 2) 'done)\n"
       "(define (body)\n"
       "  (let ([x (capture 1)])\n"
       "    (reenter)\n"
       "    (list x)\n"
       "    ;; reads x\n"
       "    (list x)))\n"))
    (define line (sub1 (line-of text ";; reads x")))
    (with-program text
      (lambda (program)
        (define inner #f)
        (check-equal?
         (run-module
          program #:entry 'run
          #:on-event
          (lambda (stop)
            (when (and (not inner) (eq? (stop-kind stop) 'before)
                       (= (site-line (stop-site stop)) line))
              (set! inner
                    (for/list ([i (in-range (stop-frame-count stop))]
                               #:do [(define x (assq 'x (stop-locals stop i)))]
                               #:when x)
                      (cdr x))))))
         '(1))
        (check-equal? inner '(2 1)))))
  (test-case "a scope's mark keeps a host boundary sharing its continuation"
    (define text
      (format
       (string-append
        "(require (only-in (file ~s) context-key))\n"
        "(provide run)\n"
        "(define (run)\n"
        "  (define x 1)\n"
        "  (with-continuation-mark context-key 'host-boundary\n"
        "    (let ([y 2])\n"
        "      (list x y))))\n")
       (path->string runtime)))
    (with-program text
      (lambda (program)
        (define found? #f)
        (check-equal?
         (run-module program #:entry 'run
                     #:on-event
                     (lambda (stop)
                       (when (and (eq? (stop-kind stop) 'before) (= (site-line (stop-site stop)) 8))
                         (set! found? #t)
                         (check-not-false (memq 'host-boundary (stop-contexts stop)))
                         (check-true (stop-within? stop 'host-boundary)))))
         '(1 2))
        (check-true found?))))
  (test-case "one call's nested scopes count as one frame, showing the innermost"
    (with-program
     (string-append
      "(provide run)\n"
      "(define (run)\n"
      "  (let ([a 1])\n"
      "    (add1\n"
      "     (let ([b 2])\n"
      "       (add1\n"
      "        (let ([c 3])\n"
      "          (list a b c)\n"
      "          (+ a b c)))))))\n")
     (lambda (program)
       (define seen #f)
       (check-equal?
        (run-module program #:entry 'run
                    #:on-event
                    (lambda (stop)
                      (when (and (not seen) (eq? (stop-kind stop) 'before)
                                 (= (site-line (stop-site stop)) 9))
                        (set! seen (list (stop-frame-count stop) (map car (stop-locals stop)))))))
        8)
       (check-equal? seen '(1 (c b a)))))))
