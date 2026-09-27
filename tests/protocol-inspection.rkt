#lang racket/base
(require rackunit racket/port racket/promise
         "../racketdap/protocol.rkt" "../racketdap/worker/inspect.rkt")
(module+ test
  (test-case "UTF-8 payload uses byte length and supports successive messages"
    (define out (open-output-bytes))
    (define message (hasheq 'text "😀λ" 'seq 1))
    (write-message message out) (write-message message out)
    (define in (open-input-bytes (get-output-bytes out)))
    (check-equal? (read-message in) message)
    (check-equal? (read-message in) message)
    (check-true (eof-object? (read-message in))))
  (for ([bytes (list #"Content-Length: 20\r\n\r\n{}"
                    #"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"
                    #"Content-Length: 999999999\r\n\r\n"
                    #"Content-Length: 2\r\n"
                    #"Content-Length: 2\r\n\r\n[]")])
    (test-case "malformed or truncated transport input is rejected"
      (check-exn exn:fail? (lambda () (read-message (open-input-bytes bytes))))))
  (test-case "previews do not execute writers, force promises, or traverse cycles"
    (define effects 0)
    (struct custom () #:property prop:custom-write (lambda args (set! effects (add1 effects))))
    (define promise (delay (set! effects (add1 effects)) 10))
    (check-equal? (value-preview (custom)) "#<opaque value>")
    (check-equal? (value-preview promise) "#<promise>")
    (define cycle (box #f)) (set-box! cycle cycle)
    (check-true (< (string-length (value-preview cycle)) 100))
    (check-equal? effects 0))
  (test-case "wrapped vectors are not accessed implicitly"
    (define effects 0)
    (define wrapped (chaperone-vector (vector 1)
                                    (lambda (v i value) (set! effects (add1 effects)) value)
                                    (lambda (v i value) value)))
    (check-false (expandable? wrapped))
    (check-equal? (children wrapped 0 100) '())
    (value-preview wrapped)
    (check-equal? effects 0))
  (test-case "vector children are paged and large exact numbers are bounded"
    (check-equal? (children '#(0 1 2 3 4) 1 2) '(("1" . 1) ("2" . 2)))
    (check-equal? (value-preview (expt 2 10000)) "<large exact number>")))
