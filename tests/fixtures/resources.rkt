#lang racket/base
(provide run)
(define background (thread (lambda () (sync never-evt))))
(define (run) (list background))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
