#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit "../racketdap/worker/plots.rkt")
(module+ test
  (test-case "numeric plot probes avoid GUI resolution without caching absence for other values"
    (define resolve (current-module-name-resolver))
    (define requests 0)
    (parameterize ([current-module-name-resolver
                    (case-lambda
                      [(path namespace) (resolve path namespace)]
                      [(path relative syntax load?)
                       (when (eq? path 'racket/gui/base) (set! requests (add1 requests)))
                       (resolve path relative syntax load?)])])
      (for ([value (list 42 1/2 1.5 +inf.0 +nan.0 1+2i)])
        (check-false (plot-value? value)))
      (check-equal? requests 0)
      ;; Non-numeric values must retry: evaluation may load GUI support later.
      (check-false (plot-value? 'ordinary))
      (define first requests)
      (check-true (positive? first))
      (check-false (plot-value? 'ordinary))
      (check-true (> requests first)))))
