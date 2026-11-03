#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit "../racketdap/worker/inspect.rkt")
(module+ test
 (test-case "a deep structure has an exact count and can page beyond the unpaged limit"
  (define-values (type ctor pred ref set)
   (for/fold ([parent #f] [ctor #f] [pred #f] [ref #f] [set #f]) ([i (in-range 33)])
    (make-struct-type 'level parent 0 400 0 '() #f)))
  (define value (ctor))
  (define-values (indexed named) (child-counts value))
  (check-equal? (list indexed named) '(13200 0))
  (define-values (rows omitted) (value-rows value #f 0 #f))
  (check-equal? (length rows) 10000)
  (check-equal? omitted 3200)
  (define-values (last remainder) (value-rows value "indexed" 13198 2))
  (check-equal? (map car last) '("13198" "13199"))))
