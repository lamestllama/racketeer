#lang racket/base
(require "../../racketdap/instrumentation/instrument.rkt")
(provide before-events)
(define (before-events predicate callback)
  (lambda (stop)
    (when (and (eq? (stop-kind stop) 'before) (predicate (stop-site stop)))
      (callback stop))))
