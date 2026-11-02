#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Which stops a program has and where a press lands, read as source text.
(require rackunit racket/file racket/format racket/list racket/port racket/string
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt"
         "../racketdap/worker/stepping.rkt")

(define (with-program text use)
  (define directory (make-temporary-file "step-stops-~a" 'directory))
  (dynamic-wind
    void
    (lambda ()
      (define program (build-path directory "program.rkt"))
      (display-to-file text program)
      (use program))
    (lambda () (delete-directory/files directory))))

;; A stop as a person reads it: before and the source text, or after and the value.
(define ((stop-row text) stop)
  (define descriptor (stop-site stop))
  (define source
    (substring text (sub1 (site-position descriptor))
               (+ (sub1 (site-position descriptor)) (site-span descriptor))))
  (case (stop-kind stop)
    [(before) (list 'before source)]
    [else (list* 'after source (map shown (stop-results stop)))]))
;; A procedure's printed name holds the temporary file's path.
(define (shown value) (if (procedure? value) "#<procedure>" (~s value)))

;; Every stop a program reaches when each press is Step, with the program's results.
(define (stops text #:language [language #f])
  (with-program
   text
   (lambda (program)
     (define rows '())
     (define row (stop-row text))
     (parameterize ([current-output-port (open-output-nowhere)])
       (run-module program #:language language
                   #:on-event (lambda (stop) (set! rows (cons (row stop) rows)))))
     (reverse rows))))
;; The stop at which the first stop matching at is reached, then where each press in
;; presses lands, starting from it.
(define (presses text at modes)
  (with-program
   text
   (lambda (program)
     (define rows '())
     (define row (stop-row text))
     (define command #f)
     (define started? #f)
     (define remaining modes)
     (define (press! stop)
       (cond
         [(null? remaining) (set! command #f)]
         [else
          (set! command (make-step (car remaining) stop))
          (set! remaining (cdr remaining))]))
     (run-module
      program
      #:on-event
      (lambda (stop)
        (cond
          [(not started?)
           (when (equal? (row stop) at)
             (set! started? #t)
             (press! stop))]
          [(and command (step-reason command stop))
           (set! rows (cons (row stop) rows))
           (press! stop)])))
     (check-true started? (format "never reached ~s" at))
     (reverse rows))))

(module+ test
  (test-case "a function expression returned from a body is as atomic as any other"
    (check-equal?
     (stops (string-append
             "#lang racket/base\n"
             "(define (make) (lambda (x) x))\n"
             "(define (make-with) (define y 1) (lambda (x) (+ x y)))\n"
             "(define (make-case) (case-lambda [(x) x] [(x y) y]))\n"
             "(void (make) (make-with) (make-case))\n"))
     '((before "(void (make) (make-with) (make-case))")
       (before "(make)") (after "(make)" "#<procedure>")
       (before "(make-with)") (after "(make-with)" "#<procedure>")
       (before "(make-case)") (after "(make-case)" "#<procedure>")
       (after "(void (make) (make-with) (make-case))" "#<void>"))))
  (test-case "a function expression standing alone in a module body keeps its stops"
    (check-equal?
     (map car (stops "#lang racket/base\n(lambda (w) w)\n"))
     '(before after)))
  (test-case "a function called from the body still has its stops"
    (check-equal?
     (stops "#lang racket/base\n(define (make) (lambda (x) (add1 x)))\n(void ((make) 1))\n")
     '((before "(void ((make) 1))") (before "((make) 1)") (before "(make)")
       (after "(make)" "#<procedure>")
       (before "(add1 x)")
       (after "((make) 1)" "2")
       (after "(void ((make) 1))" "#<void>"))))
  (test-case "a definition has the same stops in a plain file as in a module"
    (define body
      (string-append
       "(define (v x) x)\n"
       "(define (f a)\n  (+ (v a) 1))\n"
       "(define g (lambda (y) y))\n"
       "(define c (case-lambda [(p) p] [(p q) q]))\n"
       "(define-values (m n) (values 1 2))\n"
       "(define o (let ([w 1]) (v w)))\n"
       "(f 1)\n"
       "(define z (f 2))\n"
       "(v z)\n"
       "(begin (v 1) (define k (v 2)) (v k))\n"
       "m\n"
       "(g 1)\n"))
    (define as-module (stops (string-append "#lang racket/base\n" body)))
    ;; The language line holds no code, so the two read the same text from line two.
    (define as-file (stops body #:language 'racket/base))
    (check-equal? as-file as-module)
    (check-false (findf (lambda (row) (string-prefix? (cadr row) "(define (")) as-file))))
