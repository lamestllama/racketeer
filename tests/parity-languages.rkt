#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require "support/events.rkt" rackunit racket/file racket/port racket/string
         "../racketdap/worker/load.rkt" "../racketdap/instrumentation/instrument.rkt")
(define (with-program text proc)
  (define directory (make-temporary-file "parity-language-~a" 'directory))
  (define program (build-path directory "target.rkt"))
  (dynamic-wind void
    (lambda () (display-to-file text program) (proc program directory))
    (lambda () (delete-directory/files directory))))
(define (capture program instrument? #:language [language #f] #:on-entry [on-entry void])
  (with-output-to-string
    (lambda () (run-module program #:instrument? instrument? #:language language
                          #:on-event (before-events (lambda (_) #t) on-entry)))))
(module+ test
  (for ([language '("scheme/base" "scheme" "typed/racket/base" "typed/racket" "htdp/asl" "htdp/bsl")])
    (test-case (string-append "runtime stops in " language)
      (with-program
       (string-append "#lang " language "\n"
                      (if (string-prefix? language "typed/") "(: answer (-> Integer Integer))\n" "")
                      "(define (answer x) (+ x 1))\n(answer 4)\n")
       (lambda (program directory)
         (define seen? #f)
         (define normal (capture program #f))
         (define debug
           (capture program #t #:on-entry
                    (lambda (stop)
                      (when (assq 'x (stop-locals stop))
                        (set! seen? #t)
                        (check-equal? (stop-evaluate stop 'x) 4)))))
         (check-equal? debug normal)
         (check-true seen?)))))
  (test-case "nested alternative-language modules retain bindings and source stops"
    (with-program
     "#lang racket/base\n(module nested scheme/base (provide answer) (define (answer x) (+ x 1)))\n(require 'nested)\n(displayln (answer 4))\n"
     (lambda (program directory)
       (define seen? #f)
       (check-equal?
        (capture program #t #:on-entry
                 (lambda (stop)
                   (when (assq 'x (stop-locals stop))
                     (set! seen? #t) (check-equal? (stop-evaluate stop 'x) 4))))
        (capture program #f))
       (check-true seen?))))
  (test-case "custom module language preserves expansion effects and module bindings"
    (with-program
     "#lang s-exp \"language.rkt\"\n(require (for-syntax racket/base))\n(begin-for-syntax (displayln 'phase))\n(define-syntax (twice stx) (displayln 'expand) #'(+ secret secret))\n(define secret 9)\n(displayln (twice))\n"
     (lambda (program directory)
       (display-to-file
        "#lang racket/base\n(provide (all-from-out racket/base))\n"
        (build-path directory "language.rkt"))
       (define normal (capture program #f))
       (define seen? #f)
       (check-equal?
        (capture program #t #:on-entry
                 (lambda (stop)
                   (when (equal? (site-line (stop-site stop)) 6)
                     (set! seen? #t)
                     (void))))
        normal)
       (check-true seen?))))
  (test-case "module languages retain the caller context for implicit identifiers"
    (with-program
     "#lang s-exp \"language.rkt\"\n(define (entry) (define x 7) (displayln (+ x 1)))\n"
     (lambda (program directory)
       (display-to-file
        (string-append
         "#lang racket/base\n(require (for-syntax racket/base))\n"
         "(provide (except-out (all-from-out racket/base) #%module-begin)\n"
         "         (rename-out [start-module #%module-begin]))\n"
         "(define-syntax (start-module stx)\n"
         "  (syntax-case stx ()\n"
         "    [(_ form ...)\n"
         "     (with-syntax ([entry (datum->syntax stx 'entry)])\n"
         "       #'(#%module-begin form ... (entry)))]))\n")
        (build-path directory "language.rkt"))
       (define seen? #f)
       (check-equal?
        (capture program #t #:on-entry
                 (lambda (stop)
                   (when (assq 'x (stop-locals stop))
                     (set! seen? #t)
                     (check-equal? (stop-evaluate stop 'x) 7))))
        (capture program #f))
       (check-true seen?))))
  (test-case "shared contract lifts precede both definitions and bare expressions"
    (with-program
     (string-append
      "#lang racket/base\n(require racket/contract \"predicate.rkt\")\n"
      "(define (answer n) (+ n 1))\n"
      "(provide/contract [answer (-> accept? any)])\n"
      "(displayln ((contract (-> accept? any) answer 'positive 'negative) 7))\n")
     (lambda (program directory)
       (display-to-file
        (string-append
         "#lang racket/base\n(require racket/contract)\n"
         "(provide (contract-out [accept? (-> any/c boolean?)]))\n"
         "(define (accept? v) (integer? v))\n")
        (build-path directory "predicate.rkt"))
       (check-equal? (capture program #f) "8\n")
       (check-equal? (capture program #t) "8\n"))))
  (test-case "macro-time module loads retain declaration bindings"
    (for ([phase '(1 2)])
      (with-program
       (string-append
        "#lang racket/base\n(require (for-syntax racket/base) (for-meta 2 racket/base))\n"
        (if (= phase 2) "(begin-for-syntax\n" "")
        "(define-syntax (answer stx)\n"
        "  (define get (dynamic-require\n"
        "               (build-path (current-load-relative-directory) \"dependency.rkt\") 'answer))\n"
        "  (datum->syntax stx (get)))\n"
        "(displayln (answer))\n"
        (if (= phase 2) ")\n" ""))
       (lambda (program directory)
         (display-to-file
          "#lang racket/base\n(provide answer)\n(define (answer) 42)\n"
          (build-path directory "dependency.rkt"))
         (for ([instrument? '(#f #t)])
           (check-equal?
            (with-output-to-string
              (lambda ()
                (run-module program #:instrument? instrument?
                            #:source-roots (list directory))))
            "42\n"))))))
  (test-case "plain files loaded by another plain file retain their own source identity"
    (with-program
     "(load (build-path (current-load-relative-directory) \"helper.rkt\"))\n(displayln (answer 4))\n"
     (lambda (program directory)
       (define helper (build-path directory "helper.rkt"))
       (display-to-file "(define (answer x) (+ x 1))\n" helper)
       (define seen? #f)
       (define out
         (with-output-to-string
           (lambda ()
             (run-module program #:language 'racket/base #:sources (list helper)
                         #:on-event
                         (before-events
                          (lambda (_) #t)
                          (lambda (stop)
                            (when (assq 'x (stop-locals stop))
                              (set! seen? #t)
                              (check-equal? (site-source (stop-site stop)) helper))))))))
       (check-equal? out "5\n")
       (check-true seen?))))
  (test-case "non-module definitions, macros, live cells, and interaction namespace"
    (with-program
     "(require (for-syntax racket/base))\n(begin-for-syntax (displayln 'phase))\n(define-syntax-rule (inc x) (+ x 1))\n(define module-value 3)\n(define (answer x) (+ (inc x) module-value))\n(displayln (answer 4))\n"
     (lambda (program directory)
       (define seen? #f)
       (define normal (capture program #f #:language 'racket/base))
       (define debug
         (capture program #t #:language 'racket/base #:on-entry
                  (lambda (stop)
                    (when (assq 'x (stop-locals stop))
                      (set! seen? #t)
                      (check-equal? (stop-evaluate stop 'module-value) 3)
                      (check-equal? (stop-evaluate stop 'x) 4)))))
       (check-equal? debug normal)
       (check-true seen?)))))
