#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class racket/file racket/list racket/match racket/runtime-path compiler/compile-file
         "../vscode/workspace-analysis.rkt")
(define-runtime-path analysis "../vscode/workspace-analysis.rkt")
(define ns (module->namespace analysis))
(define (get name) (parameterize ([current-namespace ns]) (eval name)))
(define-runtime-path analyser "../vscode/workspace-analysis-worker.rkt")
(dynamic-require analyser #f)
(define answer (parameterize ([current-namespace (module->namespace analyser)]) (eval 'answer)))
(define (with-project proc)
  (define root (make-temporary-file "navigation~a" 'directory))
  (dynamic-wind void (lambda () (proc root)) (lambda () (delete-directory/files root))))
(define text "#lang racket/base\n(define (f x) (+ x x))\n")
(define (request root source [buffers (hash)] [view (hash)] [filename "program.rkt"])
  (define file (build-path root filename))
  (list 'analyse file 1048576 source
        (list 'definition ((get 'path->uri) file) (hasheq 'line 1 'character 17) #f view root)
        buffers (list root) (hash)))
(define (counted root)
  (string-append text "(require (for-syntax racket/base))\n"
                 (format "(begin-for-syntax (call-with-output-file ~s #:exists 'append (lambda (out) (displayln 'expanded out))))\n"
                         (path->string (build-path root "count")))))
(define (ok result)
  (check-equal? (car result) 'ok (format "~s" result))
  result)
(define (held-service cache) (car (cadr (hash-ref cache 'document))))

(module+ test
  (test-case "a definition target available only as bytecode is a failed source"
    (with-project
     (lambda (root)
       (define target (build-path root "target.rkt"))
       (display-to-file "#lang racket/base\n(provide value)\n(define value 1)\n" target)
       (make-directory (build-path root "compiled"))
       (parameterize ([current-namespace (make-base-namespace)] [read-accept-reader #t])
         (compile-file target (build-path root "compiled" "target_rkt.zo")))
       (delete-file target)
       (define source "#lang racket/base\n(require \"target.rkt\")\nvalue\n")
       (define position (hasheq 'line 2 'character 2))
       (define query (list 'definition ((get 'path->uri) (build-path root "program.rkt")) position #f (hash) root))
       (check-equal? (car (answer (list-set (request root source) 4 query) void)) 'source))))

  (test-case "document reads and expansions preserve resource failures and breaks"
    (with-project
     (lambda (root)
       (for ([raised '("'broken" "#f" "eof" "'(changed . \"broken\")"
                       "(exn:fail:out-of-memory \"allocation\" (current-continuation-marks))"
                       "(exn:break \"interrupted\" (current-continuation-marks) (let/ec k k))")]
             [expected '(source source source source out-of-memory failed)])
         (define reader (build-path root "reader.rkt"))
         (display-to-file
          (format "#lang racket/base\n(provide (rename-out [source-read read-syntax]))\n(define (source-read src in) (raise ~a))\n" raised)
          reader #:exists 'truncate)
         (for ([source (list (format "#reader (file ~s)\n" (path->string reader))
                             (format "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (raise ~a))\n" raised))])
           (check-equal? (car (answer (request root source) void)) expected source))))))

  (test-case "unchanged document and cursor queries reuse the held service"
    (with-project
     (lambda (root)
       (define cache (make-hash))
       (define source (counted root))
       (define first (ok (answer (request root source) void cache)))
       (define service (held-service cache))
       (define second (ok (answer (request root source) void cache)))
       (check-eq? (held-service cache) service)
       (check-equal? (cadr second) (cadr first))
       (check-equal? (file->lines (build-path root "count")) '("expanded"))
       (ok (answer (request root (string-append source "\n")) void cache))
       (check-not-eq? (held-service cache) service)
       (check-equal? (file->lines (build-path root "count")) '("expanded" "expanded")))))

  (test-case "held analysis validates transitive disk and open-buffer dependencies"
    (with-project
     (lambda (root)
       (define cache (make-hash))
       (define leaf (build-path root "leaf.rkt"))
       (define middle (build-path root "middle.rkt"))
       (define source (string-append (counted root) "(require (for-syntax \"middle.rkt\"))\n"))
       (define (leaf-text value) (format "#lang racket/base\n(provide value)\n(define value ~a)\n" value))
       (display-to-file (leaf-text 1) leaf)
       (display-to-file "#lang racket/base\n(require (for-syntax racket/base \"leaf.rkt\"))\n(provide value)\n(define-syntax (saved stx) (datum->syntax stx value))\n(define value (saved))\n" middle)
       (ok (answer (request root source) void cache))
       (define first (held-service cache))
       (display-to-file (leaf-text 2) leaf #:exists 'truncate)
       (ok (answer (request root source) void cache))
       (check-not-eq? (held-service cache) first)
       (define second (held-service cache))
       (ok (answer (request root source (hash leaf (leaf-text 3)) (hash 'leaf '(1 1))) void cache))
       (check-not-eq? (held-service cache) second)
       (define third (held-service cache))
       (ok (answer (request root source (hash leaf (leaf-text 3)) (hash 'leaf '(2 1))) void cache))
       (check-not-eq? (held-service cache) third "A dependency reopening at the same version has a new lifetime")
       (check-equal? (file->lines (build-path root "count")) (make-list 4 "expanded")))))

  (test-case "supersession and eviction release the sole held analysis; closed results stay compact"
    (with-project
     (lambda (root)
       (define cache (make-hash))
       (ok (answer (request root text) void cache))
       (define previous (make-weak-box (held-service cache)))
       (ok (answer (request root text (hash) (hash) "other.rkt") void cache))
       (collect-garbage) (collect-garbage)
       (check-false (weak-box-value previous))
       (define current (make-weak-box (held-service cache)))
       (define broken (answer (request root "#lang racket/base\n(") void cache))
       (check-equal? (car broken) 'source)
       (collect-garbage) (collect-garbage)
       (check-false (weak-box-value current))
       (check-false (hash-has-key? cache 'document))
       (ok (answer (list 'analyse (build-path root "closed.rkt") 1048576 text #f (hash) (list root) (hash)) void cache))
       (check-false (hash-has-key? cache 'document)))))

  (test-case "a completed answer rechecks dependency contents before delivery"
    (with-project
     (lambda (root)
       (define leaf (build-path root "leaf.rkt"))
       (display-to-file "#lang racket/base\n(provide value)\n(define value 1)\n" leaf)
       (define engine (make-workspace-analysis))
       (define uri ((get 'path->uri) (build-path root "program.rkt")))
       (dynamic-wind void
         (lambda ()
           (workspace-analysis-update! engine
             (hasheq 'revision 1 'roots '() 'documents
               (list (hasheq 'uri uri 'identity 1 'version 1
                 'text (string-append text "(require \"leaf.rkt\")\n")))))
           (define result (workspace-analysis-query engine 'definition
             (hasheq 'uri uri 'identity 1 'version 1 'position (hasheq 'line 1 'character 17))))
           (check-true (AnalysisResult? result))
           (check-true ((AnalysisResult-current? result)))
           (display-to-file "#lang racket/base\n(provide value)\n(define value 2)\n" leaf #:exists 'truncate)
           (check-false ((AnalysisResult-current? result))))
         (lambda () (workspace-analysis-close! engine))))))

  (test-case "registered data is checked before a fresh attempt and reused only while unchanged"
    (with-project
     (lambda (root)
       (define data (build-path root "value.dat"))
       (display-to-file "1" data)
       (define cache (make-hash))
       (define source
         (string-append (counted root)
           (format "(require (for-syntax compiler/cm-accomplice))\n(begin-for-syntax (register-external-file (string->path ~s)))\n"
                   (path->string data))))
       (ok (answer (request root source) void cache))
       (define service (held-service cache))
       (ok (answer (request root source) void cache))
       (check-eq? (held-service cache) service)
       (check-equal? (file->lines (build-path root "count")) '("expanded" "expanded"))
       (display-to-file "2" data #:exists 'truncate)
       (ok (answer (request root source) void cache))
       (check-not-eq? (held-service cache) service)
       (check-equal? (file->lines (build-path root "count")) (make-list 4 "expanded")))))

  (test-case "query slot reuse is released on cancellation, revision, recycling and shutdown"
    (with-project
     (lambda (root)
       (define previous (getenv "RACKETEER_INDEX_WORKERS"))
       (putenv "RACKETEER_INDEX_WORKERS" "1")
       (define engine (make-workspace-analysis))
       (define uri ((get 'path->uri) (build-path root "program.rkt")))
       (define (update revision)
         (workspace-analysis-update! engine
           (hasheq 'revision revision 'roots '() 'settings (hasheq 'enabled #f)
                   'documents (list (hasheq 'uri uri 'identity 1 'version revision 'text text)))))
       (define (query version [cancel never-evt])
         (workspace-analysis-query engine 'definition
           (hasheq 'uri uri 'identity 1 'version version 'position (hasheq 'line 1 'character 17)) cancel))
       (define slot (car ((get 'WorkspaceAnalysis-slots) engine)))
       (define (worker) (unbox (hash-ref (get 'slot-workers) slot)))
       (define (stopped held)
         (check-not-false (sync/timeout 30 ((get 'Worker-process) held)))
         (call-with-semaphore slot (lambda () (check-false (worker)))))
       (dynamic-wind void
         (lambda ()
           (update 1)
           (define cancel (make-semaphore))
           (check-true (AnalysisResult? (query 1 (semaphore-peek-evt cancel))))
           (define first (worker))
           (check-true (AnalysisResult? (query 1)))
           (check-eq? (worker) first)
           (semaphore-post cancel)
           (stopped first)
           (check-true (AnalysisResult? (query 1)))
           (define second (worker))
           (update 2)
           (stopped second)
           (check-true (AnalysisResult? (query 2)))
           (define third (worker))
           (workspace-analysis-close! engine)
           (stopped third)
           (putenv "RACKETEER_INDEX_RECYCLE_MEGABYTES" "1")
           (define recycled (make-workspace-analysis))
           (dynamic-wind void
             (lambda ()
               (workspace-analysis-update! recycled
                 (hasheq 'revision 1 'roots '() 'documents
                   (list (hasheq 'uri uri 'identity 1 'version 1 'text text))))
               (check-true (AnalysisResult? (workspace-analysis-query recycled 'definition
                 (hasheq 'uri uri 'identity 1 'version 1 'position (hasheq 'line 1 'character 17)))))
               (define recycled-slot (car ((get 'WorkspaceAnalysis-slots) recycled)))
               (check-false (unbox (hash-ref (get 'slot-workers) recycled-slot))))
             (lambda () (workspace-analysis-close! recycled))))
         (lambda ()
           (workspace-analysis-close! engine)
           (putenv "RACKETEER_INDEX_WORKERS" (or previous ""))
           (putenv "RACKETEER_INDEX_RECYCLE_MEGABYTES" "")))))))

(module+ test
  (when (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
    (test-case "native provider navigation uses the same document query"
      (with-project
       (lambda (root)
         (define source "#lang rhombus\nfun f(x): x + x\nf(1)\n")
         (define uri ((get 'path->uri) (build-path root "program.rkt")))
         (define definition
           (list (hasheq 'uri uri 'range (hasheq 'start (hasheq 'line 1 'character 6)
                                                'end (hasheq 'line 1 'character 7)))))
         (define engine (make-workspace-analysis))
         (dynamic-wind void
           (lambda ()
             (workspace-analysis-update! engine
               (hasheq 'revision 1 'roots '() 'settings (hasheq 'enabled #f) 'documents
                 (list (hasheq 'uri uri 'identity 1 'version 1 'text source))))
             (define (query operation [version 1] [position (hasheq 'line 1 'character 10)])
               (define result (workspace-analysis-query engine operation
                 (hasheq 'uri uri 'identity 1 'version version 'includeDeclaration #t
                         'position position)))
               (check-true (AnalysisResult? result) (format "~s" result))
               (AnalysisResult-value result))
             (check-equal? (query 'definition) definition)
             (check-equal? (query 'definition) definition)
             (define ranges
               (for/list ([start '(6 10 14)])
                 (hasheq 'start (hasheq 'line 1 'character start)
                         'end (hasheq 'line 1 'character (add1 start)))))
             (check-equal? (query 'highlights) (map (lambda (range) (hasheq 'range range)) ranges))
             (check-equal? (query 'references) (map (lambda (range) (hasheq 'uri uri 'range range)) ranges))
             (define model (build-path root "model.rhm"))
             (define model-uri ((get 'path->uri) model))
             (workspace-analysis-update! engine
               (hasheq 'revision 2 'roots '() 'settings (hasheq 'enabled #f) 'documents
                 (list (hasheq 'uri uri 'identity 1 'version 2
                               'text "#lang rhombus\nimport \"model.rhm\" as m\nm.value\n")
                       (hasheq 'uri model-uri 'identity 2 'version 1
                               'text "#lang rhombus\ndef value = 41\nexport value\n"))))
             (check-equal? (query 'definition 2 (hasheq 'line 2 'character 3))
               (list (hasheq 'uri model-uri 'range (hasheq 'start (hasheq 'line 1 'character 4)
                                                        'end (hasheq 'line 1 'character 9)))))
             (check-false (file-exists? model))
             (define virtual-uri (regexp-replace #rx"^file:" uri "untitled:"))
             (define virtual-path (build-path root "memory" "untitled.rkt"))
             (workspace-analysis-update! engine
               (hasheq 'revision 3 'roots '() 'settings (hasheq 'enabled #f) 'documents
                 (list (hasheq 'uri virtual-uri 'path virtual-path 'directory root 'identity 3 'version 1
                               'text "#lang rhombus\nimport \"model.rhm\" as m\ndef answer = m.value\nanswer\n")
                       (hasheq 'uri model-uri 'identity 2 'version 1
                               'text "#lang rhombus\ndef value = 41\nexport value\n"))))
             (for ([position (in-list (list (hasheq 'line 2 'character 16) (hasheq 'line 3 'character 2)))]
                   [target-uri (in-list (list model-uri virtual-uri))]
                   [range (in-list (list (hasheq 'start (hasheq 'line 1 'character 4) 'end (hasheq 'line 1 'character 9))
                                        (hasheq 'start (hasheq 'line 2 'character 4) 'end (hasheq 'line 2 'character 10))))])
               (define result (workspace-analysis-query engine 'definition
                 (hasheq 'uri virtual-uri 'identity 3 'version 1 'position position)))
               (check-true (AnalysisResult? result) (format "~s" result))
               (check-equal? (AnalysisResult-value result) (list (hasheq 'uri target-uri 'range range))))
             (check-false (file-exists? virtual-path)))
           (lambda () (workspace-analysis-close! engine))))))))
