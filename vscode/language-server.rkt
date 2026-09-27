#lang racket/base

(require racket/runtime-path)

;; Load the private, source-distributed server without registering packages in
;; the user's Racket installation. Keep the user's normal collections available
;; to analyze their programs.
(define-runtime-path collects "language-server/collects")
(current-library-collection-paths
 (cons collects (current-library-collection-paths)))
(dynamic-require '(submod racket-langserver main) #f)
