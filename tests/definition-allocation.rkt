#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; A debugger must not change what a program computes. A body's definitions keep the
;; allocation they have without the debugger, however long the body is: a variable is
;; made when its initialiser returns, once for each time it returns. Each program here
;; runs both ways and must give the same answer.
(require rackunit racket/file racket/list racket/string
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt")

(define (with-program text proc)
  (define program (make-temporary-file "definition-allocation-~a.rkt"))
  (dynamic-wind
    void
    (lambda ()
      (display-to-file (string-append "#lang racket/base\n(provide run)\n" text) program #:exists 'truncate)
      (proc program))
    (lambda () (delete-file program))))
(define (outcome program instrument?)
  (with-handlers ([exn:fail? (lambda (e) (list 'raised (exn-message e)))])
    (run-module program #:entry 'run #:instrument? instrument? #:gate (box #f) #:on-event void)))
;; The answer is the expected one, with the debugger and without.
(define (check-same text expected)
  (with-program text
    (lambda (program)
      (check-equal? (outcome program #f) expected "without the debugger")
      (check-equal? (outcome program #t) expected "with the debugger"))))

;; Definitions that fill out a body, each using the one before.
(define (filler from to)
  (string-join
   (for/list ([i (in-range from to)])
     (format "  (define v~a (add1 ~a))" i (if (= i from) 0 (format "v~a" (sub1 i)))))
   "\n"))
(define prompt-preamble
  (string-append
   "(define tag (make-continuation-prompt-tag))\n"
   "(define saved #f)\n"
   "(define first? #t)\n"
   "(define (capture v) (call-with-composable-continuation (lambda (k) (set! saved k) v) tag))\n"
   "(define (again v) (when first? (set! first? #f) (saved v)))\n"
   "(define (run) (call-with-continuation-prompt body tag))\n"))
;; A body with `before` definitions ahead of the one that returns twice and `after` behind it.
(define (returns-twice before after)
  (string-append
   prompt-preamble
   "(define (body)\n"
   (filler 0 before) "\n"
   "  (define x (capture 1))\n"
   "  (define (read-x) x)\n"
   "  (define (bump-x!) (set! x (+ x 10)))\n"
   (filler before (+ before after)) "\n"
   "  (define later (list x))\n"
   "  (define (read-later) later)\n"
   "  (again 2)\n"
   "  (bump-x!)\n"
   "  (list x (read-x) later (read-later)))\n"))

(module+ test
  (test-case "a definition's variable is made when its initialiser returns"
    (check-same
     (string-append
      prompt-preamble
      "(define (body)\n"
      "  (define x (capture 1))\n"
      "  (again 2)\n"
      "  (list x))\n")
     '(1)))
  (test-case "each return of an initialiser makes new variables for what follows"
    ;; The inner return's assignment and later definitions stay out of the outer return's.
    (check-same (returns-twice 0 0) '(11 11 (1) (1))))
  (test-case "a function with no definitions before or after still returns its own variable"
    (check-same
     (string-append
      prompt-preamble
      "(define (body)\n"
      "  (let-values ([(a b) (values (capture 1) 'other)])\n"
      "    (again 2)\n"
      "    (list a b)))\n")
     '(1 other)))
  (test-case "allocation is kept wherever a long body moves its definitions out of line"
    (for* ([before '(0 3 14 15 16 17 40)] [after '(0 1 15 16 40)])
      (check-same (returns-twice before after) '(11 11 (1) (1)))))
  (test-case "a long body's later parts share its earlier variables"
    (check-same
     (string-append
      "(define-syntax-rule (define-hidden v) (begin (define x v) (define (read-hidden) x)))\n"
      "(define (run)\n"
      "  (define shared 1)\n"
      "  (define (read-shared) shared)\n"
      "  (define (even-up? n) (or (zero? n) (odd-up? (sub1 n))))\n"
      "  (define (odd-up? n) (and (positive? n) (even-up? (sub1 n))))\n"
      "  (define-values (left right) (values 'left 'right))\n"
      "  (define (keyworded #:k k) (list k shared))\n"
      "  (define replaced (lambda () 'original))\n"
      "  (define x 'visible)\n"
      (filler 0 40) "\n"
      "  (set! shared (+ shared v39))\n"
      "  (set! replaced (lambda () 'replacement))\n"
      "  (define (set-shared! v) (set! shared v))\n"
      (string-join (for/list ([i (in-range 40 80)]) (format "  (define v~a (add1 v~a))" i (sub1 i))) "\n") "\n"
      "  (list shared (read-shared) (even-up? 12) (odd-up? 11) left right\n"
      "        (keyworded #:k 'k) (replaced) x v79\n"
      "        (begin (set-shared! 'set) (read-shared))))\n")
     (list 41 41 #t #t 'left 'right '(k 41) 'replacement 'visible 80 'set)))
  (test-case "an assigned keyword procedure from an earlier part is not taken for a constant"
    (check-same
     (string-append
      "(define (run)\n"
      "  (define (keyworded #:k k) (list 'original k))\n"
      "  (define (replace!) (set! keyworded (lambda (#:k k) (list 'replacement k))))\n"
      (filler 0 40) "\n"
      "  (replace!)\n"
      "  (keyworded #:k v39))\n")
     '(replacement 40)))
  (test-case "a variable read before its definition fails the same way in any part"
    (define text
      (string-append
       "(define (run)\n"
       (filler 0 40) "\n"
       "  (define early (late))\n"
       (string-join (for/list ([i (in-range 40 80)]) (format "  (define v~a (add1 v~a))" i (sub1 i))) "\n") "\n"
       "  (define (late) v79)\n"
       "  early)\n"))
    (with-program text
      (lambda (program)
        (define (message instrument?) (cadr (outcome program instrument?)))
        (check-regexp-match #rx"late: undefined" (message #f))
        (check-equal? (message #t) (message #f)))))
  (test-case "an initialiser returning the wrong number of values fails the same way in any part"
    (define text
      (string-append
       "(define (run)\n"
       (filler 0 40) "\n"
       "  (define-values (a b) (values v39))\n"
       "  (list a b))\n"))
    (with-program text
      (lambda (program)
        (check-equal? (outcome program #t) (outcome program #f)))))
  (test-case "a long body's tail call replaces its frame"
    (with-program
     (string-append
      "(define (run) (loop 2000))\n"
      "(define (loop n)\n"
      (filler 0 40) "\n"
      "  (if (zero? n)\n"
      "      (add1 v39)\n"
      "      (loop (sub1 n))))\n")
     (lambda (program)
       (define frames #f)
       (define line (+ 2 2 40 2))
       (define result
         (run-module program #:entry 'run #:gate (box #f)
                     #:on-sites (lambda (sites)
                                  (for ([s (in-list sites)] #:when (eqv? (site-line s) line))
                                    (arm-site! s #t)))
                     #:on-event (lambda (stop)
                                  (unless frames (set! frames (stop-frame-count stop))))))
       (check-equal? result 41)
       (check-true (and frames (< frames 4)) (format "~a frames" frames)))))
  (test-case "a stop in a long body's last part shows and assigns its first part's variables"
    (with-program
     (string-append
      "(define (run)\n"
      "  (define first-variable 1)\n"
      "  (define (read-first) first-variable)\n"
      (filler 0 40) "\n"
      "  (define inner-result\n"
      "    (add1 first-variable))\n"
      "  (list first-variable (read-first) inner-result))\n")
     (lambda (program)
       (define line (+ 2 3 40 2))
       (define seen #f)
       (define result
         (run-module program #:entry 'run #:gate (box #f)
                     #:on-sites (lambda (sites)
                                  (for ([s (in-list sites)] #:when (eqv? (site-line s) line))
                                    (arm-site! s #t)))
                     #:on-event
                     (lambda (stop)
                       (when (and (not seen) (eq? (stop-kind stop) 'before))
                         (set! seen (stop-locals stop))
                         (check-equal? (stop-evaluate stop 'first-variable) 1)
                         (stop-set-binding! stop 'first-variable 100)))))
       (check-equal? (cdr (assq 'first-variable seen)) 1)
       (check-equal? (cdr (assq 'v39 seen)) 40)
       (check-equal? (length seen) 42)
       (check-equal? result '(100 100 101)))))
  (test-case "an exception in a long body's last part shows its first part's variables"
    (with-program
     (string-append
      "(define (run)\n"
      "  (define first-variable 1)\n"
      (filler 0 40) "\n"
      "  (car first-variable))\n")
     (lambda (program)
       (define locals #f)
       (check-exn
        exn:fail:contract?
        (lambda ()
          (run-module program #:entry 'run #:gate (box #f) #:on-event void
                      #:on-exception (lambda (stop) (set! locals (stop-locals stop))))))
       (check-equal? (cdr (assq 'first-variable locals)) 1)
       (check-equal? (cdr (assq 'v39 locals)) 40))))
  (test-case "a coverage run of a long body gives the same answer and visits its last part"
    (with-program
     (string-append
      "(define (run)\n"
      (filler 0 40) "\n"
      "  v39)\n")
     (lambda (program)
       (define visited (make-hasheqv))
       (check-equal?
        (run-module program #:entry 'run #:coverage? #t
                    #:on-event (lambda (visit) (hash-set! visited (site-line visit) #t)))
        40)
       (check-true (hash-ref visited (+ 3 40 1) #f))))))
