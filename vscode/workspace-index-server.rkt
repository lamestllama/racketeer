#lang racket/base
(require "racket-environment.rkt"
         racket/runtime-path)
(define-runtime-path index "workspace-index.rkt")
(dynamic-require `(submod ,index main) #f)
