#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/list racket/path racket/runtime-path)

(define-runtime-path environment "../vscode/racket-environment.rkt")
(define-runtime-path analysis "../vscode/workspace-analysis.rkt")
(dynamic-require environment #f)
(dynamic-require analysis #f)
(define (get name)
  (parameterize ([current-namespace (module->namespace analysis)]) (eval name)))

(module+ test
  (test-case "an edit replaces only its result and direct and transitive dependents"
    (define root (make-temporary-file "workspace-incremental~a" 'directory))
    (define engine ((get 'make-workspace-analysis)))
    (define (write-file name text)
      (display-to-file (string-append "#lang racket/base\n" text) (build-path root name) #:exists 'truncate))
    (define (pass revision)
      ((get 'workspace-analysis-update!) engine
       (hasheq 'revision revision 'roots (list ((get 'path->uri) root)) 'documents '()))
      (define run ((get 'WorkspaceAnalysis-current-run) engine))
      (define began (current-inexact-monotonic-milliseconds))
      ((get 'run-index) engine run)
      (define elapsed (- (current-inexact-monotonic-milliseconds) began))
      (check-equal? ((get 'Run-state) run) "ready")
      (check-equal? ((get 'Run-indexed) run) 4)
      (values ((get 'WorkspaceAnalysis-results) engine) elapsed))
    (define (replaced before after)
      (sort (for/list ([(path result) (in-hash after)] #:unless (eq? result (hash-ref before path)))
              (path->string (file-name-from-path path))) string<?))
    (dynamic-wind
      void
      (lambda ()
        (write-file "definition.rkt" "(provide value)\n(define value 1)\n")
        (write-file "middle.rkt" "(require \"definition.rkt\")\n(provide value)\n")
        (write-file "consumer.rkt" "(require \"middle.rkt\")\n(value)\n")
        (write-file "unrelated.rkt" "(define other 1)\n")
        (define-values (first cold) (pass 1))
        (define-values (unchanged warm) (pass 2))
        (check-equal? (replaced first unchanged) '())
        (write-file "consumer.rkt" "(require \"middle.rkt\")\n(value)\n(value)\n")
        (define-values (leaf leaf-time) (pass 3))
        (check-equal? (replaced unchanged leaf) '("consumer.rkt"))
        (write-file "definition.rkt" "(provide value)\n(define value 2)\n")
        (define-values (dependency dependency-time) (pass 4))
        (check-equal? (replaced leaf dependency) '("consumer.rkt" "definition.rkt" "middle.rkt"))
        (write-file "unrelated.rkt" "(define other 2)\n")
        (define-values (unrelated unrelated-time) (pass 5))
        (check-equal? (replaced dependency unrelated) '("unrelated.rkt"))
        (printf "Re-analysed: unchanged 0; leaf 1; dependency 3; unrelated 1 (of 4). Times ms: ~s\n"
                (list cold warm leaf-time dependency-time unrelated-time)))
      (lambda ()
        ((get 'workspace-analysis-close!) engine)
        (delete-directory/files root)))))
