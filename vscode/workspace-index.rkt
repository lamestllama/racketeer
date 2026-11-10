#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require json
         racket/list
         racket/match
         racket/path
         racket/port
         racket/string
         racket-langserver/common/path-util
         (only-in racket-langserver/lsp/msg-io display-message/flush)
         racket-langserver/lsp/responses
         "workspace-analysis.rkt")

;; A frame is written in several steps, and a full pipe can suspend any of them.
;; Results and status reports come from different threads, so each frame waits
;; for the one before it. A procedure makes its message once those are written, so
;; that it can answer from what has been read while they were.
(define (make-reply out)
  (define writing (make-semaphore 1))
  (lambda (message)
    (call-with-semaphore writing
      (lambda () (display-message/flush (if (procedure? message) (message) message) out)))))

;; Each body belongs to one frame, including a malformed body. Decode only
;; after taking its byte count, then require exactly one JSON value.
(define (read-index-message [in (current-input-port)])
  (let/ec return
    (define length #f)
    (define valid? #t)
    (let headers ()
      (define line (read-bytes-line in 'return-linefeed))
      (cond
        [(eof-object? line) (return eof)]
        [(bytes=? line #"") (void)]
        [else
         (match (regexp-match #rx#"^([^:]+):[ ]*(.*)$" line)
           [(list _ key value)
            (cond
              [(string-ci=? (bytes->string/latin-1 key) "Content-Length")
               (if (and (not length) (regexp-match? #rx#"^[0-9]+$" value))
                   (set! length (string->number (bytes->string/latin-1 value)))
                   (set! valid? #f))]
              [(string-ci=? (bytes->string/latin-1 key) "Content-Type")
               (unless (regexp-match? #px#"(?i:^application/vscode-jsonrpc(?:;[ ]*charset=utf-?8)?$)" value)
                 (set! valid? #f))])]
           [_ (set! valid? #f)])
         (headers)]))
    ;; Without a length there is no body boundary to recover at.
    (unless length (error 'read-index-message "Missing Content-Length"))
    (define bytes (read-bytes length in))
    (with-handlers ([exn:fail? (lambda (_) 'parse-json-error)])
      (unless (and valid? (bytes? bytes) (= length (bytes-length bytes)))
        (error 'read-index-message "Invalid frame"))
      (define body (open-input-string (bytes->string/utf-8 bytes #f)))
      (define value (read-json body))
      (unless (and (not (eof-object? value)) (regexp-match? #px"^[ \t\r\n]*$" (port->string body)))
        (error 'read-index-message "Expected one JSON value"))
      value)))

;; LSP 3.17 error codes.
(define parse-error -32700)
(define invalid-request -32600)
(define method-not-found -32601)
(define invalid-params -32602)
(define server-not-initialized -32002)
;; A valid request that could not be answered.
(define request-failed -32803)
(define content-modified -32801)
(define request-cancelled -32800)

(define operations
  (hash "textDocument/definition" 'definition
        "textDocument/documentHighlight" 'highlights
        "textDocument/references" 'references
        "textDocument/prepareRename" 'prepare-rename
        "textDocument/rename" 'rename))

(define refresh-command "racketeer.refreshWorkspaceIndex")
(define settings-section "racket-langserver.workspaceAnalysis")
(define watched-files "workspace/didChangeWatchedFiles")
;; The engine's default. Watched-file events are filtered here, where the
;; settings are known, and discovery applies the same names.
(define default-excluded '(".git" "compiled" "node_modules" ".test-output" "dist" "build"))

(define (capability capabilities . path)
  (for/fold ([value capabilities]) ([key (in-list path)])
    (and (hash? value) (hash-ref value key #f))))

(define (initialize-result client-capabilities)
  (hasheq 'capabilities
          (hasheq 'positionEncoding "utf-16"
                  'textDocumentSync (hasheq 'openClose #t 'change 1)
                  'definitionProvider #t
                  'documentHighlightProvider #t
                  'referencesProvider #t
                  'renameProvider (if (capability client-capabilities 'textDocument 'rename 'prepareSupport)
                                      (hasheq 'prepareProvider #t)
                                      #t)
                  'executeCommandProvider (hasheq 'commands (list refresh-command))
                  'workspace (hasheq 'workspaceFolders (hasheq 'supported #t 'changeNotifications #t))
                  'experimental (hasheq 'racketeer (hasheq 'version 1 'indexStatus #t)))
          'serverInfo (hasheq 'name "racketeer-workspace-index")))

(define (workspace-roots params)
  (match* ((hash-ref params 'workspaceFolders #f) (hash-ref params 'rootUri #f))
    [((? list? folders) _) (filter file-uri? (map (lambda (folder) (hash-ref folder 'uri)) folders))]
    [(_ (? string? root)) (if (file-uri? root) (list root) '())]
    [(_ _) '()]))

(define (valid-params? method params)
  (define (field value key predicate)
    (and (hash? value) (hash-has-key? value key) (predicate (hash-ref value key))))
  (define (document? value) (field value 'uri string?))
  (define (position? value)
    (and (field value 'line exact-nonnegative-integer?)
         (field value 'character exact-nonnegative-integer?)))
  (cond
    [(hash-has-key? operations method)
     (and (field params 'textDocument document?) (field params 'position position?)
          (or (not (equal? method "textDocument/rename")) (field params 'newName string?))
          (or (not (equal? method "textDocument/references"))
              (field params 'context (lambda (value) (field value 'includeDeclaration boolean?)))))]
    [(equal? method "initialize")
     (and (hash? params) (hash-has-key? params 'processId)
          (field params 'processId (lambda (value) (or (exact-integer? value) (eq? value (json-null)))))
          (field params 'capabilities hash?)
          (field params 'rootUri (lambda (value) (or (string? value) (eq? value (json-null)))))
          (let ([folders (hash-ref params 'workspaceFolders (json-null))])
            (or (eq? folders (json-null))
                (and (list? folders) (andmap (lambda (folder) (and (document? folder) (field folder 'name string?))) folders)))))]
    [(equal? method "workspace/executeCommand") (field params 'command string?)]
    [else #t]))

;; This adapter owns framing, request identifiers, cancellation subscriptions,
;; the document registry and the connection lifetime. It builds each snapshot the
;; engine analyses; the engine has no wire-protocol state. Returns the exit code.
(define (serve)
  (define protocol-out (current-output-port))
  (define reply (make-reply protocol-out))
  (define report-status? #f)
  (define report-progress? #f)
  ;; A pass in progress is standard work-done progress, begun once the client has
  ;; accepted its token. Nothing standard keeps a state after a pass ends, so
  ;; the final state stays private. The count of files is the message, once the
  ;; pass has found them. Begin always carries a percentage, since a client may
  ;; otherwise ignore the later ones.
  (define progress-lock (make-semaphore 1))
  (define progress-token #f)
  (define progress-created? #f)
  (define progress-ended? #f)
  (define progress-latest #f)
  (define tokens 0)
  (define (progress-of status)
    (define indexed (hash-ref status 'indexed))
    (define total (hash-ref status 'total))
    (if (zero? total)
        (hasheq 'percentage 0)
        (hasheq 'percentage (quotient (* 100 indexed) total)
                'message (format "~a/~a" indexed total))))
  (define (send-progress! value)
    (reply (hasheq 'jsonrpc "2.0" 'method "$/progress" 'params (hasheq 'token progress-token 'value value))))
  (define (begin-progress!)
    (send-progress! (hash-set* progress-latest 'kind "begin" 'title "Analysing workspace")))
  (define (end-progress!)
    (send-progress! (hasheq 'kind "end"))
    (set! progress-token #f)
    (set! progress-created? #f)
    (set! progress-ended? #f))
  (define (report-progress! status)
    (set! progress-latest (progress-of status))
    (set! progress-ended? #f)
    (cond
      [progress-created? (send-progress! (hash-set progress-latest 'kind "report"))]
      [(not progress-token)
       (set! tokens (add1 tokens))
       (set! progress-token (format "racketeer-index-~a" tokens))
       (request! "window/workDoneProgress/create" (hasheq 'token progress-token)
                 ;; An error answer has no result. A client that refuses a token gets no
                 ;; progress on it, and is not asked again.
                 (lambda (accepted?)
                   (call-with-semaphore progress-lock
                     (lambda ()
                       (cond
                         [accepted?
                          (set! progress-created? #t)
                          (begin-progress!)
                          (when progress-ended? (end-progress!))]
                         [else
                          (set! report-progress? #f)
                          (set! progress-token #f)])))))]))
  (define (finish-progress!)
    (cond
      [progress-created? (end-progress!)]
      [progress-token (set! progress-ended? #t)]))
  (define engine
    (make-workspace-analysis
      #:on-status
      (lambda (status)
        (define indexing? (equal? (hash-ref status 'state) "indexing"))
        (when report-progress?
          (call-with-semaphore progress-lock
            (lambda ()
              (if indexing?
                  (report-progress! status)
                  (finish-progress!)))))
        (when (and report-status? (not indexing?))
          (reply (hasheq 'jsonrpc "2.0" 'method "racketeer/indexStatus" 'params status))))))
  (define pending (make-hash))
  ;; 'starting until `initialize`, 'serving until `shutdown`, then 'stopped.
  (define state 'starting)
  (define client-capabilities (hasheq))
  (define documents (make-hash))
  (define lifetimes 0)
  (define virtual-root (build-path (car (explode-path (find-system-path 'temp-dir))) (format "racketeer-memory-~a-~a" (current-inexact-milliseconds) (random 1000000000))))
  (define roots '())
  (define invalidation 0)
  ;; No pass starts until the first settings are known.
  (define settings #f)
  ;; The revision of the last snapshot and its documents, keyed by source path. The
  ;; pair is replaced whole, since results are compared with it on other threads.
  (define submitted (cons 0 (hash)))
  ;; Settings are pulled from the client, so they arrive after later messages, and
  ;; answers need not come in order. Only the latest pull's answer counts. `settled` is
  ;; ready when the settings asked for so far have been applied, which `unapplied`
  ;; posts, and which later pulls wait for too.
  (define settled always-evt)
  (define unapplied #f)
  (define latest-pull 0)
  (define awaited (make-hash))
  (define requests 0)
  (define requests-lock (make-semaphore 1))
  (define (submit! #:documents-only? [documents-only? #f] #:normal-change? [normal-change? #f])
    (unless normal-change? (set! invalidation (add1 invalidation)))
    (when settings
      (set! submitted (cons (add1 (car submitted))
                            (for/hash ([(uri document) (in-hash documents)])
                              (values (hash-ref document 'path) document))))
      (workspace-analysis-update! engine
        (hasheq 'revision (car submitted) 'documentsOnly documents-only? 'settings settings
                'roots roots 'documents (hash-values documents)))))
  (define (request! method params [on-answer void])
    ;; Status reports make requests from other threads.
    (define id (call-with-semaphore requests-lock (lambda () (set! requests (add1 requests)) requests)))
    (hash-set! awaited id on-answer)
    (reply (hasheq 'jsonrpc "2.0" 'id id 'method method 'params params)))
  (define (answered! message)
    (define on-answer (hash-ref awaited (hash-ref message 'id #f) #f))
    (when on-answer
      (hash-remove! awaited (hash-ref message 'id))
      (with-handlers ([exn:fail? (lambda (e) (eprintf "Index response failed: ~a\n" (exn-message e)))])
        (on-answer (hash-ref message 'result #f)))))
  (define (pull-settings!)
    (cond
      [(capability client-capabilities 'workspace 'configuration)
       (set! latest-pull (add1 latest-pull))
       (define pull latest-pull)
       (unless unapplied
         (set! unapplied (make-semaphore))
         (set! settled (semaphore-peek-evt unapplied)))
       (request! "workspace/configuration"
                 (hasheq 'items (list (hasheq 'section settings-section)))
                 (lambda (result)
                   (when (= pull latest-pull)
                     (set! settings (match result
                                      [(list (? hash? pulled) _ ...) pulled]
                                      [_ (or settings (hasheq))]))
                     (submit!)
                     (semaphore-post unapplied)
                     (set! unapplied #f))))]
      [else
       (set! settings (hasheq))
       (submit!)]))
  (define (watch-folders! added removed)
    (when (capability client-capabilities 'workspace 'didChangeWatchedFiles 'dynamicRegistration)
      (unless (null? removed)
        (request! "client/unregisterCapability"
                  (hasheq 'unregisterations
                          (for/list ([root (in-list removed)]) (hasheq 'id root 'method watched-files)))))
      (unless (null? added)
        (request! "client/registerCapability"
                  (hasheq 'registrations
                          (for/list ([root (in-list added)])
                            (hasheq 'id root 'method watched-files
                                    'registerOptions
                                    (hasheq 'watchers (list (hasheq 'globPattern
                                        (if (capability client-capabilities 'workspace 'didChangeWatchedFiles 'relativePatternSupport)
                                            (hasheq 'baseUri root 'pattern "**/*")
                                            "**/*")))))))))))
  ;; Whether a reported change can change a pass: anything under a folder but
  ;; outside the excluded directories, which no glob can leave out.
  (define (relevant-change? uri)
    (define configured (hash-ref (or settings (hasheq)) 'excludedDirectories default-excluded))
    (define excluded (if (and (list? configured) (andmap string? configured)) configured default-excluded))
    (and (file-uri? uri)
         (let ([file (uri->path uri)])
           (for/or ([root (in-list roots)])
             (define folder (uri->path root))
             (and (directory-contains? folder file)
                  (not (for/or ([part (in-list (explode-path (find-relative-path folder file)))])
                         (and (path? part) (member (path->string part) excluded)))))))))
  (thread watch-analysis-timer)
  ;; Each file's edits name the version analysed: the buffer's, or null for the
  ;; text on disk. The client refuses an edit whose documents have moved on.
  (define (workspace-edit edit versions)
    (define changes
      (for/hash ([(key edits) (in-hash (hash-ref edit 'changes))])
        (define uri (symbol->string key))
        (define document (hash-ref versions (normalize-source-path (uri->path uri)) #f))
        (values (if document (hash-ref document 'uri) uri) (cons document edits))))
    (if (capability client-capabilities 'workspace 'workspaceEdit 'documentChanges)
        (hasheq 'documentChanges
                (for/list ([(uri entry) (in-hash changes)])
                  (hasheq 'textDocument
                          (hasheq 'uri uri 'version (if (car entry) (hash-ref (car entry) 'version) (json-null)))
                          'edits (cdr entry))))
        (hasheq 'changes (for/hasheq ([(uri entry) (in-hash changes)])
                          (values (string->symbol uri) (cdr entry))))))
  (define (response id operation result captured-invalidation)
    (define navigation? (memq operation '(definition highlights references)))
    (define stale (error-response id request-failed "Workspace changed during rename. Try Rename again."))
    (cond
      [(and navigation? (or (not (= captured-invalidation invalidation)) (not (sync/timeout 0 settled))))
       (error-response id content-modified "Workspace configuration or sources changed during analysis")]
      [else
       (match result
         [(AnalysisResult revision value current?)
          (cond
            [(not (and (or navigation? (= revision (car submitted))) (sync/timeout 0 settled) (current?)))
             (if navigation? (error-response id content-modified "Sources changed during analysis") stale)]
            [(eq? operation 'rename) (success-response id (workspace-edit value (cdr submitted)))]
            [else (success-response id value)])]
         [(AnalysisFailure 'document-changed _) #:when navigation? (success-response id (json-null))]
         [(AnalysisFailure (or 'changed 'document-changed) _) #:when (memq operation '(rename prepare-rename)) stale]
         [(AnalysisFailure reason message)
          (error-response id (case reason
                               [(cancelled) request-cancelled]
                               [(changed) content-modified]
                               [else request-failed]) message)])]))
  ;; Reap the workers if that is quick, then go on even if one is wedged: the
  ;; owning supervisor ends anything left in the process tree.
  (define (close-engine!)
    (sync/timeout 5 (thread (lambda () (workspace-analysis-close! engine)))))
  (define (serve-message id method params)
    (match method
      ["initialized"
       (watch-folders! roots '())
       (pull-settings!)]
      ["textDocument/didOpen"
       (define document (hash-ref params 'textDocument))
       (set! lifetimes (add1 lifetimes))
       (hash-set! documents (hash-ref document 'uri)
                  (let* ([uri (hash-ref document 'uri)]
                         [file? (file-uri? uri)]
                         [parent (and (not file?) (with-handlers ([exn:fail? (lambda (_) #f)])
                                                   (path-only (uri->path uri))))])
                    (hasheq 'uri uri 'identity lifetimes
                            'path (if file? (normalize-source-path (uri->path uri)) (build-path virtual-root (format "~a.rkt" lifetimes)))
                            'directory (if file? (path-only (uri->path uri))
                                           (and parent (directory-exists? parent) (path->complete-path parent)))
                            'version (hash-ref document 'version) 'text (string-replace (hash-ref document 'text) "\r\n" "\n"))))
       (submit! #:documents-only? #t #:normal-change? #t)]
      ["textDocument/didChange"
       (define uri (hash-ref (hash-ref params 'textDocument) 'uri))
       (define document (hash-ref documents uri #f))
       (when document
         (hash-set! documents uri
                    (hash-set* document
                               'version (hash-ref (hash-ref params 'textDocument) 'version)
                               'text (if (null? (hash-ref params 'contentChanges))
                                         (hash-ref document 'text)
                                         (string-replace (hash-ref (last (hash-ref params 'contentChanges)) 'text) "\r\n" "\n"))))
         (submit! #:normal-change? #t))]
      ["textDocument/didClose"
       (hash-remove! documents (hash-ref (hash-ref params 'textDocument) 'uri))
       (submit! #:documents-only? #t #:normal-change? #t)]
      ["workspace/didChangeWatchedFiles"
       (when (for/or ([change (in-list (hash-ref params 'changes))]) (relevant-change? (hash-ref change 'uri)))
         (submit!))]
      ["workspace/didChangeWorkspaceFolders"
       (define (folders key) (filter file-uri? (map (lambda (folder) (hash-ref folder 'uri)) (hash-ref (hash-ref params 'event) key))))
       (set! roots (append (remove* (folders 'removed) roots) (folders 'added)))
       (watch-folders! (folders 'added) (folders 'removed))
       (submit!)]
      ["workspace/didChangeConfiguration" (pull-settings!)]
      ["workspace/executeCommand"
       (cond
         [(equal? (hash-ref params 'command #f) refresh-command)
          (submit!)
          (workspace-analysis-forget! engine)
          (reply (success-response id (json-null)))]
         [else (reply (error-response id invalid-params "Unknown index command"))])]
      ["shutdown"
       (set! state 'stopped)
       (close-engine!)
       ;; A client closing down need not answer. A request waiting for settings wakes
       ;; to the closed engine, and is answered as any other that shutdown interrupts.
       (when unapplied (semaphore-post unapplied))
       (reply (success-response id (json-null)))]
      ["$/cancelRequest"
       (define cancel (hash-ref pending (hash-ref params 'id) #f))
       (when cancel (semaphore-post cancel))]
      [(app (lambda (name) (hash-ref operations name #f)) (? symbol? operation))
       ;; A request belongs to the document lifetime current when it is read,
       ;; since everything the client sent before it has been read too. A
       ;; captured source supplies its own text and belongs to no lifetime.
       (define uri (hash-ref (hash-ref params 'textDocument) 'uri))
       (define document (hash-ref documents uri #f))
       (define common
         (hasheq 'uri uri 'position (hash-ref params 'position)
                 'includeDeclaration (capability params 'context 'includeDeclaration)
                 'newName (hash-ref params 'newName #f)))
       (define bound
         (hash-set* common
                    'identity (and document (hash-ref document 'identity))
                    'version (and document (hash-ref document 'version))))
       (define applied settled)
       (define captured-invalidation invalidation)
       (define cancel (make-semaphore))
       (hash-set! pending id cancel)
       (thread
         (lambda ()
           (dynamic-wind
             void
             (lambda ()
               (define (failed e) (AnalysisFailure 'failed (exn-message e)))
               (define result
                 (with-handlers ([exn:fail? failed])
                   (sync applied (semaphore-peek-evt cancel))
                   (set! captured-invalidation invalidation)
                   (if document
                       (workspace-analysis-query engine operation bound (semaphore-peek-evt cancel))
                       (AnalysisFailure 'not-open "Document is not open"))))
               ;; Whether a rename still stands is decided once it is next to be written.
               (reply (lambda ()
                        (with-handlers ([exn:fail? (lambda (e) (response id operation (failed e) captured-invalidation))])
                          (define current (hash-ref documents uri #f))
                          (define navigation? (memq operation '(definition highlights references)))
                          (define fresh? (and current document
                                              (= (hash-ref current 'identity) (hash-ref document 'identity))
                                              (= (hash-ref current 'version) (hash-ref document 'version))))
                          (define delivered
                            (cond
                              [(and document navigation? (not fresh?))
                               (if (and current (= (hash-ref current 'identity) (hash-ref document 'identity)))
                                   (AnalysisFailure 'document-changed "Document changed during analysis")
                                   (AnalysisFailure 'not-open "Document is no longer open in this lifetime"))]
                              [else result]))
                          (define message (response id operation delivered captured-invalidation))
                          (define (real value)
                            (cond
                              [(hash? value) (for/hash ([(key item) (in-hash value)]) (values key (real item)))]
                              [(list? value) (map real value)]
                              [(string? value)
                               (define translated
                                 (for/fold ([text value]) ([(uri doc) (in-hash documents)])
                                   (if (file-uri? uri) text
                                       (string-replace (string-replace text (path->uri (hash-ref doc 'path)) uri)
                                                       (path->string (hash-ref doc 'path)) uri))))
                               (string-replace (string-replace translated (path->uri virtual-root) "untitled:")
                                               (path->string virtual-root) "untitled:")]
                              [else value]))
                          (define value (real message))
                          (if (and navigation? (or (not (= captured-invalidation invalidation))
                                                   (not (sync/timeout 0 settled))))
                              (error-response id content-modified "Sources changed during analysis") value)))))
             (lambda () (hash-remove! pending id)))))]
      ["initialize" (reply (error-response id invalid-request "The index server is already initialized"))]
      [_ (when id (reply (error-response id method-not-found "Unknown index method")))]))
  (let/ec finish
    (dynamic-wind
      void
      (lambda ()
        (for ([message (in-port read-index-message)])
          (define object? (hash? message))
          (define id (and object? (hash-ref message 'id #f)))
          (define method (and object? (hash-ref message 'method #f)))
          (define response? (and object? (not (hash-has-key? message 'method))
                                 (or (hash-has-key? message 'result) (hash-has-key? message 'error))))
          (define valid-id? (or (exact-integer? id) (string? id)))
          (define (bad-envelope!)
            (reply (error-response (if valid-id? id (json-null)) invalid-request "Invalid request")))
          (cond
            [(eq? message 'parse-json-error) (reply (error-response (json-null) parse-error "Malformed JSON"))]
            [response?
             (when (and (equal? (hash-ref message 'jsonrpc #f) "2.0")
                        (or valid-id? (eq? id (json-null)))
                        (not (and (hash-has-key? message 'result) (hash-has-key? message 'error))))
               (answered! message))]
            [(not (and object? (equal? (hash-ref message 'jsonrpc #f) "2.0") (string? method)
                       (or (not (hash-has-key? message 'id)) valid-id?)))
             (bad-envelope!)]
            [else
             (define params (hash-ref message 'params #f))
             (with-handlers ([exn:fail? (lambda (e)
                                         (if id (reply (error-response id invalid-params (exn-message e)))
                                             (eprintf "Index message failed: ~a\n" (exn-message e))))])
               (parameterize ([current-output-port (open-output-nowhere)])
                 (cond
                   [(equal? method "exit") (finish (if (eq? state 'stopped) 0 1))]
                   [(and (eq? state 'starting) (not (equal? method "initialize")))
                    (when id (reply (error-response id server-not-initialized "The index server is not initialized")))]
                   [(eq? state 'stopped)
                    (when id (reply (error-response id invalid-request "The index server has shut down")))]
                   [(and (equal? method "initialize") (not (eq? state 'starting)))
                    (when id (reply (error-response id invalid-request "The index server is already initialized")))]
                   [(and id (string-prefix? method "$/"))
                    (reply (error-response id method-not-found "Unknown index method"))]
                   [(not (valid-params? method params))
                    (when id (reply (error-response id invalid-params "Invalid index parameters")))]
                   [(and id (equal? method "initialize"))
                    (set! client-capabilities (hash-ref params 'capabilities))
                    (set! report-status? (eq? #t (capability client-capabilities 'experimental 'racketeer 'indexStatus)))
                    (set! report-progress? (eq? #t (capability client-capabilities 'window 'workDoneProgress)))
                    (set! roots (workspace-roots params))
                    (set! state 'serving)
                    (reply (success-response id (initialize-result client-capabilities)))]
                   [(eq? state 'serving) (serve-message id method params)])))]))
        ;; The client has gone once its input ends.
        0)
      close-engine!)))

(provide make-reply)

(module+ main (exit (serve)))
