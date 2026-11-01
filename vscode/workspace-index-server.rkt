#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require "racket-environment.rkt"
         racket/runtime-path)
(define-runtime-path index "workspace-index.rkt")
(dynamic-require `(submod ,index main) #f)
