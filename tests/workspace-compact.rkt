#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/file racket/list racket/path racket/runtime-path racket/set
         "../vscode/language-adapters.rkt"
         racket-langserver/doclib/doc
         racket-langserver/doclib/doc-trace
         racket-langserver/doclib/doc-lang)

(define-runtime-path analysis "../vscode/workspace-analysis.rkt")
(dynamic-require analysis #f)
(define analysis-namespace (module->namespace analysis))
(define (get name)
  (parameterize ([current-namespace analysis-namespace]) (eval name)))
(define (with-project proc)
  (define root (make-temporary-file "workspace-compact~a" 'directory))
  (dynamic-wind void (lambda () (proc root)) (lambda () (delete-directory/files root))))
(define (put root name text)
  (define file (build-path root name))
  (make-directory* (path-only file))
  (display-to-file text file #:exists 'replace)
  file)
(define plain "#lang racket/base\n(provide value)\n(define value 1)\n(value)\n")
(define (pass root text)
  ((get 'answer) (list 'analyse (build-path root "program.rkt") 1048576 text #f
                       (hash) (list root) (hash)) void))
(define (normal datum)
  (list (car datum)
        (for/hash ([entry (in-list (cadr datum))]) (values (car entry) (list->set (cdr entry))))
        (make-immutable-hash (caddr datum))))
(define (old root text)
  (parameterize ([current-namespace (make-base-namespace)] [current-language-adapter-roots (list root)]
                 [current-directory root] [current-load-relative-directory root])
    (define doc (make-doc ((get 'path->uri) (build-path root "program.rkt")) text))
    (check-true (doc-expand! doc #:contribution-only? #t))
    ((get 'contribution->datum) (Doc-contribution doc))))
(define (compile-time body)
  (string-append "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax " body ")\n"))

(module+ test
  (test-case "compact analysis constructs no display trace and enables no expansion log receiver"
    (with-project
     (lambda (root)
       (parameterize ([current-extra-service-factories
                       (hasheq 'probe (lambda args (error 'display "display trace constructed")))]
                      [current-logger (make-logger #f #f)])
         (define result
           (pass root (string-append
                       (compile-time
                        "(when (log-level? (current-logger) 'info 'compact-probe) (error 'logs \"expansion logs retained\"))")
                       "(define value 1)\nvalue\n")))
         (check-equal? (car result) 'ok (format "~s" result))
         (check-true (positive? (list-ref result 3)))))))

  (test-case "out of memory while reading or expanding reaches the worker controller"
    (with-project
     (lambda (root)
       (define reader
         (put root "reader.rkt"
              "#lang racket/base\n(provide (rename-out [source-read read-syntax]))\n(define (source-read src in) (raise (exn:fail:out-of-memory \"read allocation\" (current-continuation-marks))))\n"))
       (for ([text (list (format "#reader (file ~s)\n" (path->string reader))
                         (compile-time "(raise (exn:fail:out-of-memory \"expand allocation\" (current-continuation-marks)))"))])
         (check-equal? (pass root text) '(out-of-memory)))
       (for ([text '("#lang racket/base\n(" "#lang racket/base\nmissing\n")])
         (define result (pass root text))
         (check-equal? (car result) 'failed)
         (check-regexp-match #rx"analysis failed:" (cdr result))))))

  (test-case "selection precedes expansion and an explicit off policy prevents expansion"
    (with-project
     (lambda (root)
       (put root ".racketeer/language-adapters.rktd"
            "((profile (match (language racket/base)) (editor (expand? #f))))")
       (define expanded (build-path root "expanded"))
       (define result
         (pass root (compile-time (format "(call-with-output-file ~s void)" (path->string expanded)))))
       (check-equal? (car result) 'failed)
       (check-false (file-exists? expanded)))))

  (test-case "failed expansion has already selected the descriptor policy"
    (with-project
     (lambda (root)
       (put root ".racketeer/language-adapters.rktd"
            "((profile (match (language racket/base)) (editor (body-mode non-sexp) (expand? #t))))")
       (define selected (build-path root "selected"))
       (define observed #f)
       (define result
         (parameterize ([current-language-adapter-observer
                         (lambda (_ adapter)
                           (set! observed adapter)
                           (put root "selected" "selected"))])
           (pass root (compile-time
                       (format "(unless (file-exists? ~s) (raise (exn:fail:out-of-memory \"policy selected too late\" (current-continuation-marks)))) (error 'source \"ordinary expansion failure\")"
                               (path->string selected))))))
       (check-equal? (car result) 'failed)
       (check-regexp-match #rx"analysis failed:" (cdr result))
       (check-not-false observed)
       (check-equal? (hash-ref (hash-ref observed 'editor) 'body-mode) 'non-sexp))))

  (for ([kind '(descriptor provider)])
    (test-case (format "a ~a edit during blocked expansion cannot be current" kind)
      (with-project
       (lambda (root)
         (define descriptor
           (put root ".racketeer/language-adapters.rktd"
                "((profile (match (language racket/base)) (bindings (expanded+ #((file \"provider.rkt\") bindings #f)))))"))
         (define provider
           (put root ".racketeer/provider.rkt"
                "#lang racket/base\n(provide bindings)\n(define (bindings request data) (hasheq))\n"))
         (define blocked (build-path root "blocked"))
         (define released (build-path root "released"))
         (define result #f)
         (define worker
           (thread
            (lambda ()
              (set! result
                    (pass root (compile-time
                                (format "(call-with-output-file ~s void) (let wait () (unless (file-exists? ~s) (sleep 0.01) (wait)))"
                                        (path->string blocked) (path->string released))))))))
         (dynamic-wind void
           (lambda ()
             (define ready
               (sync/timeout 30
                 (thread (lambda () (let wait () (unless (or (file-exists? blocked) (thread-dead? worker))
                                                   (sleep 0.01) (wait)))))))
             (check-not-false ready "expansion must reach its barrier")
             (check-true (file-exists? blocked) (format "~s" result))
             (call-with-output-file (if (eq? kind 'descriptor) descriptor provider) newline #:exists 'append)
             (put root "released" "released")
             (check-not-false (sync/timeout 30 worker))
             (check-equal? (car result) 'failed)
             (check-regexp-match #rx"analysis failed:" (cdr result)))
           (lambda () (kill-thread worker)))))))

  (test-case "compact contributions retain component ranges and phase keys and omit provider predictions"
    (with-project
     (lambda (root)
       (put root ".racketeer/language-adapters.rktd"
            "((profile (match (language racket/base)) (bindings (expanded+ #((file \"provider.rkt\") bindings #f)))))")
       (put root ".racketeer/provider.rkt"
            (string-append
             "#lang racket/base\n(provide bindings)\n(define (bindings request data)\n"
             " (define names (hash-ref (hash-ref request 'facts) 'names))\n"
             " (define use (for/first ([name (in-list names)] #:when (and (eq? (hash-ref name 'role) 'use) (eq? (syntax-e (hash-ref name 'identifier)) 'value))) name))\n"
             " (define r (hash-ref use 'range))\n"
             " (define comment (caar (regexp-match-positions #rx\"spare\" (hash-ref request 'text))))\n"
             " (hasheq 'names (list (hash-set* use 'range (cons (add1 (car r)) (cdr r)) 'space 'components) (hash-set* use 'range (cons comment (+ comment 5)) 'certainty 'predicted))))\n"))
       (define text (string-append plain "; spare\n"))
       (define result (pass root text))
       (check-equal? (car result) 'ok (format "~s" result))
       (check-equal? (normal (cadr result)) (normal (old root text)))
       (define references (cadr (cadr result)))
       (define key (list (build-path root "program.rkt") '() 0 'value))
       (define (range-at line start end)
         (hasheq 'start (hasheq 'line line 'character start)
                 'end (hasheq 'line line 'character end)))
       (define ranges
         (for/list ([location (in-list (cdr (assoc key references)))])
           (hash-ref location 'range)))
       (check-not-false (member (range-at 1 10 14) ranges)
                        "the narrowed component retains phase key 0")
       (check-false
        (for*/or ([entry (in-list references)] [location (in-list (cdr entry))])
          (equal? (hash-ref location 'range) (range-at 1 9 14)))
        "the coarse occurrence is superseded")
       (check-false
        (for*/or ([entry (in-list references)] [location (in-list (cdr entry))])
          (equal? (hash-ref location 'range) (range-at 4 2 7)))
        "the predicted occurrence is absent"))))

  (test-case "compact locations count CRLF and preceding Unicode characters"
    (with-project
     (lambda (root)
       (for ([prefix '("" "; λé😊\r\n")] [definition-line '(2 3)])
         (define text
           (string-append "#lang racket/base\r\n" prefix
                          "(provide value)\r\n(define value 1)\r\n(value)\r\n"))
         (define result (pass root text))
         (check-equal? (car result) 'ok (format "~s" result))
         (define contribution (cadr result))
         (define key (list (build-path root "program.rkt") '() 0 'value))
         (define (location line start end)
           (hasheq 'uri ((get 'path->uri) (build-path root "program.rkt"))
                   'range (hasheq 'start (hasheq 'line line 'character start)
                                 'end (hasheq 'line line 'character end))))
         (check-equal? (cdr (assoc key (caddr contribution)))
                       (location definition-line 8 13))
         (check-equal? (list->set (cdr (assoc key (cadr contribution))))
                       (set (location (sub1 definition-line) 9 14)
                            (location (add1 definition-line) 1 6)))))))

  (test-case "compact analysis reports invalid provider facts as the existing route does"
    (with-project
     (lambda (root)
       (put root ".racketeer/language-adapters.rktd"
            "((profile (match (language racket/base)) (bindings (expanded+ #((file \"provider.rkt\") bindings #f)))))")
       (for ([body (in-list
                    (list "(hasheq 'names 'bad)"
                          "(hasheq 'names (list (hasheq 'identifier #'unbound 'role 'use 'range '(0 . 1))))"
                          "(hasheq 'families (list (hasheq 'key 'bad 'canonical #'unbound 'members '())))"))])
         (put root ".racketeer/provider.rkt"
              (format "#lang racket/base\n(provide bindings)\n(define (bindings request data) ~a)\n" body))
         (define message (with-handlers ([exn:fail? exn-message]) (old root plain)))
         (check-true (string? message))
         (check-equal? (pass root plain) (cons 'failed message))))))

  (test-case "absent and empty adapters preserve the generic contribution"
    (with-project
     (lambda (root)
       (define generic (normal (old root plain)))
       (define absent (pass root plain))
       (check-equal? (car absent) 'ok)
       (check-equal? (normal (cadr absent)) generic)
       (put root ".racketeer/language-adapters.rktd" "((profile (match (language racket/base))))")
       (define empty (pass root plain))
       (check-equal? (car empty) 'ok)
       (check-equal? (normal (cadr empty)) generic)))))
