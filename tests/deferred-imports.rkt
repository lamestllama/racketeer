#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/file racket/list racket/runtime-path racket/port json
         "../vscode/workspace-wire.rkt")

(define-runtime-path attach "../racketdap/worker/attach.rkt")
(define-runtime-path packages "../racketdap/packages.rkt")
(define-runtime-path source "../racketdap/wxme-source.rkt")
(define-runtime-path decoder "../racketdap/wxme-decode.rkt")
(define-runtime-path fixtures "fixtures/wxme-debug")

(define (declared? namespace path)
  (parameterize ([current-namespace namespace])
    (module-declared? path #f)))

(module+ test
  (test-case "an embedded attach host loads in a different module registry without sockets"
    (parameterize ([current-namespace (make-base-namespace)])
      (check-equal? (dynamic-require attach 'attach-api-version) 1)
      (define attachment ((dynamic-require attach 'start-attach)))
      (check-not-false (sync/timeout 0 ((dynamic-require attach 'attachment-ended-evt) attachment)))
      ((dynamic-require attach 'close-attachment!) attachment)))

  (test-case "deferred package imports belong to their defining registry on first use"
    (define owner (make-base-namespace))
    (define caller (make-base-namespace))
    (define-values (roots inventory)
      (parameterize ([current-namespace owner])
        (values (dynamic-require packages 'package-source-roots)
                (dynamic-require packages 'installed-packages))))
    (check-false (declared? owner 'pkg/lib))
    (parameterize ([current-namespace caller])
      ;; The first call exercises the keyword argument to pkg-directory; the
      ;; inventory exercises every other deferred export, including its structs.
      (define directories (roots '("rackunit-lib")))
      (define entry (findf (lambda (pkg) (equal? (hash-ref pkg 'name) "rackunit-lib")) (inventory)))
      (check-not-false entry)
      (check-equal? (map path->string directories) (list (hash-ref entry 'directory)))
      (check-eq? (current-namespace) caller))
    (check-true (declared? owner 'pkg/lib))
    (check-false (declared? caller 'pkg/lib)))

  (test-case "deferred structured source decoding belongs to its defining registry on first use"
    (define owner (make-base-namespace))
    (define caller (make-base-namespace))
    (define text (parameterize ([current-namespace owner]) (dynamic-require source 'source-text)))
    (check-false (declared? owner decoder))
    (define bytes (file->bytes (build-path fixtures "objects.wxme")))
    (define expected (hash-ref (call-with-input-file (build-path fixtures "expected.json") read-json) 'objects))
    (parameterize ([current-namespace caller])
      (check-equal? (text bytes) expected)
      (check-equal? (text (subbytes bytes (bytes-length #"#reader(lib\"read.ss\"\"wxme\")"))) expected)
      (check-eq? (current-namespace) caller))
    (check-true (declared? owner decoder))
    (check-false (declared? caller decoder))))


(define-runtime-path environment "../vscode/racket-environment.rkt")
(define-runtime-path index "../vscode/workspace-index.rkt")
(define-runtime-path engine "../vscode/workspace-analysis.rkt")
(define-runtime-path bootstrap "../vscode/workspace-worker.rkt")
(define-runtime-path analysis "../vscode/workspace-analysis-worker.rkt")
(define-runtime-path wire "../vscode/workspace-wire.rkt")

;; Observe declarations in a fresh process, before either the environment or the
;; worker bootstrap loads. The worker still installs its documentation stub.
(define (with-imports worker? proc)
  (define probe (make-temporary-file "deferred-imports~a.rkt"))
  (define root (make-temporary-file "deferred-front~a" 'directory))
  (define file (build-path root "program.rkt"))
  (define text "#lang racket/base\n(provide value)\n(define value 42)\nvalue\n")
  (define child #f)
  (define from #f)
  (define to #f)
  (define errors #f)
  (dynamic-wind
    void
    (lambda ()
      (display-to-file text file)
      (display-to-file
       (format
        "#lang racket/base\n(module+ worker\n  (define analysis (string->path ~s))\n  (dynamic-require analysis #f)\n  (define serve (parameterize ([current-namespace (module->namespace analysis)]) (eval 'answer-worker-request)))\n  (define receive (dynamic-require '(file ~s) 'read-worker-message))\n  (let loop ()\n    (serve (receive (current-input-port)) (current-output-port))\n    (write (sort (hash-keys (namespace-variable-value 'imported-modules)) string<?))\n    (newline) (flush-output) (loop)))\n"
        (path->string analysis) (path->string wire))
       probe #:exists 'truncate)
      (define launch
        `(begin
           (define loaded (make-hash))
           (namespace-set-variable-value! 'imported-modules loaded #t)
           (define resolve (current-module-name-resolver))
           (current-module-name-resolver
            (case-lambda
              [(name ns)
               (define value (resolved-module-path-name name))
               (define file (if (pair? value) (car value) value))
               (when (path? file) (hash-set! loaded (path->string file) #t))
               (resolve name ns)]
              [(path from stx load?) (resolve path from stx load?)]))
           ,(if worker?
                `(dynamic-require (string->path ,(path->string bootstrap)) #f)
                `(begin
                   (dynamic-require (string->path ,(path->string environment)) #f)
                   (dynamic-require (string->path ,(path->string index)) #f)
                   (define (api name) (dynamic-require (string->path ,(path->string engine)) name))
                   (define analysis ((api 'make-workspace-analysis)))
                   (define uri ((dynamic-require 'racket-langserver/common/path-util 'path->uri) (string->path ,(path->string file))))
                   ((api 'workspace-analysis-update!) analysis
                    (hasheq 'revision 1 'roots (list ((dynamic-require 'racket-langserver/common/path-util 'path->uri) (string->path ,(path->string root))))
                            'documents (list (hasheq 'uri uri 'identity 1 'version 1 'text ,text))))
                   (define result
                     ((api 'workspace-analysis-query) analysis 'references
                      (hasheq 'uri uri 'identity 1 'version 1 'includeDeclaration #t
                              'position (hasheq 'line 3 'character 2))))
                   (unless (and ((api 'AnalysisResult?) result) (pair? ((api 'AnalysisResult-value) result)))
                     (error 'imports "front end did not index and query its store: ~s" result))
                   ((api 'workspace-analysis-close!) analysis)
                   (write (sort (hash-keys loaded) string<?))))))
      ;; The child's diagnostics are checked below, and a CI job turns tracing on.
      (define quiet (environment-variables-copy (current-environment-variables)))
      (environment-variables-set! quiet #"RACKETEER_INDEX_TRACE" #f)
      (set!-values (child from to errors)
                   (parameterize ([current-environment-variables quiet])
                     (subprocess #f #f #f (find-executable-path "racket") "-e" (format "~s" launch))))
      (when worker?
        (write (list (map path->bytes (current-library-collection-paths))
                     (for/list ([root (in-list (current-compiled-file-roots))])
                       (if (path? root) (path->bytes root) root))
                     (path->bytes probe)) to)
        (flush-output to))
      (proc from to))
    (lambda ()
      (when child
        (subprocess-kill child #t)
        (subprocess-wait child)
        (close-input-port from)
        (close-output-port to)
        (define message (port->string errors))
        (close-input-port errors)
        (check-equal? message ""))
      (delete-file probe)
      (delete-directory/files root))))

(define (worker-imports from to request)
  (write-worker-message request to)
  (flush-output to)
  (define result (read-worker-message from))
  (check-equal? (car result) 'ok (format "~s" result))
  (define modules (read from))
  (read-line from)
  (check-true (and (list? modules) (andmap string? modules)))
  modules)

(define (check-imports modules patterns)
  (check-true (pair? modules))
  (for ([pattern (in-list patterns)])
    (with-check-info (['modules modules] ['forbidden pattern])
      (check-equal? (filter (lambda (name) (regexp-match? pattern name)) modules) '()))))

(define front-imports
  (list #rx"drracket/check-syntax[.]rkt" #rx"syncheck[/\\\\]"
        #rx"doclib[/\\\\]doc[.]rkt" #rx"workspace-rename[.]rkt"
        #rx"language-adapters[.]rkt" #rx"[/\\\\]adapters[/\\\\]"))
(define index-imports
  (list #rx"doclib[/\\\\]doc[.]rkt" #rx"doclib[/\\\\]format(ting[.]rkt|ter[/\\\\])"
        #rx"doclib[/\\\\]service[/\\\\]typed-racket[/\\\\]" #rx"workspace-rename[.]rkt"))

(module+ test
  (test-case "the index front end loads no analysis, documentation, rename or adapters"
    (with-imports #f (lambda (from _to) (check-imports (read from) front-imports))))

  (for ([query? '(#f #t)])
    (test-case (if query? "navigation defers display and rename imports"
                  "indexing defers display and rename imports")
      (define root (make-temporary-file "deferred-source~a" 'directory))
      (dynamic-wind void
        (lambda ()
          (define file (build-path root "program.rkt"))
          (define text "#lang racket/base\n(define value 42)\nvalue\n")
          (display-to-file text file)
          (with-imports #t
            (lambda (from to)
              (define modules
                (worker-imports from to
                  (list 'analyse file 1048576 #f
                        (and query? (list 'definition "file:///program.rkt"
                                          (hasheq 'line 2 'character 2) #f (hash) root))
                        (hash) (list root) (hash))))
              (check-not-false (findf (lambda (name) (regexp-match? #rx"syncheck[/\\\\]traversals[.]rkt" name)) modules))
              (check-imports modules index-imports)
              ;; A later rename uses the same process and must load its machinery.
              (define renamed
                (worker-imports from to
                  (list 'rename (hash file text) (list root) '() 1000 (hash file text)
                        file (hasheq 'line 2 'character 2) "renamed")))
              (for ([pattern (in-list index-imports)])
                (check-not-false (findf (lambda (name) (regexp-match? pattern name)) renamed))))))
        (lambda () (delete-directory/files root))))))
