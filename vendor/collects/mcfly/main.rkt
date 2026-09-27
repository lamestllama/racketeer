#lang racket/base
;; For legal info, see file "info.rkt".

(require (for-syntax racket/base))

(define-syntax (doc stx)
  (syntax-case stx ()
    ((_ ARG ...) #'(begin))))

(provide doc)
