#lang racket/base
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
