#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/path syntax/modread "../language-adapters.rkt")
(provide read-macro-source call-with-macro-source)

;; Read the captured buffer, not the on-disk file. Counting the actual prefix
;; preserves Racket's Unicode, tab and CRLF source-location conventions.
(define (read-macro-source request)
  (define source (hash-ref request 'source))
  (define name (if (hash-ref request 'sourceIsFile) (string->path source) source))
  (define prefix (hash-ref request 'prefix ""))
  (define in (open-input-string (string-append prefix (hash-ref request 'text)) name))
  (port-count-lines! in)
  (read-string (string-length prefix) in)
  (define (read-forms)
    (let loop ([forms '()])
      (define form (read-syntax name in))
      (if (eof-object? form) (reverse forms) (loop (cons form forms)))))
  (define module? (equal? (hash-ref request 'mode) "module"))
  (define forms
    (if module?
        (with-module-reading-parameterization read-forms)
        (parameterize ([read-accept-reader #f] [read-accept-lang #f]) (read-forms))))
  (when (null? forms)
    (error 'macro-stepper "The current line, selection, or file contains no Racket forms."))
  (cond
    [module?
     (unless (and (= (length forms) 1)
                  (let ([parts (syntax->list (car forms))])
                    (and parts (>= (length parts) 4) (eq? (syntax-e (car parts)) 'module))))
       (error 'macro-stepper "Stepping through a file requires a single #lang or module declaration."))
     (define adapter
       (resolve-language-adapter name #:text (string-append prefix (hash-ref request 'text))
         #:pre (car forms) #:workspace (hash-ref request 'workspace #f)))
     (syntax-property (car forms) 'racketeer:language-profile adapter)]
    [(null? (cdr forms)) (car forms)]
    [else (datum->syntax #f (cons 'begin forms) (car forms))]))

;; Fragment scope is deliberately independent of the containing module. A
;; module retains its own language and imports. Expansion runs transformer
;; code, but never instantiates the module's runtime body.
(define (call-with-macro-source request expand-procedure)
  (define directory (string->path (hash-ref request 'directory)))
  (parameterize ([current-namespace (make-base-namespace)]
                 [current-directory (hash-ref request 'cwd directory)]
                 [current-load-relative-directory directory])
    (unless (equal? (hash-ref request 'mode) "module") (namespace-require 'racket))
    (expand-procedure (read-macro-source request))))
