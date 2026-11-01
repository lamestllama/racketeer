#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require "../../racketdap/instrumentation/instrument.rkt")
(provide before-events)
(define (before-events predicate callback)
  (lambda (stop)
    (when (and (eq? (stop-kind stop) 'before) (predicate (stop-site stop)))
      (callback stop))))
