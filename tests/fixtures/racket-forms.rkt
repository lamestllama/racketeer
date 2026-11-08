#lang racket
(provide run)

(struct item (name quantity price) #:transparent)
(define basket%
  (class object%
    (init-field items)
    (super-new)
    (define/public (total)
      (for/sum ([entry (in-list items)])
        (match entry
          [(item _ quantity price) (* quantity price)])))))

(define (run)
  (define purchases (list (item 'apple 3 7) (item 'pear 2 5)))
  (define basket (new basket% [items purchases]))
  (define-values (names quantities)
    (for/lists (names quantities) ([entry (in-list purchases)])
      (match-define (item name quantity _) entry)
      (values name quantity)))
  (list (send basket total) names quantities
        (for/vector ([quantity (in-list quantities)]) (sqr quantity))))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
