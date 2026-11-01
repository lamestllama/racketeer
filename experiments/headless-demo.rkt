#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/runtime-path
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt")
(define-runtime-path target "../tests/fixtures/locals.rkt")

(define result
  (call-with-values
   (lambda ()
     (run-module
      target #:entry 'run
      #:on-event
      (lambda (stop)
        (when (and (eq? (stop-kind stop) 'before)
                   (equal? (site-expression (stop-site stop)) '(#%app * subtotal rate)))
          (printf "Stopped at ~a:~a before (* subtotal rate)\n"
                  (site-source (stop-site stop)) (site-line (stop-site stop)))
          (printf "Locals: ~s\n" (stop-locals stop))
          (printf "(+ subtotal 20) => ~s\n" (stop-evaluate stop '(+ subtotal 20)))
          (stop-evaluate stop '(set! subtotal 200))
          (printf "Changed subtotal to 200; continuing.\n")))))
   list))
(printf "Returned values: ~s\n" result)
