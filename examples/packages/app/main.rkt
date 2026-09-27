#lang racket/base
(require racketdap-example/math)
(provide answer)

(define (answer value)
  (define result (twice value))
  result)

(module+ main
  (displayln (answer 21)))

(module+ test
  (require rackunit)
  (check-equal? (answer 21) 42))

;; In Debug REPL: (answer 7)
