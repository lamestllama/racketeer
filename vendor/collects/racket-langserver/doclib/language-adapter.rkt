#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require "../common/source.rkt"
         "../workspace/current.rkt"
         "../workspace/state.rkt")
(provide current-language-adapter-resolver current-language-adapter-validator
         current-language-adapter-bindings current-language-adapter-declarations
         current-language-adapter-calls current-language-adapter-completion
         current-completion-position source-language-adapter)

;; The embedding launcher supplies optional language tooling. Standalone
;; callers retain ordinary analysis without depending on an extension package.
(define current-language-adapter-resolver (make-parameter #f))
(define current-language-adapter-validator (make-parameter (lambda (_) #t)))
;; Maps a selected adapter to its bindings procedure, or #f for generic facts alone.
(define current-language-adapter-bindings (make-parameter (lambda (_) #f)))
(define current-language-adapter-declarations (make-parameter (lambda (_) #f)))
(define current-language-adapter-calls (make-parameter (lambda (_) #f)))
(define current-language-adapter-completion (make-parameter (lambda (_) #f)))
(define current-completion-position (make-parameter #f))
(define (source-language-adapter source text pre)
  (define resolver (current-language-adapter-resolver))
  (and resolver
       (resolver (or (source-file-path source) (source-uri source)) text pre
                 (workspace-folders current-workspace))))
