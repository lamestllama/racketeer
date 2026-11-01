#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit pkg/lib racket/list
         "../racketdap/packages.rkt")

(module+ test
  (test-case "package roots follow the active Racket installation and deduplicate names"
    (check-equal? (package-source-roots '("rackunit-lib" "rackunit-lib"))
                  (list (pkg-directory "rackunit-lib")))
    (check-equal? (package-source-roots '()) '()))
  (test-case "invalid and missing debug package names fail explicitly"
    (check-exn exn:fail:contract? (lambda () (package-source-roots '(42))))
    (check-exn exn:fail:contract? (lambda () (package-source-roots '(""))))
    (check-exn #rx"not installed" (lambda () (package-source-roots '("racketdap-missing-regression-package")))))
  (test-case "structured package inventory reports the source directory and scope"
    (define packages (installed-packages))
    (define entry (findf (lambda (pkg) (equal? (hash-ref pkg 'name) "rackunit-lib")) packages))
    (check-not-false entry)
    (check-equal? (hash-ref entry 'directory) (path->string (pkg-directory "rackunit-lib")))
    (check-true (string? (hash-ref entry 'scope)))
    (check-true (boolean? (hash-ref entry 'linked)))
    (check-equal? (length packages) (length (remove-duplicates (map (lambda (pkg) (hash-ref pkg 'name)) packages))))))
