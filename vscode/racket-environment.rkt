#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require compiler/cm
         racket/file
         racket/runtime-path)

;; Make the bundled analysis libraries available without registering packages in
;; the user's Racket installation. Keep the user's normal collections available
;; to analyze their programs.
(define-runtime-path collects "language-server/collects")
(current-library-collection-paths
  (cons collects (current-library-collection-paths)))

;; Isolated analysis workers share bytecode, never analysis state. Racket's
;; compilation manager validates dependencies and keeps writes out of projects.
(define cache
  (build-path (find-system-path 'addon-dir) "racketeer" (version)
              (system-library-subpath #f)))
(make-directory* cache)
(current-compiled-file-roots (cons cache (current-compiled-file-roots)))
(current-load/use-compiled (make-compilation-manager-load/use-compiled-handler))

(define-runtime-path adapters "language-adapters.rkt")
(dynamic-require adapters #f)
