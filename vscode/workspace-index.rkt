#lang racket/base

;; Racketeer's workspace index owns snapshots and result lifetimes. The upstream
;; document analyser and contribution store are used as libraries, without an
;; LSP server, live SafeDocs, or changes to their implementation.
(require compiler/module-suffix
         racket/file
         racket/list
         racket/match
         racket/path
         racket/place
         racket/port
         racket/set
         racket-langserver/common/path-util
         racket-langserver/common/interfaces
         racket-langserver/common/json-util
         racket-langserver/doclib/doc
         racket-langserver/doclib/internal-types
         racket-langserver/workspace/api
         racket-langserver/lsp/compose/references
         racket-langserver/lsp/msg-io
         racket-langserver/lsp/responses
         "workspace-rename.rkt")

(struct Settings (enabled? excluded max-files max-bytes timeout) #:transparent)
(define default-excluded '(".git" "compiled" "node_modules" ".test-output" "dist" "build"))
(struct Run (generation cancel done state indexed failures workspace documents buffers settings roots sources reusable?) #:mutable)
(define current-run #f)
(define state-lock (make-semaphore 1))
(define worker-slot (make-semaphore 1))
(define pending (make-hash))
(define notify-client void)

(define (bounded config key fallback low high)
  (define value (hash-ref config key fallback))
  (if (and (exact-integer? value) (<= low value high)) value fallback))

(define (read-settings config)
  (define excluded (hash-ref config 'excludedDirectories default-excluded))
  (Settings (eq? #t (hash-ref config 'enabled #t))
            (if (and (list? excluded) (andmap string? excluded)) excluded default-excluded)
            (bounded config 'maxFiles 1000 1 10000)
            (bounded config 'maxFileBytes 1048576 1 10485760)
            (bounded config 'timeoutSeconds 20 1 90)))

(define (cancelled? run)
  (sync/timeout 0 (semaphore-peek-evt (Run-cancel run))))

(define (analysis-failure result)
  (match result
    [(cons 'failed message) message]
    [(cons 'timeout seconds) (format "analysis exceeded its ~a second time limit" seconds)]
    [_ "analysis worker stopped without a result"]))

(define (status run)
  (hasheq 'state (Run-state run) 'indexed (Run-indexed run) 'failures (Run-failures run)))

(define (report! run state indexed failures)
  (call-with-semaphore state-lock
                       (lambda ()
                         (when (eq? run current-run)
                           (set-Run-state! run state)
                           (set-Run-indexed! run indexed)
                           (set-Run-failures! run failures)
                           (notify-client "status" (status run))))))

(define (compute run seconds request [cancel never-evt])
  (cond
    [(eq? worker-slot (sync worker-slot (semaphore-peek-evt (Run-cancel run)) cancel))
     (dynamic-wind void
                   (lambda () (and (not (cancelled? run)) (not (sync/timeout 0 cancel)) (compute/slot run seconds request cancel)))
                   (lambda () (semaphore-post worker-slot)))]
    [else #f]))

(define (compute/slot run seconds request cancel)
  ;; Cancellation must discard the runtime doing the work, including its module
  ;; loading state. The controlling thread only exchanges immutable snapshots.
  (define worker
    (place channel
      (custodian-limit-memory (current-custodian) (* 256 1024 1024))
      (define result
        (with-handlers ([(lambda (_) #t)
                         (lambda (e) (cons 'failed (if (exn? e) (exn-message e) (format "~s" e))))])
          (parameterize ([current-output-port (open-output-nowhere)]
                         [current-error-port (open-output-nowhere)]
                         [current-input-port (open-input-string "")]
                         [exit-handler (lambda (_) (error 'workspace-analysis "worker exited"))])
            (match (place-channel-get channel)
              [(list 'discover roots excluded limit)
               (cons 'ok (discover roots excluded limit))]
              [(list 'analyse path max-bytes buffer query)
               (match-define (list contribution text count references disk-current?) (analyse path max-bytes buffer query))
               (if contribution (list 'ok (contribution->datum contribution) text count references disk-current?) '(changed))]
              [(list 'verify sources roots excluded limit buffers)
               (list 'ok (and (for/and ([(file text) (in-hash buffers)])
                               (and text (equal? text (hash-ref sources file #f))))
                             (snapshot-current? sources roots excluded limit (hash))))]
              [(list 'rename sources roots excluded limit buffers path position name)
               (define (check-snapshot!)
                 (unless (snapshot-current? sources roots excluded limit buffers)
                   (error 'rename "Workspace files changed. Try Rename again.")))
               (check-snapshot!)
               (define result (workspace-rename sources path position name))
               (check-snapshot!)
               (list 'ok result)]))))
      (place-channel-put channel result)
      ;; Keep a successful reply distinguishable from an abnormal early exit.
      (place-channel-get channel)))
  (define dead (place-dead-evt worker))
  (dynamic-wind
    void
    (lambda ()
      (place-channel-put worker request)
      (define finished
        (sync/timeout seconds worker dead
                      (semaphore-peek-evt (Run-cancel run)) cancel))
      (cond [(not finished) (cons 'timeout seconds)]
            [(pair? finished) finished]
            [(eq? finished dead) (cons 'failed "analysis worker exited")]
            [else #f]))
    (lambda () (place-kill worker) (place-wait worker))))

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

(define (analyse path max-bytes buffer query)
  (let/ec changed
    (define captured-text (and query (cadddr query)))
    (define bytes
      (with-handlers ([exn:fail:filesystem?
                       (lambda (e) (if captured-text (changed (list #f #f 0 #f #f)) (raise e)))])
        (if buffer (string->bytes/utf-8 buffer)
            (call-with-input-file* path (lambda (in) (read-bytes (add1 max-bytes) in))))))
    (unless (and (bytes? bytes) (<= (bytes-length bytes) max-bytes))
      (error 'workspace-analysis "file exceeds analysis limit: ~a" path))
    (define text (bytes->string/utf-8 bytes))
    (when (and captured-text
               (not (equal? (regexp-replace* #rx"\r\n" captured-text "\n")
                            (regexp-replace* #rx"\r\n" text "\n"))))
      (changed (list #f text 0 #f #f)))
    ;; Trace construction and queries use a fresh namespace as well as expansion.
    ;; A previously loaded dependency must not survive a watched change.
    (parameterize ([current-namespace (make-base-namespace)]
                   [current-directory (path-only path)]
                   [current-load-relative-directory (path-only path)])
      (define doc (make-doc (path->uri path) text 0))
      (unless (doc-expand! doc) (error 'workspace-analysis "analysis failed: ~a" path))
      (define contribution (Doc-contribution doc))
      (define facts
        (+ (hash-count (Doc-Contribution-definitions contribution))
           (for/sum ([locations (in-hash-values (Doc-Contribution-references contribution))])
             (length locations))))
      ;; Imports use disk text, so analysis with an unsaved buffer cannot be
      ;; reused after that buffer is saved, even if its text stays unchanged.
      (define disk-current?
        (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
          (equal? bytes (call-with-input-file* path
                          (lambda (in) (read-bytes (add1 max-bytes) in))))))
      (unless (or buffer disk-current?)
        (if captured-text (changed (list #f text 0 #f #f))
            (error 'workspace-analysis "file changed during analysis: ~a" path)))
      (list contribution text facts
            (and query
                 (let ([result (doc-references doc (car query) (jsexpr->Pos (cadr query)) (caddr query))])
                   (and result
                        (list (map ->jsexpr (Reference-Source-locations (Document-Reference-Result-source result)))
                              (and (Document-Reference-Result-module-binding result)
                                   (binding->datum (Document-Reference-Result-module-binding result)))))))
            disk-current?))))

(define (binding->datum binding)
  (list (Module-Binding-filepath binding) (Module-Binding-submods binding)
        (Module-Binding-phase+space binding) (Module-Binding-id binding)))

(define (contribution->datum contribution)
  (list (Doc-Contribution-path contribution)
        (for/list ([(binding locations) (in-hash (Doc-Contribution-references contribution))])
          (cons (binding->datum binding) (map ->jsexpr locations)))
        (for/list ([(binding location) (in-hash (Doc-Contribution-definitions contribution))])
          (cons (binding->datum binding) (->jsexpr location)))))

(define (datum->contribution datum)
  (match-define (list path references definitions) datum)
  (Doc-Contribution path
                    (for/hash ([entry (in-list references)])
                      (values (apply Module-Binding (car entry)) (map jsexpr->Location (cdr entry))))
                    (for/hash ([entry (in-list definitions)])
                      (values (apply Module-Binding (car entry)) (jsexpr->Location (cdr entry))))))

(define (run-index run previous)
  (define config (Run-settings run))
  (define indexed 0)
  (define failures (count not (hash-values (Run-buffers run))))
  (define bytes 0)
  (define facts 0)
  (dynamic-wind
    void
    (lambda ()
      (define stopped? (sync/timeout 0.3 (semaphore-peek-evt (Run-cancel run))))
      ;; Only document lifetime changes may reuse a complete index. Verify
      ;; the new buffer/disk view in a cancellable worker before sharing it.
      (define reuse?
        (and (not stopped?) previous
             (equal? '(ok #t)
                     (compute run 10
                              (list 'verify (make-immutable-hash (hash->list (Run-sources previous)))
                                    (Run-roots run) (Settings-excluded config)
                                    (Settings-max-files config) (Run-buffers run))))))
      (when reuse?
        (set-Run-workspace! run (Run-workspace previous))
        (set-Run-sources! run (Run-sources previous))
        (report! run "ready" (Run-indexed previous) 0))
      (unless (or stopped? reuse?)
        (match (compute run 10 (list 'discover (Run-roots run) (Settings-excluded config)
                                     (Settings-max-files config)))
          [(list 'ok paths incomplete?)
           (when incomplete?
             (set! failures (add1 failures))
             (eprintf "Workspace discovery incomplete after finding ~a files under ~a\n"
                      (length paths) (Run-roots run)))
           (define sources
             (append (for/list ([(path text) (in-hash (Run-buffers run))] #:when text) path)
                     (filter (lambda (path) (not (hash-has-key? (Run-buffers run) path))) paths)))
           (when (> (length sources) (Settings-max-files config)) (set! failures (add1 failures)))
           (for ([path (in-list sources)] [n (in-range (Settings-max-files config))]
                 #:break (or (cancelled? run) (> bytes (* 16 1024 1024)) (> facts 200000)))
             (match (compute run (Settings-timeout config)
                             (list 'analyse path (Settings-max-bytes config)
                                   (hash-ref (Run-buffers run) path #f) #f))
               [(list 'ok contribution text count _ disk-current?)
                (unless disk-current? (set-Run-reusable?! run #f))
                (set! bytes (+ bytes (bytes-length (string->bytes/utf-8 text))))
                (set! facts (+ facts count))
                (cond
                  [(or (> bytes (* 16 1024 1024)) (> facts 200000)) (set! failures (add1 failures))]
                  [else
                   ;; Each run has its own store. A retired worker can never
                   ;; populate a replacement run, even if cancellation is late.
                   (workspace-set-contribution! (Run-workspace run) (datum->contribution contribution))
                   (hash-set! (Run-sources run) path text)
                   (set! indexed (add1 indexed))])]
               [failure
                (set! failures (add1 failures))
                (unless (cancelled? run)
                  (eprintf "Workspace analysis incomplete: ~a (~a)\n" path (analysis-failure failure)))])
             (report! run "indexing" indexed failures))
           (report! run (if (zero? failures) "ready" "partial") indexed failures)]
          [failure
           (unless (cancelled? run)
             (eprintf "Workspace discovery incomplete: ~a\n" (analysis-failure failure)))
           (report! run "partial" indexed (add1 failures))])))
    (lambda () (semaphore-post (Run-done run)))))

;; The extension sends complete snapshots: text, document identities, roots and
;; settings have one revision. No incremental edit state is shared with the LSP.
(define (update! params)
  (define revision (hash-ref params 'revision))
  (define config (read-settings (hash-ref params 'settings (hasheq))))
  (define roots (map uri->path (hash-ref params 'roots)))
  (define workspace (make-workspace))
  (for ([root (in-list roots)]) (workspace-add-folder! workspace root))
  (define documents
    (for/hash ([doc (in-list (hash-ref params 'documents))]) (values (hash-ref doc 'uri) doc)))
  (define buffers
    (for/fold ([buffers (hash)]) ([(uri doc) (in-hash documents)])
      (define path (uri->path uri))
      (if (workspace-contains? workspace path)
          (hash-set buffers path (and (not (hash-has-key? buffers path)) (hash-ref doc 'text)))
          buffers)))
  (call-with-semaphore state-lock
                       (lambda ()
                         (when (or (not current-run) (> revision (Run-generation current-run)))
                           (define previous
                             (and (eq? #t (hash-ref params 'documentsOnly #f)) current-run
                                  (equal? "ready" (Run-state current-run))
                                  (Run-reusable? current-run)
                                  (equal? config (Run-settings current-run))
                                  (equal? roots (Run-roots current-run))
                                  current-run))
                           (when current-run (semaphore-post (Run-cancel current-run)))
                           (define run
                             (Run revision (make-semaphore) (make-semaphore)
                                  (if (Settings-enabled? config) "indexing" "disabled") 0 0
                                  workspace documents buffers config roots (make-hash) #t))
                           (set! current-run run)
                           (notify-client "status" (status run))
                           (if (Settings-enabled? config)
                               (thread (lambda ()
                                         (with-handlers ([exn:fail? (lambda (e)
                                                                      (eprintf "Workspace analysis failed: ~a\n" (exn-message e))
                                                                      (report! run "partial" (Run-indexed run) (add1 (Run-failures run)))
                                                                      (semaphore-post (Run-done run)))])
                                           (run-index run previous))))
                               (semaphore-post (Run-done run)))))))

(define (query id params cancel method)
  (define uri (hash-ref params 'uri))
  (define path (uri->path uri))
  (define captured-text (and (equal? method "references") (hash-ref params 'text #f)))
  (define (current-document run)
    (define doc (hash-ref (Run-documents run) uri #f))
    (cond
      [captured-text
       ;; Captured sources own their request lifetime. File documents can close
       ;; while indexing; use their current buffer or read the file afresh.
       (cond [(hash-has-key? (Run-buffers run) path)
              (define text (hash-ref (Run-buffers run) path))
              (and text (hasheq 'text text))]
             [else (or doc (hasheq 'text #f))])]
      [else
       (and doc (equal? (hash-ref doc 'identity) (hash-ref params 'identity))
            (equal? (hash-ref doc 'version) (hash-ref params 'version)) doc)]))
  (let retry ()
    (define run (call-with-semaphore state-lock (lambda () current-run)))
    (define doc (and run (current-document run)))
    (cond
      [(sync/timeout 0 cancel) (error-response id -32800 "Request cancelled")]
      [(not doc) (error-response id -32801 "Document changed during analysis")]
      [(not (Settings-enabled? (Run-settings run)))
       (if (equal? method "references") (success-response id '())
           (error-response id -32803 "Enable workspace analysis to rename safely across files."))]
      [else
       (sync cancel (semaphore-peek-evt (Run-done run)) (semaphore-peek-evt (Run-cancel run)))
       (cond
         [(or (cancelled? run) (sync/timeout 0 cancel)) (retry)]
         [(not (equal? method "references"))
          (define result
            (if (not (equal? (Run-state run) "ready"))
                (cons 'failed "Workspace analysis is incomplete. Resolve its errors before renaming.")
                ;; Rename validates both complete source views. Bound the whole
                ;; transaction separately from the per-file indexing budget.
                (compute run (if (equal? method "rename") 90 (Settings-timeout (Run-settings run)))
                         (list 'rename (make-immutable-hash (hash->list (Run-sources run)))
                               (Run-roots run) (Settings-excluded (Run-settings run))
                               (Settings-max-files (Run-settings run)) (Run-buffers run)
                               path (hash-ref params 'position) (hash-ref params 'newName #f)) cancel)))
          (or (call-with-semaphore state-lock
                (lambda ()
                  (and (eq? run current-run) (not (sync/timeout 0 cancel))
                       (match result
                         [(list 'ok edit) (success-response id (hasheq 'revision (Run-generation run) 'result edit))]
                         [failure (error-response id -32803 (analysis-failure failure))]))))
              (retry))]
         [else
          (define include? (hash-ref params 'includeDeclaration))
          ;; Local and module references use the same fresh analysis. No global
          ;; LSP trace or stale contribution is mixed into the index's results.
          (define result
            (compute run (Settings-timeout (Run-settings run))
                     (list 'analyse path (Settings-max-bytes (Run-settings run))
                           (hash-ref doc 'text) (list uri (hash-ref params 'position) include? captured-text)) cancel))
          (define answer
            (call-with-semaphore state-lock
                                 (lambda ()
                                   (and (eq? run current-run) (not (sync/timeout 0 cancel))
                                        (match result
                                          ['(changed)
                                           (error-response id -32801 "Captured source differs from the current file")]
                                          [(list 'ok _ _ _ #f _) (success-response id '())]
                                          [(list 'ok _ _ _ (list locations binding) _)
                                           (define live
                                             (Document-Reference-Result
                                               (Reference-Source path (map jsexpr->Location locations))
                                               (and binding (apply Module-Binding binding))))
                                           (success-response id
                                                             (->jsexpr (reference-sources->locations
                                                                         (merge-reference-sources (Run-workspace run) live include?))))]
                                          [failure (error-response id -32603 (analysis-failure failure))])))))
          (or answer (retry))])])))

(define (serve)
  (define protocol-out (current-output-port))
  (define (reply message) (display-message/flush message protocol-out))
  (set! notify-client
        (lambda (method params) (reply (hasheq 'jsonrpc "2.0" 'method method 'params params))))
  (for ([message (in-port read-message)])
    (define id (and (hash? message) (hash-ref message 'id #f)))
    (with-handlers ([exn:fail? (lambda (e)
                                 (if id (reply (error-response id -32603 (exn-message e)))
                                     (eprintf "Index message failed: ~a\n" (exn-message e))))])
      (parameterize ([current-output-port (open-output-nowhere)])
        (define params (hash-ref message 'params (hasheq)))
        (match (hash-ref message 'method)
          [(or "initialize" "update")
           (update! params)
           (when id (reply (success-response id (hasheq))))]
          [(and method (or "references" "prepareRename" "rename"))
           (define cancel (make-semaphore))
           (hash-set! pending id cancel)
           (thread
             (lambda ()
               (dynamic-wind void
                             (lambda ()
                               (reply (with-handlers ([exn:fail? (lambda (e) (error-response id -32603 (exn-message e)))])
                                        (query id params (semaphore-peek-evt cancel) method))))
                             (lambda () (hash-remove! pending id)))))]
          ["$/cancelRequest"
           (define cancel (hash-ref pending (hash-ref params 'id) #f))
           (when cancel (semaphore-post cancel))]
          [_ (when id (reply (error-response id -32601 "Unknown index method")))]))))
  (when current-run (semaphore-post (Run-cancel current-run))))

(module+ main (serve))
