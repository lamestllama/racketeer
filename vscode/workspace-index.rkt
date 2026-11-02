#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require json
         racket/list
         racket/match
         racket/path
         racket/port
         racket-langserver/common/path-util
         racket-langserver/lsp/msg-io
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
  (hash "textDocument/references" 'references
        "racketeer/sourceReferences" 'references
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
                  'referencesProvider #t
                  'renameProvider (if (capability client-capabilities 'textDocument 'rename 'prepareSupport)
                                      (hasheq 'prepareProvider #t)
                                      #t)
                  'executeCommandProvider (hasheq 'commands (list refresh-command))
                  'workspace (hasheq 'workspaceFolders (hasheq 'supported #t 'changeNotifications #t))
                  'experimental (hasheq 'racketeer (hasheq 'version 1 'indexStatus #t 'sourceReferences #t)))
          'serverInfo (hasheq 'name "racketeer-workspace-index")))

(define (workspace-roots params)
  (match* ((hash-ref params 'workspaceFolders #f) (hash-ref params 'rootUri #f))
    [((? list? folders) _) (map (lambda (folder) (hash-ref folder 'uri)) folders)]
    [(_ (? string? root)) (list root)]
    [(_ _) '()]))

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
  (define roots '())
  ;; No pass starts until the first settings are known.
  (define settings #f)
  ;; The revision of the last snapshot and the document versions it held. The
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
  (define (submit! #:documents-only? [documents-only? #f])
    (when settings
      (set! submitted (cons (add1 (car submitted))
                            (for/hash ([(uri document) (in-hash documents)])
                              (values uri (hash-ref document 'version)))))
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
      (on-answer (hash-ref message 'result #f))))
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
    (if (capability client-capabilities 'workspace 'workspaceEdit 'documentChanges)
        (hasheq 'documentChanges
                (for/list ([(uri edits) (in-hash (hash-ref edit 'changes))])
                  (hasheq 'textDocument
                          (hasheq 'uri (symbol->string uri)
                                  'version (hash-ref versions (symbol->string uri) (json-null)))
                          'edits edits)))
        edit))
  (define (response id operation result)
    ;; LSP clients do not show ContentModified, and the user must try a rename again.
    (define stale (error-response id request-failed "Workspace changed during rename. Try Rename again."))
    (match result
      [(AnalysisResult _ value) #:when (eq? operation 'references) (success-response id value)]
      [(AnalysisResult revision value)
       (define current submitted)
       (cond
         ;; Overtaken by a message already read, or by settings not yet applied.
         [(not (and (= revision (car current)) (sync/timeout 0 settled))) stale]
         [(eq? operation 'rename) (success-response id (workspace-edit value (cdr current)))]
         [else (success-response id value)])]
      [(AnalysisFailure 'changed _) #:when (not (eq? operation 'references)) stale]
      [(AnalysisFailure reason message)
       (error-response id (case reason
                            [(cancelled) request-cancelled]
                            [(closed) invalid-request]
                            [(changed) content-modified]
                            [else request-failed]) message)]))
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
                  (hasheq 'uri (hash-ref document 'uri) 'identity lifetimes
                          'version (hash-ref document 'version) 'text (hash-ref document 'text)))
       (submit! #:documents-only? #t)]
      ["textDocument/didChange"
       (define uri (hash-ref (hash-ref params 'textDocument) 'uri))
       (define document (hash-ref documents uri #f))
       (when document
         (hash-set! documents uri
                    (hash-set* document
                               'version (hash-ref (hash-ref params 'textDocument) 'version)
                               'text (hash-ref (last (hash-ref params 'contentChanges)) 'text)))
         (submit!))]
      ["textDocument/didClose"
       (hash-remove! documents (hash-ref (hash-ref params 'textDocument) 'uri))
       (submit! #:documents-only? #t)]
      ["workspace/didChangeWatchedFiles"
       (when (for/or ([change (in-list (hash-ref params 'changes))]) (relevant-change? (hash-ref change 'uri)))
         (submit!))]
      ["workspace/didChangeWorkspaceFolders"
       (define (folders key) (map (lambda (folder) (hash-ref folder 'uri)) (hash-ref (hash-ref params 'event) key)))
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
         (if (equal? method "racketeer/sourceReferences")
             (hash-set common 'text (hash-ref params 'text))
             (hash-set* common
                        'identity (and document (hash-ref document 'identity))
                        'version (and document (hash-ref document 'version)))))
       (define applied settled)
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
                   (workspace-analysis-query engine operation bound (semaphore-peek-evt cancel))))
               ;; Whether a rename still stands is decided once it is next to be written.
               (reply (lambda ()
                        (with-handlers ([exn:fail? (lambda (e) (response id operation (failed e)))])
                          (response id operation result)))))
             (lambda () (hash-remove! pending id)))))]
      ["initialize" (reply (error-response id invalid-request "The index server is already initialized"))]
      [_ (when id (reply (error-response id method-not-found "Unknown index method")))]))
  (let/ec finish
    (dynamic-wind
      void
      (lambda ()
        (for ([message (in-port read-message)])
          (define id (and (hash? message) (hash-ref message 'id #f)))
          (with-handlers ([exn:fail? (lambda (e)
                                       (if id (reply (error-response id request-failed (exn-message e)))
                                           (eprintf "Index message failed: ~a\n" (exn-message e))))])
            (parameterize ([current-output-port (open-output-nowhere)])
              (define method (if (eq? message 'parse-json-error) message (hash-ref message 'method #f)))
              (define params (if (hash? message) (hash-ref message 'params (hasheq)) (hasheq)))
              (match* (method state)
                [('parse-json-error _) (reply (error-response (json-null) parse-error "Malformed JSON"))]
                [(#f _) (answered! message)]
                [("exit" _) (finish (if (eq? state 'stopped) 0 1))]
                [("initialize" 'starting)
                 (set! client-capabilities (hash-ref params 'capabilities (hasheq)))
                 ;; Private messages are negotiated under this member, which a
                 ;; generic client never sets. Such a client sees a standard server.
                 (set! report-status? (eq? #t (capability client-capabilities 'experimental 'racketeer 'indexStatus)))
                 (set! report-progress? (eq? #t (capability client-capabilities 'window 'workDoneProgress)))
                 (set! roots (workspace-roots params))
                 (set! state 'serving)
                 (reply (success-response id (initialize-result client-capabilities)))]
                [(_ 'starting)
                 (when id (reply (error-response id server-not-initialized "The index server is not initialized")))]
                [(_ 'stopped)
                 (when id (reply (error-response id invalid-request "The index server has shut down")))]
                [(_ 'serving) (serve-message id method params)]))))
        ;; The client has gone once its input ends.
        0)
      close-engine!)))

(provide make-reply)

(module+ main (exit (serve)))
