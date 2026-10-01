#lang racket/base
(require rackunit racket/port racket/promise
         "../racketdap/protocol.rkt" "../racketdap/worker/inspect.rkt"
         (only-in "../racketdap/instrumentation/instrument.rkt" unavailable))
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
    (check-equal? effects 0)
    (define missing (unavailable 'uninitialized))
    (check-false (expandable? missing))
    (check-equal? (children missing 0 10) '()))
  (test-case "wrapped vectors are not accessed implicitly"
    (define effects 0)
    (define wrapped (chaperone-vector (vector 1)
                                    (lambda (v i value) (set! effects (add1 effects)) value)
                                    (lambda (v i value) value)))
    (check-false (expandable? wrapped))
    (check-equal? (children wrapped 0 100) '())
    (value-preview wrapped)
    (check-equal? effects 0))
  (test-case "structure fields use the debugger inspector without running user printers"
    (define effects 0)
    (define value
      (parameterize ([current-inspector (make-inspector)])
        (struct parent (first) #:mutable)
        (struct child parent (second [third #:auto]) #:auto-value 3
          #:property prop:custom-write (lambda args (set! effects (add1 effects)))
          #:property prop:object-name (lambda (_) (set! effects (add1 effects)) 'changed))
        (child 1 2)))
    (check-equal? (value-type value) "child")
    (check-equal? (value-preview value) "#<child>")
    (check-true (expandable? value))
    (check-equal? (children value 0 10) '(("0" . 1) ("1" . 2) ("2" . 3)))
    (check-equal? (children value 1 1) '(("1" . 2)))
    (check-equal? (children value 9 10) '())
    (check-equal? effects 0))
  (test-case "wrapped structures remain explicit and inaccessible structures stay opaque"
    (define effects 0)
    (define wrapped
      (parameterize ([current-inspector (make-inspector)])
        (struct item (value))
        (chaperone-struct (item 7) item-value (lambda (_ value) (set! effects (add1 effects)) value))))
    (check-equal? (value-type wrapped) "wrapped value")
    (check-false (expandable? wrapped))
    (check-equal? (children wrapped 0 10) '())
    (check-equal? effects 0)
    (struct private (value))
    (check-false (expandable? (private 7)))
    (check-equal? (children (private 7) 0 10) '()))
  (test-case "only visible structure fields are inspected, including prefab and cyclic values"
    (struct hidden (value))
    (define partial
      (parameterize ([current-inspector (make-inspector)])
        (struct child hidden (value))
        (child 7 8)))
    (check-equal? (value-type partial) "child")
    (check-equal? (children partial 0 10) '(("0" . 8)))
    (struct visible (value) #:transparent)
    (struct private-child visible (other))
    (check-false (expandable? (private-child 7 8)))
    (check-equal? (children (private-child 7 8) 0 10) '())
    (check-equal? (children '#s(pair 1 2) 0 2) '(("0" . 1) ("1" . 2)))
    (struct cycle (value) #:transparent #:mutable)
    (define v (cycle #f)) (set-cycle-value! v v)
    (check-equal? (value-preview v) "#<cycle>")
    (check-eq? (cdar (children v 0 1)) v))
  (test-case "vector children are paged and large exact numbers are bounded"
    (check-equal? (children '#(0 1 2 3 4) 1 2) '(("1" . 1) ("2" . 2)))
    (check-equal? (value-preview (expt 2 10000)) "<large exact number>")))
