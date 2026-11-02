#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; A cached program must not outlive a change to where its requires resolve. The file a
;; link used to find stays current, so its hash cannot show that the link has moved.
(require rackunit racket/file "../racketdap/worker/load.rkt")

;; A project with two versions of a collection, and a program that uses its macro.
(define (with-project proc)
  (define directory (make-temporary-file "debug-cache-links-~a" 'directory))
  (dynamic-wind
    void
    (lambda ()
      (for ([version '(one two)])
        (make-directory (build-path directory (symbol->string version)))
        (display-to-file
         (format "#lang racket/base\n(provide answer)\n(define-syntax-rule (answer) '~a)\n" version)
         (build-path directory (symbol->string version) "main.rkt")))
      (define program (build-path directory "main.rkt"))
      (display-to-file
       "#lang racket/base\n(require probe-lib)\n(provide run)\n(define (run) (answer))\n"
       program)
      (proc directory
            (lambda links
              (parameterize ([current-library-collection-links
                              (append links (current-library-collection-links))])
                (run-module program #:entry 'run #:cache-directory (build-path directory "cache"))))))
    (lambda () (delete-directory/files directory))))

(module+ test
  (test-case "a link file sent elsewhere runs the new target, not the cached macro"
    (with-project
     (lambda (directory execute)
       (define links (build-path directory "links.rktd"))
       (define (link! version)
         (call-with-output-file links #:exists 'truncate
           (lambda (out)
             (write (list (list "probe-lib" (path->string (build-path directory version)))) out))))
       (link! "one")
       (check-equal? (execute links) 'one)
       (check-equal? (execute links) 'one "the same link reuses its entry")
       ;; The change must show whatever the date on the file says.
       (define date (file-or-directory-modify-seconds links))
       (link! "two")
       (file-or-directory-modify-seconds links date)
       (check-equal? (execute links) 'two))))
  (test-case "a link table in memory sent elsewhere runs the new target"
    (with-project
     (lambda (directory execute)
       (define (table version) (hasheq 'probe-lib (list (build-path directory version))))
       (check-equal? (execute (table "one")) 'one)
       (check-equal? (execute (table "two")) 'two)
       (check-equal? (execute (table "one")) 'one))))
  (test-case "a link file that appears is a change, as is one that goes"
    (with-project
     (lambda (directory execute)
       (define links (build-path directory "links.rktd"))
       (define table (hasheq 'probe-lib (list (build-path directory "one"))))
       ;; The link file, when there is one, comes first.
       (define (execute-both) (execute links table))
       (check-equal? (execute-both) 'one)
       (call-with-output-file links
         (lambda (out)
           (write (list (list "probe-lib" (path->string (build-path directory "two")))) out)))
       (check-equal? (execute-both) 'two)
       (delete-file links)
       (check-equal? (execute-both) 'one)))))
