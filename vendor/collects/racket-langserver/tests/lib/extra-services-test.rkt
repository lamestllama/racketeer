#lang racket/base

(require rackunit
         racket/class
         "../../doclib/check-syntax.rkt"
         "../../doclib/doc.rkt"
         "../../doclib/doc-trace.rkt"
         "../../doclib/service/interface.rkt")

(define probe%
  (class base-service%
    (super-new)
    (define events '())
    (define (note! event) (set! events (cons event events)))
    (define/public (read-events) (reverse events))
    (define/override (reset) (note! 'reset))
    (define/override (text-replaced start end) (note! 'edit))
    (define/override (expand start end) (note! 'expand))
    (define/override (contract start end) (note! 'contract))
    (define/override (walk-stx expanded) (note! 'syntax))
    (define/override (walk-log logs) (note! 'log))))

(define text "#lang racket/base\n(define value 1)\nvalue\n")

(test-case "a trace has no extra services unless one is registered"
  (define result (doc-check-syntax (make-doc "untitled:plain" text)))
  (check-true (CSResult-succeed? result))
  (check-false (send (CSResult-trace result) get-extra-service 'probe)))

(test-case "every trace builds its own service, and the service follows the trace"
  (define created '())
  (parameterize ([current-extra-service-factories
                  (hasheq 'probe (lambda (source editor lexer)
                                   (define service (new probe%))
                                   (set! created (cons service created))
                                   service))])
    (define doc (make-doc "untitled:probe" text))
    (define initial (car created))
    (define result (doc-check-syntax doc))
    (check-true (CSResult-succeed? result))
    (define trace (CSResult-trace result))
    (define filled (send trace get-extra-service 'probe))
    (check-equal? (length created) 2)
    (check-not-eq? initial filled)
    (check-false (send trace get-extra-service 'unknown))
    (check-equal? (send filled read-events) '(syntax log))
    (doc-update-trace! doc trace (send trace get-contribution) 0)
    (send trace text-replaced 0 0)
    (send trace expand 0 1)
    (send trace contract 0 1)
    (send trace reset)
    (check-equal? (send filled read-events) '(syntax log edit expand contract reset))
    (doc-detach-analysis! doc)
    (define detached (car created))
    (check-equal? (length created) 3)
    (check-not-eq? detached filled)
    (check-equal? (send detached read-events) '())))
