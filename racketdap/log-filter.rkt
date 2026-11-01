#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/string)
(provide parse-log-filter)

;; A default threshold followed by optional, exact topic overrides.
(define (parse-log-filter text)
  (unless (and (string? text) (<= (string-length text) 4096))
    (error 'log-filter "Use a logging filter of at most 4096 characters."))
  (define parts (string-split text))
  (define level-pattern #px"^(none|fatal|error|warning|info|debug)$")
  (unless (and (pair? parts) (regexp-match? level-pattern (car parts)))
    (error 'log-filter "Start with none, fatal, error, warning, info or debug."))
  (append
   (apply append
          (for/list ([part (in-list (cdr parts))])
            (define match (regexp-match #px"^(none|fatal|error|warning|info|debug)@([^@\\s]+)$" part))
            (unless match (error 'log-filter "Expected level@topic, received ~a." part))
            (list (string->symbol (cadr match)) (string->symbol (caddr match)))))
   (list (string->symbol (car parts)) #f)))
