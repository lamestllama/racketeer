#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/file racket/path "../racketdap/tools/macro-source.rkt")

(define (request text #:mode [mode "fragment"] #:prefix [prefix ""]
                 #:source [source "untitled:Untitled-1"] #:directory [directory (current-directory)]
                 #:cwd [cwd directory])
  (hasheq 'text text 'mode mode 'prefix prefix 'source (if (path? source) (path->string source) source)
          'sourceIsFile (path? source) 'directory (path->string directory) 'cwd (path->string cwd)))
(define (expanded input) (syntax->datum (call-with-macro-source input expand)))

(module+ test
  (test-case "selection locations retain Unicode, CRLF and tab coordinates"
    (define stx (read-macro-source (request "(or #f 42)" #:prefix "; 😀\r\n\tλ ")))
    (check-equal? (syntax-source stx) "untitled:Untitled-1")
    (check-equal? (syntax-line stx) 2)
    (check-equal? (syntax-column stx) 10)
    (check-equal? (syntax-position stx) 8))

  (test-case "multiple selected forms expand without evaluating them"
    (define result (expanded (request "(+ 21 21)\n(error \"runtime ran\")")))
    (check-equal? (car result) 'begin)
    (check-not-false (member '(#%app + (quote 21) (quote 21)) result)))

  (test-case "whitespace and comments contain no forms"
    (for ([text '("  \n\t" "; comment\n#;(+ 1 2)")])
      (check-exn #rx"contains no Racket forms" (lambda () (read-macro-source (request text))))))

  (test-case "read errors include the original source line"
    (check-exn #rx"untitled:Untitled-1:3:2"
               (lambda () (read-macro-source (request "(" #:prefix "\n\n  ")))))

  (test-case "fragments do not inherit module bindings or previous expansions"
    (expanded (request "(define-syntax-rule (private-macro) 42)"))
    (check-equal? (expanded (request "(private-macro)")) '(#%app (#%top . private-macro))))

  (test-case "fragment reader rejects embedded language directives"
    (check-exn #rx"#lang.*not enabled" (lambda () (read-macro-source (request "#lang racket/base\n42")))))

  (test-case "whole-file requires one module"
    (for ([text '("(+ 1 2)" "(module a racket/base) (module b racket/base)")])
      (check-exn #rx"single #lang or module" (lambda () (read-macro-source (request text #:mode "module"))))))

  (test-case "module expansion uses captured buffer and relative imports without runtime execution"
    (define directory (make-temporary-file "racketeer-macro-~a" 'directory))
    (dynamic-wind
      void
      (lambda ()
        (define source (build-path directory "dirty λ😀.rkt"))
        (call-with-output-file source #:exists 'truncate (lambda (out) (display "not the buffer" out)))
        (call-with-output-file (build-path directory "support.rkt")
          (lambda (out)
            (display "#lang racket/base\n(provide answer)\n(define-syntax-rule (answer) 42)\n(error \"import runtime ran\")\n" out)))
        (define result
          (expanded (request "#lang racket/base\n(require \"support.rkt\")\n(define result (answer))\n(error \"module runtime ran\")\n(module+ main (error \"main ran\"))\n"
                             #:source source #:mode "module" #:directory directory
                             #:cwd (find-system-path 'temp-dir))))
        (check-equal? (car result) 'module)
        (check-not-false (member '(define-values (result) (quote 42)) (cadddr result)))
        (check-equal? (file->string source) "not the buffer"))
      (lambda () (delete-directory/files directory))))

  (test-case "expansion executes transformer code exactly once"
    (define directory (make-temporary-file "racketeer-macro-phase-~a" 'directory))
    (dynamic-wind
      void
      (lambda ()
        (define marker (build-path directory "phase.txt"))
        (expanded (request
                   (format "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ~s #:exists 'append (lambda (out) (display \"once\" out))))\n(error \"runtime ran\")\n" (path->string marker))
                   #:mode "module"))
        (check-equal? (file->string marker) "once"))
      (lambda () (delete-directory/files directory))))

  (test-case "module expansion errors retain buffer source locations"
    (check-exn #rx"untitled:Untitled-1:3:1"
               (lambda () (expanded (request "#lang racket/base\n\n(missing-macro)\n" #:mode "module"))))))
