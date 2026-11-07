#lang racket/base
(require racket/control)
(provide run)
(define (run)
  (define saved #f)
  (define effects (make-channel))
  (define first
    (reset
     (+ 1 (shift k (set! saved k) 0))))
  (define worker (thread (lambda () (channel-put effects (saved 40)))))
  (define second (channel-get effects))
  (thread-wait worker)
  (list first second))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
