#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list "../source.rkt" "../instrumentation/runtime.rkt"
         (only-in "../test-discovery.rkt" test-source-hash))
(provide coverage-files)

;; Expansion can produce several sites for the same source expression. Report
;; whether that expression ran, without treating expansion copies as statements
;; or suggesting that their visits are source-level execution counts.
(define (coverage-files sources sites visited)
  (for/list ([path (in-list (sort (hash-keys sites) string<? #:key path->string))]
             #:when (hash-has-key? sources path))
    (define source (hash-ref sources path))
    (define ranges (make-hash))
    (for ([descriptor (in-list (hash-ref sites path))]
          #:when (and (exact-positive-integer? (site-position descriptor))
                      (exact-positive-integer? (site-span descriptor))))
      (define range (cons (site-position descriptor) (site-span descriptor)))
      (hash-update! ranges range
                    (lambda (executed?) (or executed? (hash-ref visited (site-id descriptor) #f))) #f))
    (hasheq
     'path (path->string path) 'sourceHash (test-source-hash (source-file-text source))
     'statements
     (for/list ([range (in-list (sort (hash-keys ranges)
                                    (lambda (a b) (or (< (car a) (car b))
                                                     (and (= (car a) (car b)) (< (cdr a) (cdr b)))))))])
       (define-values (line column) (source-location source (car range) #f))
       (define-values (end-line end-column) (source-location source (+ (car range) (cdr range)) #f))
       (hasheq 'line line 'column column 'endLine end-line 'endColumn end-column
               'executed (hash-ref ranges range))))))
