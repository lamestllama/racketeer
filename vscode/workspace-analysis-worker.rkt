#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Everything that reads, expands or runs project code belongs to the worker.
;; These imports finish before the request loop can start an analysis thread,
;; including the setup roots and libraries that force shared promises.
(require drracket/check-syntax
         racket/class
         syntax/modread
         compiler/compilation-path
         compiler/module-suffix
         racket/file
         racket/lazy-require
         racket/list
         racket/match
         racket/path
         racket/port
         racket/runtime-path
         racket/set
         racket-langserver/common/path-util
         racket-langserver/common/source
         "runtime/racketdap/tools/source-snapshot.rkt"
         racket-langserver/common/interfaces
         racket-langserver/common/json-util
         racket-langserver/doclib/editor
         racket-langserver/doclib/textbuffer/text-port
         racket-langserver/doclib/doc-lang
         "runtime/racketdap/tools/bindings-service.rkt"
         racket-langserver/doclib/internal-types
         "workspace-memory.rkt"
         "language-adapters.rkt"
         "workspace-wire.rkt"
         (submod "workspace-analysis.rkt" worker-support))

(lazy-require ["workspace-rename.rkt" (workspace-rename)])
(define-runtime-path rename-module "workspace-rename.rkt")

;; One allocation over the limit is refused as an exception, where a custodian would be
;; shut down by many. The language server's diagnostics report such an exception from
;; an expansion by printing it into their own error's message.
(define out-of-memory '(out-of-memory))
(define (out-of-memory? e)
  (or (exn:fail:out-of-memory? e)
      (and (exn? e) (regexp-match? #rx"struct:exn:fail:out-of-memory" (exn-message e)))))

;; What a worker does: everything that reads, expands or runs a user's code.
(define (answer request observe [cache #f])
  (with-handlers ([out-of-memory? (lambda (_) out-of-memory)]
                  [(lambda (e) (and (pair? e) (memq (car e) '(changed source)))) values]
                  [(lambda (_) #t)
                   (lambda (e) (cons 'failed (if (exn? e) (exn-message e) (format "~s" e))))])
    (parameterize ([current-output-port (open-output-nowhere)]
                   [current-error-port (open-output-nowhere)]
                   [current-input-port (open-input-string "")]
                   [exit-handler (lambda (_) (error 'workspace-analysis "worker exited"))])
      (match request
        [(list 'discover roots excluded limit files forms)
         (when cache (hash-remove! cache 'document))
         (append (list 'ok) (discover roots excluded limit)
                 (list (for/hash ([file (in-list files)]) (values file (disk-fingerprint file)))
                       (for/hash ([form (in-list forms)]) (values form (resolved-form form)))))]
        [(list 'analyse path max-bytes buffer query buffers roots before)
         (when (and cache (not query)) (hash-remove! cache 'document))
         (observe (if query (cadr query) path))
         ;; Source failures, including unavailable definition targets, leave the
         ;; document to the server. Resource failures and breaks still escape.
         (with-handlers ([(lambda (e) (and query (not (out-of-memory? e)) (not (exn:break? e))
                                          (not (and (pair? e) (memq (car e) '(changed source))))))
                          (lambda (_) (cons 'source "Document could not be analysed"))])
           (define result (analyse path max-bytes buffer query buffers roots before cache))
           (if query (cons 'ok result)
               (match result
                 [(list contribution text count references record)
                  (list 'ok (contribution->datum contribution) text count references record)])))]
        [(list 'rename sources roots excluded limit buffers path position name)
         (define current-analysis-observer (dynamic-require rename-module 'current-analysis-observer))
         (when cache (hash-remove! cache 'document))
         (define (check-snapshot!)
           (unless (snapshot-current? sources roots excluded limit buffers)
             (error 'rename "Workspace files changed. Try Rename again.")))
         (check-snapshot!)
         (define result
           (parameterize ([current-language-adapter-roots roots]
                          [current-analysis-observer observe])
             (workspace-rename sources path position name)))
         (check-snapshot!)
         (list 'ok result)]))))

;; The worker process: workspace-worker.rkt has set its library paths. The request
;; arrives on standard input and the reply leaves on standard output, and analysed
;; code has neither. The analysis runs under two custodians of its own. Its code can
;; shut down the inner one but not the outer, so only the memory limit ends the outer,
;; and this thread survives either to say which happened.
(define (answer-worker-request request to-server [cache #f] #:recycle? [recycle? #f])
  ;; Load rename before its analysis thread can be stopped during initialisation.
  (when (and (pair? request) (eq? (car request) 'rename)) (dynamic-require rename-module #f))
  (define megabytes (worker-megabytes))
  (define limited (make-custodian))
  (custodian-limit-memory limited (* megabytes 1024 1024) limited)
  (define at #f)
  (define result #f)
  (define analysis
    (parameterize ([current-custodian (make-custodian limited)])
      (thread (lambda () (set! result (answer request (lambda (path) (set! at path)) cache))))))
  (void (sync (thread-dead-evt analysis)))
  (define reply
    (cond
      [(equal? result out-of-memory)
       (cons 'stopped (format "analysis~a could not allocate within the ~a MB memory limit for one worker"
                              (if at (format " of ~a" at) "") megabytes))]
      [result result]
      [(custodian-shut-down? limited)
       (cons 'stopped (format "analysis~a went over the ~a MB memory limit for one worker"
                              (if at (format " of ~a" at) "") megabytes))]
      [else (cons 'stopped (format "compile-time code~a ended the analysis" (if at (format " in ~a" at) "")))]))
  (custodian-shutdown-all limited)
  ;; Tell the server before it can send another request. Exiting after an ordinary
  ;; reply would race that next request and could lose a file's analysis.
  (define retire? (and recycle? (>= (worker-memory-bytes) (recycle-bytes))))
  (void (with-handlers ([exn:fail? (lambda (e)
                                     (write-worker-message (cons 'stopped (format "analysis worker could not send its result: ~a" (exn-message e)))
                                                           to-server))])
          (write-worker-message (if retire? (list 'retire reply) reply) to-server)))
  (flush-output to-server))

(module+ worker
  (define from-server (current-input-port))
  (define to-server (current-output-port))
  ;; A pass caches compilation; a query retains only its last document.
  (define dependency-code (make-hash))
  (define requests (make-channel))
  ;; The server closes this pipe when it no longer wants the worker, or when it ends.
  (void (thread (lambda ()
                  (let wait ()
                    (sync from-server)
                    (when (eof-object? (peek-byte from-server)) (exit 0))
                    (channel-put requests (read-worker-message from-server))
                    (wait)))))
  (let loop ()
    (answer-worker-request (channel-get requests) to-server dependency-code #:recycle? #t)
    (loop)))

(define (discover roots excluded limit)
  (define module-suffix-regexp (get-module-suffix-regexp))
  (define found (mutable-set))
  (define visited 0)
  (define incomplete? #f)
  (define (descend? path)
    (and (not (link-exists? path))
         (not (member (path->string (file-name-from-path path)) excluded))))
  (let/ec full
    (for ([root (in-list roots)])
      (with-handlers ([exn:fail:filesystem? (lambda (_) (set! incomplete? #t))])
        (for ([path (in-directory root descend?)])
          (set! visited (add1 visited))
          (when (> visited (* 20 limit)) (set! incomplete? #t) (full (void)))
          (when (and (regexp-match? module-suffix-regexp (path->string path))
                     (file-exists? path) (not (link-exists? path)))
            (when (>= (set-count found) limit) (set! incomplete? #t) (full (void)))
            (set-add! found path))))))
  (list (sort (set->list found) path<?) incomplete?))

(define (snapshot-current? sources roots excluded limit buffers)
  (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
    (match-define (list paths incomplete?) (discover roots excluded limit))
    (and (not incomplete?)
         (set=? (list->set (hash-keys sources))
                (set-union (list->set paths) (list->set (hash-keys buffers))))
         (for/and ([(file text) (in-hash sources)])
           (equal? text
                   (if (hash-has-key? buffers file) (hash-ref buffers file)
                       (call-with-input-file* file
                         (lambda (in) (read-string (add1 (string-length text)) in)))))))))

;; Read and select policy before constructing the sole compact collector. The
;; sequence follows expand-source; the worker already owns its fresh namespace,
;; source snapshot and directory. No display products or expansion logs are kept.
(define (compact-contribution path text roots [query #f])
  (define source (path->source path))
  (define in (open-input-text text))
  (define (source-error e)
    (cond [(or (out-of-memory? e) (exn:break? e)) (raise e)]
          [(exn? e) e]
          [else (error 'workspace-analysis "analysis failed: ~a" path)]))
  (define pre
    (with-handlers ([(lambda (_) #t) source-error])
      (with-module-reading-parameterization
        (lambda () (read-syntax (source-syntax-source source) in)))))
  ;; A descriptor that cannot be resolved fails this analysis, as a read error does.
  (define adapter
    (with-handlers ([(lambda (e) (and (exn:fail? e) (not (out-of-memory? e))))
                     (lambda (_) (error 'workspace-analysis "analysis failed: ~a" path))])
      (resolve-workspace-language-adapter path text pre roots)))
  (define policy (language-policy-with-adapter (source->language-policy text (source-uri source)) adapter))
  (define stx
    (if (and adapter (syntax? pre))
        (syntax-property pre 'racketeer:language-profile adapter) pre))
  (define editor (new lsp-editor%))
  (send editor insert text 0)
  (define collector ((bindings-factory (and adapter (language-adapter-bindings-provider adapter)) #:contribution-only? (not query))
                     source editor #f))
  (define result
    (parameterize ([current-annotations collector])
      (define-values (add-syntax done)
        (make-traversal (current-namespace) (if query (list-ref query 5) (path-only path))))
      (define expanded
        (with-handlers ([(lambda (_) #t) source-error])
          (parameterize ([current-output-port (open-output-nowhere)])
            (and (Language-Policy-expand? policy) (syntax? stx) (expand stx)))))
      (when (syntax? expanded) (add-syntax expanded) (done))
      (define result (ExpandResult stx expanded '()))
      (send collector walk-stx result)
      result))
  ;; A compact pass needs expansion to certify a complete binding graph.
  (define current? (language-adapter-current? adapter))
  (unless (and (or query (not (and adapter (eq? (hash-ref (hash-ref adapter 'editor) 'expand? 'policy) #f))))
               (or (and query (eof-object? pre))
                   (if (Language-Policy-expand? policy)
                       (ExpandResult-all-succeed? result)
                       (and (ExpandResult-pre-syntax result) #t)))
               current?)
    (if query (raise (cons (if current? 'source 'changed)
                           (if current? "Document could not be analysed" "Language profile changed during analysis")))
        (error 'workspace-analysis "analysis failed: ~a" path)))
  (if query (list collector editor) (send collector get-contribution)))

(define (analyse path max-bytes buffer query buffers roots before cache [retry? #t])
  (define basis (list path buffers roots (and query (list-ref query 4))))
  (define held (and query cache (hash-ref cache 'document #f)))
  (when (and held (not (equal? basis (car held))))
    (hash-remove! cache 'document)
    (set! held #f))
  (define bytes
    (if buffer (string->bytes/utf-8 buffer)
        (call-with-input-file* path (lambda (in) (read-bytes (add1 max-bytes) in)))))
  (unless (and (bytes? bytes) (<= (bytes-length bytes) max-bytes))
    (error 'workspace-analysis "file exceeds analysis limit"))
  (define text (bytes->string/utf-8 bytes))
  (define (holds? record)
    (and (equal? (car record) (sha1-bytes bytes)) (record-current? record buffers)))
  (define cached? (and held (holds? (last held))))
  (define reads (make-hash))
  (define resolutions (make-hash))
  (define externals (make-log-receiver (current-logger) 'info 'cm-accomplice))
  (define resolver (current-module-name-resolver))
  (define directory (if query (list-ref query 5) (path-only path)))
  (parameterize ([current-namespace (if cached? (current-namespace) (make-base-namespace))]
                 [current-language-adapter-roots roots]
                 [current-directory (or directory (current-directory))]
                 [current-load-relative-directory directory]
                 [current-module-name-resolver
                  (recording-resolver
                   (if (and directory (or (not query) (file-uri? (cadr query)))) resolver
                       ;; A virtual identity must not supply a save directory.
                       (case-lambda
                         [(name namespace) (resolver name namespace)]
                         [(module relative-to stx load?)
                          (define base (and relative-to
                                            (let ([name (resolved-module-path-name relative-to)])
                                              (if (pair? name) (car name) name))))
                          (define local?
                            (or (equal? base path)
                                (and (not (path? base))
                                     (or (equal? (current-load-relative-directory) directory)
                                         (and (syntax? stx) (equal? (syntax-source stx) path))))))
                          (define relative?
                            (let relative? ([module module])
                              (match module
                                [(? path-string?) (relative-path? module)]
                                [(list 'file (? path-string? name)) (relative-path? name)]
                                [(list* 'submod (and parent (not (or "." ".."))) _) (relative? parent)]
                                [_ #f])))
                          (when (and local? relative? (not directory))
                            (raise-syntax-error #f "Relative imports need a save location" stx))
                          (resolver module
                                    (if (and local? relative? directory)
                                        (make-resolved-module-path (build-path directory (file-name-from-path path)))
                                        relative-to) stx load?)])) resolutions)])
    (call-with-source-snapshot buffers
      #:cache (and (not query) cache)
      #:source? (lambda (file) (or query (not cache)
                                 (for/or ([root (in-list roots)]) (directory-contains? root file))))
      #:on-load (lambda (file) (record-load! reads file buffers))
      #:on-reuse (lambda (_file entries)
                   (for ([entry (in-list entries)])
                     (hash-update! reads (car entry)
                                   (lambda (old) (if (equal? old (cdr entry)) old 'changing))
                                   (cdr entry))))
      (lambda ()
        (define saved
          (cond
            [cached? held]
            [else
             (when (and query cache) (hash-remove! cache 'document))
             (set! held #f)
             (define product (compact-contribution path text roots query))
             (list basis product
                   (list (sha1-bytes bytes) (hash->list reads) (external-reads externals
                     (if query (for/fold ([seen before]) ([(file fingerprint) (in-hash reads)])
                                 (hash-set seen file fingerprint)) before))
                         (hash->list resolutions)))]))
        (define record (last saved))
        (cond
          ;; Registered data is first known after expansion. Observe it before
          ;; one fresh attempt, just as a subsequent workspace pass does.
          [(and query retry? (not (eq? saved held))
                (for/or ([entry (in-list (caddr record))])
                  (and (eq? (cdr entry) 'changing) (not (hash-has-key? before (car entry))))))
           (analyse path max-bytes buffer query buffers roots
                    (for/hash ([entry (in-list (caddr record))])
                      (values (car entry) (disk-fingerprint (car entry)))) cache #f)]
          [else
            (unless (or (not query) (holds? record)) (raise (cons 'changed "Sources changed during analysis")))
            (when (and query cache) (hash-set! cache 'document saved))
            (define navigation
              (and query
                   (let ()
                     (match-define (list operation uri position include? _view _directory) query)
                     (match-define (list service editor) (cadr saved))
                     (define pos (send editor lsp-position->pos (hash-ref position 'line) (hash-ref position 'character)))
                     (define (range r)
                       (define (position offset)
                         (match-define (list line char) (send editor pos->line/char offset))
                         (Pos line char))
                       (Range (position (car r)) (position (cdr r))))
                     (define keys (send service identities-at pos #:predicted? #t))
                     (define modules
                       (filter (lambda (key) (or (file-uri? uri) (not (equal? path (Module-Binding-filepath key)))))
                               (if (eq? operation 'references)
                                   (send service reference-module-bindings-at pos)
                                   (filter Module-Binding? keys))))
                     (case operation
                       [(definition)
                        (remove-duplicates
                         (append
                          (for/list ([r (in-list (send service definitions keys))])
                            (->jsexpr (Location uri (range r))))
                          (for*/list ([file (in-list (remove-duplicates (map Module-Binding-filepath modules)))]
                                      #:unless (equal? file path)
                                      [target (in-value (car (analyse file max-bytes (hash-ref buffers file #f) #f
                                                                     buffers roots before #f)))]
                                      [key (in-list modules)] #:when (equal? file (Module-Binding-filepath key))
                                      [location (in-value (hash-ref (Doc-Contribution-definitions target) key #f))]
                                      #:when location)
                            (->jsexpr location))))]
                       [(highlights)
                        (for/list ([r (in-list (send service reference-ranges-at pos #t))])
                          (hasheq 'range (->jsexpr (range r))))]
                       [else
                        (list (for/list ([r (in-list (send service reference-ranges-at pos include?))])
                                (->jsexpr (Location uri (range r))))
                              (and (pair? modules) (cons 'bindings (map binding->datum modules))))]))))
            (if query (list navigation record)
                (let ([contribution (cadr saved)])
                  (list contribution text
                        (+ (hash-count (Doc-Contribution-definitions contribution))
                           (for/sum ([locations (in-hash-values (Doc-Contribution-references contribution))])
                             (length locations)))
                        #f record)))])))))

;; A .ss file is loaded only while the .rkt beside it is absent, so that absence
;; is read as well.
(define (record-load! reads file buffers)
  (define recorded (make-hash))
  (define (record! file)
    (hash-set! recorded file
               (hash-ref! reads file
                          (lambda ()
                            (if (hash-has-key? buffers file)
                                (buffer-fingerprint (hash-ref buffers file))
                                (disk-fingerprint file))))))
  (record! file)
  ;; With no source to read, what the loader reads is the compiled code.
  (unless (or (hash-has-key? buffers file) (file-exists? file))
    (for* ([root (in-list (current-compiled-file-roots))]
           [mode (in-list (use-compiled-file-paths))])
      (record! (get-compilation-bytecode-file file #:modes (list mode) #:roots (list root)))))
  (when (equal? (path-get-extension file) #".ss")
    (record! (path-replace-extension file #".rkt")))
  (hash->list recorded))

;; Where a collection path leads depends on the links and on which directories
;; hold the file, so what it found is read as well. A relative path leads to one file.
(define (collection-form? module)
  (match module
    [(? symbol?) #t]
    [(list 'lib _ ...) #t]
    [(list 'submod parent _ ...) (collection-form? parent)]
    [_ #f]))

(define (recording-resolver resolve resolutions)
  (case-lambda
    [(name namespace) (resolve name namespace)]
    [(module relative-to stx load?)
     (define form? (collection-form? module))
     (define resolved
       (with-handlers ([exn:fail? (lambda (e)
                                    (when form? (hash-set! resolutions module #f))
                                    (raise e))])
         (resolve module relative-to stx load?)))
     (when form? (hash-set! resolutions module (resolved-module-path-name resolved)))
     resolved]))

;; A registered file is logged once the expansion has read it, so what it holds now
;; may not be what was read, whatever its date says. Only a file that holds the same at
;; the start of the pass and at the end of the analysis can be matched to what was read:
;; 'changing matches nothing. A file no earlier pass has seen is read again by the next.
(define (external-reads receiver before)
  (let drain ([files (hash)])
    (match (sync/timeout 0 receiver)
      [#f (hash->list files)]
      [(vector _ _ (? prefab-struct-key dependency) _)
       (define file (vector-ref (struct->vector dependency) 1))
       (drain (if (path? file)
                  (let ([now (disk-fingerprint file)])
                    (hash-set files file
                              (if (and (hash-has-key? before file)
                                       (equal? now (hash-ref before file)))
                                  now 'changing)))
                  files))]
      [_ (drain files)])))

(define (binding->datum binding)
  (list (Module-Binding-filepath binding) (Module-Binding-submods binding)
        (Module-Binding-phase+space binding) (Module-Binding-id binding)))

(define (contribution->datum contribution)
  (list (Doc-Contribution-path contribution)
        (for/list ([(binding locations) (in-hash (Doc-Contribution-references contribution))])
          (cons (binding->datum binding) (map ->jsexpr locations)))
        (for/list ([(binding location) (in-hash (Doc-Contribution-definitions contribution))])
          (cons (binding->datum binding) (->jsexpr location)))))

