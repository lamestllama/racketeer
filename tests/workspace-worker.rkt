#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/list racket/match racket/path racket/port racket/runtime-path racket/set
         "../vscode/workspace-wire.rkt")

(define-runtime-path worker "../vscode/workspace-worker.rkt")
(define-runtime-path analysis "../vscode/workspace-analysis.rkt")
(define-runtime-path collects "../vscode/language-server/collects")
(define-runtime-path snapshot "../vscode/language-server/collects/racket-langserver/common/source-snapshot.rkt")
(define-runtime-path example-path "../examples/multi-file")
(define example (simplify-path example-path))

(define (with-worker target proc #:observe? [observe? #f])
  ;; Observe declarations before the bootstrap, including its replacement helper.
  (define launch
    `(begin
       (define loaded (make-hash))
       (namespace-set-variable-value! 'worker-loaded loaded #t)
       (define resolve (current-module-name-resolver))
       (current-module-name-resolver
        (case-lambda
          [(name ns) (hash-set! loaded (resolved-module-path-name name) #t) (resolve name ns)]
          [(path from stx load?) (resolve path from stx load?)]))
       (dynamic-require (string->path ,(path->string worker)) #f)))
  (define-values (child from to errors)
    (if observe?
        (subprocess #f #f #f (find-executable-path "racket") "-e" (format "~s" launch))
        (subprocess #f #f #f (find-executable-path "racket") worker)))
  (dynamic-wind
    void
    (lambda ()
      (write (list (map path->bytes (cons collects (current-library-collection-paths)))
                   (for/list ([root (in-list (current-compiled-file-roots))])
                     (if (path? root) (path->bytes root) root))
                   (path->bytes target)) to)
      (flush-output to)
      (proc from to))
    (lambda ()
      (subprocess-kill child #t)
      (subprocess-wait child)
      (close-output-port to)
      (close-input-port from)
      (define message (port->string errors))
      (close-input-port errors)
      (check-equal? message ""))))

(define (reply from)
  (define pending (make-channel))
  (define reader
    (thread (lambda ()
              (channel-put pending
                           (with-handlers ([exn:fail? values]) (read-worker-message from))))))
  (define result (sync/timeout 60 pending))
  (cond [(exn? result) (raise result)]
        ;; Domain comparisons ignore the controller's replacement instruction.
        [result (match result [(list 'retire value) value] [_ result])]
        [else (kill-thread reader) (error 'worker-test "worker did not reply")]))

;; Association and location order is immaterial to definitions and references.
(define (contribution datum)
  (match-define (list path references definitions) datum)
  (list path
        (for/hash ([entry (in-list references)]) (values (car entry) (list->set (cdr entry))))
        (make-immutable-hash definitions)))

(module+ test
  (test-case "dependency compilation is reused within a pass and an edit is seen by the next worker"
    (define directory (make-temporary-file "workspace-worker-cache~a" 'directory))
    (define dependency (build-path directory "dependency.rkt"))
    (define leaf (build-path directory "leaf.rkt"))
    (define compiled (build-path directory "compiled-count"))
    (define seen (build-path directory "seen"))
    (define consumers (for/list ([name '("a.rkt" "b.rkt")]) (build-path directory name)))
    (define counter
      (format "(require (for-syntax racket/base))\n(define-syntax (count-compilation stx) (call-with-output-file ~s #:exists 'append (lambda (out) (display \"compiled\\n\" out))) #'(void))\n(count-compilation)\n"
              (path->string compiled)))
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
         (string-append "#lang racket/base\n(require \"leaf.rkt\")\n(provide value)\n(define value leaf-value)\n" counter)
         dependency)
        (for ([file (in-list consumers)])
          (display-to-file
           (format "#lang racket/base\n(require (for-syntax racket/base \"dependency.rkt\"))\n(begin-for-syntax (call-with-output-file ~s #:exists 'append (lambda (out) (write value out) (newline out))))\n"
                   (path->string seen)) file))
        (for ([value '(1 2)])
          (display-to-file
           (string-append (format "#lang racket/base\n(provide leaf-value)\n(define leaf-value ~a)\n" value) counter)
           leaf #:exists 'truncate)
          ;; Each worker is owned by one pass; replacing it must drop all code.
          (with-worker analysis
            (lambda (from to)
              (define recorded #f)
              (for ([file (in-list consumers)])
                (write-worker-message
                 (list 'analyse file 1048576 #f #f (hash) (list directory) (hash)) to)
                (flush-output to)
                (define result (reply from))
                (check-equal? (car result) 'ok (format "~s" result))
                (define reads (cadr (list-ref result 5)))
                (define dependencies
                  (for/list ([path (in-list (list dependency leaf))])
                    (define entry (assoc path reads))
                    (check-not-false entry "Cached loads must still record transitive dependencies")
                    entry))
                (when recorded (check-equal? dependencies recorded))
                (set! recorded dependencies))))
          (check-equal? (file->lines compiled) (make-list (* 2 value) "compiled"))
          (check-equal? (file->lines seen) (if (= value 1) '("1" "1") '("1" "1" "2" "2")))))
      (lambda () (delete-directory/files directory))))

  (test-case "a disk edit after compilation retains the cached code's original dependency fingerprints"
    (define directory (make-temporary-file "workspace-cache-race~a" 'directory))
    (define leaf (build-path directory "leaf.rkt"))
    (define middle (build-path directory "middle.rkt"))
    (define consumer (build-path directory "consumer.rkt"))
    (define seen (build-path directory "seen"))
    (define (leaf-text value)
      (format "#lang racket/base\n(provide value)\n(define value ~a)\n" value))
    (define (fingerprint file) (call-with-input-file* file sha1-bytes))
    (define (ask from to)
      (write-worker-message
       (list 'analyse consumer 1048576 #f #f (hash) (list directory) (hash)) to)
      (flush-output to)
      (define result (reply from))
      (check-equal? (car result) 'ok (format "~s" result))
      result)
    (dynamic-wind
      void
      (lambda ()
        (display-to-file (leaf-text 1) leaf)
        ;; The value is consumed while compiling middle, so evaluating its
        ;; cached bytecode need not load leaf again.
        (display-to-file
         "#lang racket/base\n(require (for-syntax racket/base \"leaf.rkt\"))\n(provide value)\n(define-syntax (saved stx) (datum->syntax stx value))\n(define value (saved))\n"
         middle)
        (display-to-file
         (format "#lang racket/base\n(require (for-syntax racket/base \"middle.rkt\"))\n(begin-for-syntax (call-with-output-file ~s #:exists 'append (lambda (out) (writeln value out))))\n"
                 (path->string seen)) consumer)
        (define original (fingerprint leaf))
        (with-worker analysis
          (lambda (from to)
            (define first (ask from to))
            (display-to-file (leaf-text 2) leaf #:exists 'truncate)
            (define second (ask from to))
            (for ([result (in-list (list first second))])
              (define reads (cadr (list-ref result 5)))
              (check-equal? (cdr (assoc leaf reads)) original
                            "Cached code must retain the original transitive read")
              (check-equal? (cdr (assoc middle reads)) (fingerprint middle)))
            (check-equal? (file->lines seen) '("1" "1"))
            (check-not-equal? original (fingerprint leaf))
            ;; Exercise the actual predicate used by discovery to select work.
            (current-library-collection-paths (cons collects (current-library-collection-paths)))
            (dynamic-require analysis #f)
            (define current?
              (parameterize ([current-namespace (module->namespace analysis)])
                (eval '(lambda (root path record)
                         (define engine (make-workspace-analysis))
                         (workspace-analysis-update! engine
                           (hasheq 'revision 1 'roots (list (path->uri root)) 'documents '()))
                         (define run (WorkspaceAnalysis-current-run engine))
                         (match-define (list own reads externals resolutions) record)
                         (define result (Result (analysis-basis run) "" #f 0 own reads externals resolutions))
                         (define disk (for/hash ([entry (in-list (cons (cons path own) reads))])
                                        (values (car entry) (disk-fingerprint (car entry)))))
                         (begin0 (result-current? result run path disk disk (make-immutable-hash resolutions))
                                 (workspace-analysis-close! engine))))))
            (check-false (current? directory consumer (list-ref second 5)))))
        (with-worker analysis (lambda (from to) (ask from to)))
        (check-equal? (file->lines seen) '("1" "1" "2")))
      (lambda () (delete-directory/files directory))))

  (test-case "registered external data is not lost behind cached compilation"
    (define directory (make-temporary-file "workspace-cache-external~a" 'directory))
    (define data (build-path directory "value.dat"))
    (define dependency (build-path directory "dependency.rkt"))
    (define consumer (build-path directory "consumer.rkt"))
    (define seen (build-path directory "seen"))
    (dynamic-wind void
      (lambda ()
        (display-to-file "1" data)
        (define original (call-with-input-file* data sha1-bytes))
        (display-to-file
         (format "#lang racket/base\n(require (for-syntax racket/base compiler/cm-accomplice))\n(provide value)\n(define-syntax (saved stx) (register-external-file (string->path ~s)) (datum->syntax stx (call-with-input-file ~s read)))\n(define value (saved))\n"
                 (path->string data) (path->string data)) dependency)
        (display-to-file
         (format "#lang racket/base\n(require (for-syntax racket/base \"dependency.rkt\"))\n(begin-for-syntax (call-with-output-file ~s #:exists 'append (lambda (out) (writeln value out))))\n"
                 (path->string seen)) consumer)
        (with-worker analysis
          (lambda (from to)
            (for ([value '(1 2)])
              (when (= value 2) (display-to-file "2" data #:exists 'truncate))
              (write-worker-message
               (list 'analyse consumer 1048576 #f #f (hash) (list directory) (hash data original)) to)
              (flush-output to)
              (define result (reply from))
              (check-equal? (car result) 'ok (format "~s" result))
              (define entry (assoc data (list-ref (list-ref result 5) 2)))
              (check-not-false entry "The registered external read must be recorded on every use")
              (check-equal? (cdr entry) (if (= value 1) original 'changing)))))
        (check-equal? (file->lines seen) '("1" "2")))
      (lambda () (delete-directory/files directory))))

  (test-case "source snapshots without a cache compile each time and see buffer edits"
    (define directory (make-temporary-file "workspace-snapshot-uncached~a" 'directory))
    (define dependency (build-path directory "dependency.rkt"))
    (define compiled (build-path directory "compiled-count"))
    (define call-with-snapshot (dynamic-require snapshot 'call-with-source-snapshot))
    (dynamic-wind
      void
      (lambda ()
        ;; As in the server, the open buffer can exist without a saved file.
        (for ([value '(1 1 2)])
          (define text
            (format "#lang racket/base\n(provide value)\n(define value ~a)\n(require (for-syntax racket/base))\n(define-syntax (count-compilation stx) (call-with-output-file ~s #:exists 'append (lambda (out) (display \"compiled\\n\" out))) #'(void))\n(count-compilation)\n"
                    value (path->string compiled)))
          (define loaded '())
          (parameterize ([current-namespace (make-base-namespace)])
            (check-equal?
             (call-with-snapshot (hash dependency text)
               #:on-load (lambda (file) (set! loaded (cons file loaded)))
               (lambda () (dynamic-require dependency 'value)))
             value))
          (check-not-false (member dependency loaded)))
        (check-equal? (file->lines compiled) '("compiled" "compiled" "compiled")))
      (lambda () (delete-directory/files directory))))

  (test-case "analysing a file in a worker excludes documentation, database, network and TLS implementations"
    (define probe (make-temporary-file "workspace-worker-probe~a.rkt"))
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
         (string-append
          "#lang racket/base\n(module+ worker\n"
          (format "  (define analysis (string->path ~s))\n" (path->string analysis))
          "  (dynamic-require analysis #f)\n"
          "  (define serve (parameterize ([current-namespace (module->namespace analysis)])\n"
          "                  (eval 'answer-worker-request)))\n"
          (format "  (define receive (dynamic-require '(file ~s) 'read-worker-message))\n"
                  (path->string (build-path (path-only analysis) "workspace-wire.rkt")))
          "  (serve (receive (current-input-port)) (current-output-port))\n"
          "  (write (map (lambda (name) (format \"~s\" name))\n"
          "              (hash-keys (namespace-variable-value 'worker-loaded))))\n"
          "  (newline) (flush-output) (read))\n")
         probe #:exists 'truncate)
        (with-worker probe #:observe? #t
          (lambda (from to)
            (write-worker-message
             (list 'analyse (build-path example "app/orders.rkt") 1048576 #f #f
                   (hash) (list example) (hash)) to)
            (flush-output to)
            (check-equal? (car (reply from)) 'ok)
            (define modules (read from))
            (check-true (list? modules))
            (check-not-false (findf (lambda (name) (regexp-match? #rx"syncheck/traversals" name)) modules))
            (check-equal?
             (filter (lambda (name)
                       ;; URL data/encoding and the shared manual structs do not
                       ;; load documentation indexes or network implementations.
                       (and (regexp-match? #rx"[/\\\\](setup[/\\\\]xref[.]rkt|scribble[/\\\\]|db[/\\\\]|net[/\\\\]|openssl[/\\\\]|racket[/\\\\](tcp|udp)[.]rkt|(docs-helpers|documentation-parser)[.]rkt)" name)
                            (not (regexp-match? #rx"[/\\\\](scribble[/\\\\](manual-struct|core|private[/\\\\]provide-structs)|net[/\\\\](url-string|url-structs|url-exception|uri-codec))[.]rkt" name))))
                     modules)
             '()))))
      (lambda () (delete-file probe))))

  (test-case "multi-file definitions, references and rename match the normal documentation helper"
    (current-library-collection-paths (cons collects (current-library-collection-paths)))
    (dynamic-require analysis #f)
    (define normal-answer
      (parameterize ([current-namespace (module->namespace analysis)]) (eval 'answer)))
    (define files
      (for/list ([name '("main.rkt" "app/orders.rkt" "domain/pricing.rkt" "domain/tax/rates.rkt")])
        (simplify-path (build-path example name))))
    (define sources (for/hash ([file (in-list files)]) (values file (file->string file))))
    (with-worker analysis
      (lambda (from to)
        (define (ask request)
          (write-worker-message request to)
          (flush-output to)
          (define actual (reply from))
          (check-equal? (car actual) 'ok (format "~s" actual))
          (define expected (normal-answer request void))
          (check-equal? (car expected) 'ok)
          (values actual expected))
        (for ([file (in-list files)])
          (define-values (actual expected)
            (ask (list 'analyse file 1048576 #f #f (hash) (list example) (hash))))
          (check-equal? (contribution (cadr actual)) (contribution (cadr expected)))
          (check-true (positive? (list-ref actual 3))))
        (define-values (actual expected)
          (ask (list 'rename sources (list example) '("compiled") 100 (hash)
                     (car files) (hasheq 'line 5 'character 35) "order-sum")))
        (check-equal? actual expected)
        (check-equal? (hash-count (hash-ref (cadr actual) 'changes)) 2)))))
