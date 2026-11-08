#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/runtime-path)
(define-runtime-path packages "../racketdap/packages.rkt")
(module+ test
  (test-case "empty and invalid package selections do not load package management"
    (define loaded '())
    (define load (current-load/use-compiled))
    (parameterize ([current-namespace (make-base-namespace)]
                   [current-load/use-compiled
                    (lambda (file name) (set! loaded (cons (path->string file) loaded)) (load file name))])
      (define roots (dynamic-require packages 'package-source-roots))
      (check-equal? (roots '()) '())
      (check-exn exn:fail:contract? (lambda () (roots '(42))))
      (check-exn exn:fail:contract? (lambda () (roots '(""))))
      (check-false (ormap (lambda (file) (regexp-match? #rx"[/\\\\]pkg[/\\\\]lib[.]rkt$" file)) loaded)))))
