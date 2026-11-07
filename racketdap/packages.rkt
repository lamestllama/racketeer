#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require json racket/lazy-require racket/list racket/path)
(provide package-source-roots installed-packages)
(lazy-require [pkg/lib (pkg-directory get-all-pkg-scopes get-pkgs-dir installed-pkg-table
                                    path->pkg+subpath+scope pkg-info-orig-pkg pkg-info-auto?)])

;; Resolve in the process that will execute the program, so the selected
;; Racket installation, environment, scopes, and linked packages all agree.
(define (package-source-roots names)
  (unless (and (list? names)
               (andmap (lambda (name) (and (string? name) (positive? (string-length name)))) names))
    (raise-argument-error 'package-source-roots "list of nonempty package names" names))
  (define cache (make-hash))
  (for/list ([name (in-list (remove-duplicates names))])
    (define directory (pkg-directory name #:cache cache))
    (unless directory
      (error 'debugPackages "Package ~a is not installed for this Racket environment. Install or link it first." name))
    (simplify-path directory)))

(define (installed-packages)
  (define scopes (get-all-pkg-scopes))
  (define scope-names
    (for/hash ([scope (in-list scopes)])
      (values (simplify-path (get-pkgs-dir scope)) scope)))
  (define tables
    (for/hash ([scope (in-list scopes)])
      (values scope (installed-pkg-table #:scope scope))))
  (define names (sort (remove-duplicates (append* (map hash-keys (hash-values tables)))) string<?))
  (define cache (make-hash))
  (define path-cache (make-hash))
  (for/list ([name (in-list names)])
    (define directory (simplify-path (pkg-directory name #:cache cache)))
    (define-values (_name _subpath raw-scope) (path->pkg+subpath+scope directory #:cache path-cache))
    (define scope (if (path? raw-scope) (hash-ref scope-names (simplify-path raw-scope) raw-scope) raw-scope))
    (define info (hash-ref (hash-ref tables scope) name))
    (hasheq 'name name
            'directory (path->string directory)
            'scope (if (path? scope) (path->string scope) (symbol->string scope))
            'sourceType (symbol->string (car (pkg-info-orig-pkg info)))
            'linked (and (memq (car (pkg-info-orig-pkg info)) '(link static-link clone)) #t)
            'automatic (pkg-info-auto? info))))

(module+ main
  (define args (vector->list (current-command-line-arguments)))
  (cond
    [(equal? args '("list")) (write-json (installed-packages))]
    [(and (pair? args) (equal? (car args) "roots"))
     (write-json (map path->string (package-source-roots (cdr args))))]
    [else (raise-user-error 'packages "Expected list or roots followed by package names.")])
  (newline))
