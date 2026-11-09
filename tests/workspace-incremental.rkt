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

(module+ test
  (test-case "a descriptor read is recorded and its edit replaces the index result"
    (define root (make-temporary-file "workspace-descriptor~a" 'directory))
    (define engine ((get 'make-workspace-analysis)))
    (define source (build-path root "program.rkt"))
    (define descriptor (build-path root ".racketeer/language-adapters.rktd"))
    (define (pass revision)
      ((get 'workspace-analysis-update!) engine
       (hasheq 'revision revision 'roots (list ((get 'path->uri) root)) 'documents '()))
      (define run ((get 'WorkspaceAnalysis-current-run) engine))
      ((get 'run-index) engine run)
      (check-equal? ((get 'Run-state) run) "ready")
      (hash-ref ((get 'WorkspaceAnalysis-results) engine) source))
    (dynamic-wind void
      (lambda ()
        (make-directory* (path-only descriptor))
        (display-to-file "#lang racket/base\n(provide answer)\n(define answer 42)\n" source)
        (display-to-file "((profile (match (language racket/base))))" descriptor)
        (check-not-false (assoc descriptor ((get 'Result-reads) (pass 1))))
        ;; Registered descriptor reads acquire their disk basis on the next pass.
        (define first (pass 2))
        (check-eq? first (pass 3))
        (call-with-output-file descriptor newline #:exists 'append)
        (define changed (pass 4))
        (check-not-eq? first changed)
        (check-not-false (assoc descriptor ((get 'Result-reads) changed))))
      (lambda ()
        ((get 'workspace-analysis-close!) engine)
        (delete-directory/files root)))))
