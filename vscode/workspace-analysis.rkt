#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Workspace analysis accepts complete source views and returns domain results.
;; Each instance owns its runs and disposable workers. No editor connection or
;; request transport is required to use the engine.
(require compiler/compilation-path
         compiler/module-suffix
         racket/file
         racket/future
         racket/list
         racket/match
         racket/path
         racket/port
         racket/runtime-path
         racket/set
         racket-langserver/common/path-util
         racket-langserver/common/source
         racket-langserver/common/source-snapshot
         racket-langserver/common/interfaces
         racket-langserver/common/json-util
         racket-langserver/doclib/doc
         racket-langserver/doclib/internal-types
         racket-langserver/workspace/api
         racket-langserver/lsp/compose/references
         "workspace-rename.rkt"
         "workspace-wire.rkt")

(struct Settings (enabled? excluded max-files max-bytes timeout) #:transparent)
(define default-excluded '(".git" "compiled" "node_modules" ".test-output" "dist" "build"))
;; A run is one analysis of a source view, at most one pass, which starts when a
;; request first waits for the run and stops when the last one leaves. A later
;; revision that only opens or closes documents over the same sources is adopted
;; by the run; `revised` is posted when it is, so waiting requests check their
;; document again. `unverified?` means such a revision came after the pass began,
;; so the next request needs the disk checked by another pass. A pass starts no
;; sooner than `not-before`, and `waiting` counts the requests waiting for it.
;; `changed?` says that what replaced the run before it changed the sources themselves,
;; where a buffer closing or a pass begun again over the same view does not.
(struct Run (generation cancel done revised state indexed total failures workspace documents buffers settings roots sources unverified? not-before waiting changed?) #:mutable)
;; `results` holds each file's last successful analysis across runs, as an
;; immutable table that a pass can read while a retired one finishes, and `interned`
;; the entries that most of those analyses share, so they are held once.
(struct WorkspaceAnalysis (lock slots notify current-run closed? active-runs results interned) #:mutable)
;; A file's analysis stands while the file has the text it had and everything the
;; analysis read still reads the same. `fingerprint` is the hash of its text.
;; `reads` pairs each module file it loaded with the hash of what that holds,
;; `externals` each file registered with the compiler, and `resolutions` each
;; collection module path with what it resolved to. `basis` is what decided how
;; the analysis ran: the roots, which load from source, and the size limit.
(struct Result (basis text contribution facts fingerprint reads externals resolutions))
(define (analysis-basis run)
  (list (Run-roots run) (Settings-max-bytes (Run-settings run))))
(struct AnalysisResult (revision value) #:transparent)
(struct AnalysisFailure (reason message) #:transparent)

(define (make-workspace-analysis #:on-status [notify void])
  (WorkspaceAnalysis (make-semaphore 1) (for/list ([_ (in-range (worker-limit))]) (make-semaphore 1))
                     notify #f #f (make-hasheq) (hash) (make-hash)))

;; How many worker processes an instance runs at once: half the processors, which
;; leaves room for the editor and the language server, and at most three. On 52 files
;; a pass took 62 s with one, 34 s with two, 26 s with three and 21 s with four, and
;; each worker added about 260 MB at the peak, so a fourth costs more than it saves.
(define (default-workers processors) (max 1 (min 3 (quotient processors 2))))
(define (worker-limit)
  (define configured (string->number (or (getenv "RACKETEER_INDEX_WORKERS") "")))
  (if (exact-positive-integer? configured) configured (default-workers (processor-count))))

(define (accepted run value)
  (AnalysisResult (Run-generation run) value))

(define (workspace-analysis-close! engine)
  (define runs
    (call-with-semaphore (WorkspaceAnalysis-lock engine)
      (lambda ()
        (set-WorkspaceAnalysis-closed?! engine #t)
        (define current (WorkspaceAnalysis-current-run engine))
        (when current (semaphore-post (Run-cancel current)))
        (set-WorkspaceAnalysis-current-run! engine #f)
        (define active (hash->list (WorkspaceAnalysis-active-runs engine)))
        (for ([entry (in-list active)]) (semaphore-post (Run-cancel (cdr entry))))
        (map car active))))
  (for ([done (in-list runs)]) (sync (semaphore-peek-evt done)))
  ;; Queries belong to their callers, but their worker processes belong here.
  ;; Every run is now cancelled, so no worker can start. A slot that has been free
  ;; since then held no worker, so one look at each shows that all were reaped.
  (for ([slot (in-list (WorkspaceAnalysis-slots engine))]) (call-with-semaphore slot void)))

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
    [(cons 'stopped reason) reason]
    [(cons 'timeout seconds) (format "analysis exceeded its ~a second time limit" seconds)]
    [_ "analysis worker stopped without a result"]))

;; A rename refused by its checks explains itself. One whose worker did not
;; finish says that it did not, and why.
(define (rename-failure result)
  (match result
    [(cons (or 'stopped 'timeout) _) (format "Rename could not finish: ~a." (analysis-failure result))]
    [_ (analysis-failure result)]))

;; Why a worker of this run did not finish, for a rename the partial index then
;; refuses: a limit is not an error in the file that its author could resolve.
(define worker-stops (make-weak-hasheq))
(define (note-stop! run request result)
  (match result
    [(cons 'stopped reason) (hash-ref! worker-stops run reason)]
    [(cons 'timeout _)
     (hash-ref! worker-stops run (format "~a: ~a" (request-label request) (analysis-failure result)))]
    [_ (void)]))
(define (incomplete-index run)
  (match (hash-ref worker-stops run #f)
    [#f "Workspace analysis is incomplete. Resolve its errors before renaming."]
    [reason (format "Workspace analysis is incomplete, so Rename cannot run: ~a." reason)]))

(define (status run)
  (hasheq 'state (Run-state run) 'indexed (Run-indexed run) 'total (Run-total run) 'failures (Run-failures run)))

(define (report! engine run state indexed failures)
  (call-with-semaphore (WorkspaceAnalysis-lock engine)
                       (lambda ()
                         (when (eq? run (WorkspaceAnalysis-current-run engine))
                           (set-Run-state! run state)
                           (set-Run-indexed! run indexed)
                           (set-Run-failures! run failures)
                           ((WorkspaceAnalysis-notify engine) (status run))))))

(define (compute engine run seconds request [cancel never-evt] #:note-stop? [note-stop? #t])
  (define slots (WorkspaceAnalysis-slots engine))
  (define taken (apply sync (semaphore-peek-evt (Run-cancel run)) cancel slots))
  (cond
    [(memq taken slots)
     (dynamic-wind void
                   (lambda ()
                     (define result
                       (and (not (cancelled? run)) (not (sync/timeout 0 cancel)) (compute/slot run seconds request cancel)))
                     (when note-stop? (note-stop! run request result))
                     result)
                   (lambda () (semaphore-post taken)))]
    [else #f]))

;; Diagnostics for a stalled index. Each line is written before the next wait
;; begins, so the last line for a worker names the wait it stuck in. They appear
;; when RACKETEER_INDEX_TRACE is set, as it is in the editor CI job. Otherwise
;; only a pause of the timer is logged.
(define tracing? (and (getenv "RACKETEER_INDEX_TRACE") #t))
(define slow-milliseconds 5000)
(define (monotonic) (inexact->exact (round (current-inexact-monotonic-milliseconds))))

;; Logging adds no wait and no failure to stopping a worker: a full pipe drops
;; the line, and a client that has gone is not an error here.
(define (log-diagnostic source now message)
  (with-handlers ([exn:fail? void])
    (write-bytes-avail* (string->bytes/utf-8 (format "Workspace analysis ~a at ~a ms: ~a\n" source now message))
                        (current-error-port))))

(define (log-worker label event [since #f])
  (define now (monotonic))
  (define waited (and since (- now since)))
  (when tracing?
    (log-diagnostic "worker" now (if waited (format "~a: ~a after ~a ms" label event waited)
                                     (format "~a: ~a" label event)))))

(define (request-label request)
  (match request
    [(list 'analyse path _ ...) (format "analyse ~a" path)]
    [(list 'rename _ _ _ _ _ path _ ...) (format "rename ~a" path)]
    [(cons kind _) (symbol->string kind)]))

;; Runs for the life of the server. Every green thread stops when the whole
;; runtime does, and this one reports that when it wakes. While tracing, its
;; regular line shows up to when the runtime was running: the lines stop with a
;; stalled runtime, and continue past a wait that stopped only one thread.
(define (watch-analysis-timer)
  (let loop ([last (monotonic)] [ticks 0])
    (sleep 1)
    (define now (monotonic))
    (when (>= (- now last) slow-milliseconds)
      (log-diagnostic "timer" now (format "woke ~a ms after it last ran" (- now last))))
    (when (and tracing? (zero? (modulo ticks 10)))
      (log-diagnostic "timer" now "running"))
    (loop now (add1 ticks))))

;; One worker holds one analysis, and its memory ends with it. The limit protects
;; the machine from compile-time code that keeps what it allocates: such code passes
;; a gigabyte in seconds, and a time limit alone would let it reach tens of gigabytes.
;; It counts what the analysis adds to the worker's own libraries, and it is set to
;; stop only a runaway: analysing a file of 1 MiB, the largest indexed by default,
;; was measured at about 1 GB. Collections are when it is checked, so a worker's
;; resident size can pass it for a moment, to about 3 GB. Workers run at once and each
;; has this limit, so compile-time code running away in several files at the same time
;; can reach that many times as much. It is not shared out between them: what a file
;; may use, and so whether it fails, does not depend on how many workers there are.
(define default-worker-megabytes 2048)
(define (worker-megabytes)
  (define configured (string->number (or (getenv "RACKETEER_INDEX_WORKER_MEGABYTES") "")))
  (if (exact-positive-integer? configured) configured default-worker-megabytes))

;; One allocation over the limit is refused as an exception, where a custodian would be
;; shut down by many. The language server's diagnostics report such an exception from
;; an expansion by printing it into their own error's message.
(define out-of-memory '(out-of-memory))
(define (out-of-memory? e)
  (or (exn:fail:out-of-memory? e)
      (and (exn? e) (regexp-match? #rx"struct:exn:fail:out-of-memory" (exn-message e)))))

;; What a worker does: everything that reads, expands or runs a user's code.
(define (answer request observe)
  (with-handlers ([out-of-memory? (lambda (_) out-of-memory)]
                  [(lambda (_) #t)
                   (lambda (e) (cons 'failed (if (exn? e) (exn-message e) (format "~s" e))))])
    (parameterize ([current-output-port (open-output-nowhere)]
                   [current-error-port (open-output-nowhere)]
                   [current-input-port (open-input-string "")]
                   [exit-handler (lambda (_) (error 'workspace-analysis "worker exited"))]
                   [current-analysis-observer observe])
      (match request
        [(list 'discover roots excluded limit files forms)
         (append (list 'ok) (discover roots excluded limit)
                 (list (for/hash ([file (in-list files)]) (values file (disk-fingerprint file)))
                       (for/hash ([form (in-list forms)]) (values form (resolved-form form)))))]
        [(list 'analyse path max-bytes buffer query buffers roots before)
         (observe path)
         (match-define (list contribution text count references record) (analyse path max-bytes buffer query buffers roots before))
         (if contribution (list 'ok (contribution->datum contribution) text count references record) '(changed))]
        [(list 'rename sources roots excluded limit buffers path position name)
         (define (check-snapshot!)
           (unless (snapshot-current? sources roots excluded limit buffers)
             (error 'rename "Workspace files changed. Try Rename again.")))
         (check-snapshot!)
         (define result (workspace-rename sources path position name))
         (check-snapshot!)
         (list 'ok result)]))))

;; The worker process: workspace-worker.rkt has set its library paths. The request
;; arrives on standard input and the reply leaves on standard output, and analysed
;; code has neither. The analysis runs under two custodians of its own. Its code can
;; shut down the inner one but not the outer, so only the memory limit ends the outer,
;; and this thread survives either to say which happened.
(module+ worker
  (define from-server (current-input-port))
  (define to-server (current-output-port))
  (define request (read-worker-message from-server))
  ;; The server closes this pipe when it no longer wants the worker, or when it ends.
  (void (thread (lambda ()
                  (let wait () (unless (eof-object? (read-byte from-server)) (wait)))
                  (exit 0))))
  (define megabytes (worker-megabytes))
  (define limited (make-custodian))
  (custodian-limit-memory limited (* megabytes 1024 1024) limited)
  (define at #f)
  (define result #f)
  (define analysis
    (parameterize ([current-custodian (make-custodian limited)])
      (thread (lambda () (set! result (answer request (lambda (path) (set! at path))))))))
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
  (void (with-handlers ([exn:fail? (lambda (e)
                                     (write-worker-message (cons 'stopped (format "analysis worker could not send its result: ~a" (exn-message e)))
                                                           to-server))])
          (write-worker-message reply to-server)))
  (flush-output to-server)
  ;; Keep a successful reply distinguishable from an abnormal early exit.
  (void (sync never-evt)))

(define-runtime-path worker-program "workspace-worker.rkt")
(define-runtime-path this-module "workspace-analysis.rkt")

;; A worker that ended with no reply: what its exit status and own error output say.
;; Racket reports a Unix process ended by a signal as 128 plus its number.
(define (worker-exit status errors)
  (define signal (and (exact-integer? status) (not (eq? (system-type 'os) 'windows)) (> status 128) (- status 128)))
  (define stated
    (cond
      [(eqv? signal 9) "analysis worker was killed by signal 9, which is how the system ends a process when memory runs out"]
      [signal (format "analysis worker was ended by signal ~a" signal)]
      [else (format "analysis worker exited with status ~a" status)]))
  (define said (regexp-match #rx"[^\r\n]+" (bytes->string/utf-8 errors #\?)))
  (if said (format "~a: ~a" stated (car said)) stated))

(define decoding-bytes (* 512 1024 1024))
(define (compute/slot run seconds request cancel)
  ;; Cancellation must discard the runtime doing the work, including its module
  ;; loading state, and a worker stopped this way cannot hold up anything else: the
  ;; system ends the process wherever its code is. It is one process in the tree
  ;; that owns the server, so it ends with that tree on every platform.
  (define label (request-label request))
  (define starting (monotonic))
  (log-worker label "starting")
  (define owner (make-custodian))
  (define (stop! process)
    (define stopping (monotonic))
    (log-worker label "kill requested")
    (subprocess-kill process #t)
    (log-worker label "killed" stopping)
    (unless (sync/timeout 10 process)
      (log-diagnostic "worker" (monotonic) (format "~a: still running 10 s after it was killed" label)))
    (log-worker label "reaped" stopping))
  (define (exchange process from-worker to-worker errors)
    (define said (open-output-bytes))
    (define (bounded-copy)
      (let loop ()
        (define bytes (read-bytes 4096 errors))
        (unless (eof-object? bytes)
          (when (< (file-position said) 4096) (write-bytes bytes said))
          (loop))))
    (void (thread bounded-copy))
    ;; Each of these can wait on the worker, so neither holds up the wait below.
    (void (thread (lambda ()
                    (with-handlers ([exn:fail? void])
                      (write (list (map path->bytes (current-library-collection-paths))
                                   (for/list ([root (in-list (current-compiled-file-roots))])
                                     (if (path? root) (path->bytes root) root))
                                   (path->bytes this-module))
                             to-worker)
                      (write-worker-message request to-worker)
                      (flush-output to-worker)))))
    (define reply #f)
    ;; A reply is bounded before it is read. So is what reading it takes, since nesting
    ;; costs more to read than it costs to send. Ending this custodian ends the reader,
    ;; which then counts as a reply that could not be read.
    (define decoding (make-custodian))
    (custodian-limit-memory decoding decoding-bytes decoding)
    (define reader
      (parameterize ([current-custodian decoding])
        (thread (lambda ()
                  (with-handlers ([exn:fail? void])
                    (set! reply (read-worker-message from-worker)))))))
    (define finished
      (sync/timeout seconds (thread-dead-evt reader) process
                    (semaphore-peek-evt (Run-cancel run)) cancel))
    (define (no-reply)
      (cons 'stopped
            (if (sync/timeout 1 process)
                (worker-exit (subprocess-status process) (get-output-bytes said))
                "analysis worker sent a reply that could not be read")))
    (cond
      [(not finished) (cons 'timeout seconds)]
      [(eq? finished process)
       ;; A reply written just before the process ended is still in the pipe.
       (sync/timeout 1 (thread-dead-evt reader))
       (or reply (no-reply))]
      [(thread-dead? reader) (or reply (no-reply))]
      [else #f]))
  (define result
    (with-handlers ([exn:fail? (lambda (e)
                                 (cons 'stopped (format "analysis worker could not run: ~a" (exn-message e))))])
      (parameterize ([current-custodian owner]
                     [current-subprocess-custodian-mode 'kill])
        (define-values (process from-worker to-worker errors)
          (subprocess #f #f #f
                      (or (find-executable-path (find-system-path 'exec-file))
                          (find-system-path 'exec-file))
                      (path->string worker-program)))
        (log-worker label "started" starting)
        (dynamic-wind
          void
          (lambda () (exchange process from-worker to-worker errors))
          (lambda ()
            (stop! process)
            (custodian-shutdown-all owner))))))
  (match result
    [(cons 'stopped reason)
     (log-diagnostic "worker" (monotonic) (format "~a: ~a" label reason))]
    [_ (void)])
  result)

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

;; Whether `discover` finds the file, so that a buffer for it adds no source.
(define (discoverable? path roots excluded)
  (and (regexp-match? (get-module-suffix-regexp) (path->string path))
       (file-exists? path) (not (link-exists? path))
       (for/or ([root (in-list roots)])
         (and (directory-contains? root path)
              (let descend ([directory root] [parts (explode-path (find-relative-path root path))])
                (or (null? (cdr parts))
                    (let ([next (build-path directory (car parts))])
                      (and (path? (car parts)) (not (link-exists? next))
                           (not (member (path->string (car parts)) excluded))
                           (descend next (cdr parts))))))))))

;; Opening or closing documents leaves the analysed sources unchanged when each
;; buffer that appeared or went holds the text of a file that discovery finds.
(define (same-sources? before after roots excluded max-bytes)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (for/and ([path (in-list (remove-duplicates (append (hash-keys before) (hash-keys after))))])
      (define old (hash-ref before path 'disk))
      (define new (hash-ref after path 'disk))
      (define text (if (eq? old 'disk) new old))
      (or (equal? old new)
          (and (or (eq? old 'disk) (eq? new 'disk)) (string? text)
               (discoverable? path roots excluded)
               (let ([bytes (call-with-input-file* path (lambda (in) (read-bytes (add1 max-bytes) in)))])
                 (and (bytes? bytes) (<= (bytes-length bytes) max-bytes)
                      (equal? text (bytes->string/utf-8 bytes)))))))))

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

(define (analyse path max-bytes buffer query buffers roots before)
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
    ;; A request's own analysis answers it and stays no longer, so only a pass records.
    (define reads (make-hash))
    (define resolutions (make-hash))
    (define externals (make-log-receiver (current-logger) 'info 'cm-accomplice))
    ;; Trace construction and queries use a fresh namespace as well as expansion.
    ;; A previously loaded dependency must not survive a watched change.
    (parameterize ([current-namespace (make-base-namespace)]
                   [current-directory (path-only path)]
                   [current-load-relative-directory (path-only path)]
                   [current-module-name-resolver
                    (if query (current-module-name-resolver)
                        (recording-resolver (current-module-name-resolver) resolutions))])
    (call-with-source-snapshot buffers
      #:source? (lambda (file) (for/or ([root (in-list roots)]) (directory-contains? root file)))
      #:on-load (if query void (lambda (file) (record-load! reads file buffers)))
      (lambda ()
      (define doc (make-doc (path->uri path) text 0))
      (unless (doc-expand! doc) (error 'workspace-analysis "analysis failed: ~a" path))
      (define contribution (Doc-contribution doc))
      (define facts
        (+ (hash-count (Doc-Contribution-definitions contribution))
           (for/sum ([locations (in-hash-values (Doc-Contribution-references contribution))])
             (length locations))))
      (unless (or buffer
                  (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
                    (equal? bytes (call-with-input-file* path
                                    (lambda (in) (read-bytes (add1 max-bytes) in))))))
        (if captured-text (changed (list #f text 0 #f #f))
            (error 'workspace-analysis "file changed during analysis: ~a" path)))
      (list contribution text facts
            (and query
                 (let ([result (doc-references doc (car query) (jsexpr->Pos (cadr query)) (caddr query))])
                   (and result
                        (list (map ->jsexpr (Reference-Source-locations (Document-Reference-Result-source result)))
                              (and (Document-Reference-Result-module-binding result)
                                   (binding->datum (Document-Reference-Result-module-binding result)))))))
            (and (not query)
                 (list (sha1-bytes bytes) (hash->list reads) (external-reads externals before)
                       (hash->list resolutions)))))))))

;; What a file's analysis read is taken while it reads, so that a file changing
;; afterwards shows as changed. A buffer takes the place of its file only where
;; the analysis read it as a module: `include` and its like read the disk.
(define (disk-fingerprint file)
  (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
    (and (file-exists? file) (call-with-input-file* file sha1-bytes))))

(define (buffer-fingerprint text)
  (if text (sha1-bytes (string->bytes/utf-8 text)) 'conflict))

;; A .ss file is loaded only while the .rkt beside it is absent, so that absence
;; is read as well.
(define (record-load! reads file buffers)
  (define (record! file)
    (hash-ref! reads file
               (lambda ()
                 (if (hash-has-key? buffers file)
                     (buffer-fingerprint (hash-ref buffers file))
                     (disk-fingerprint file)))))
  (record! file)
  ;; With no source to read, what the loader reads is the compiled code.
  (unless (or (hash-has-key? buffers file) (file-exists? file))
    (for* ([root (in-list (current-compiled-file-roots))]
           [mode (in-list (use-compiled-file-paths))])
      (record! (get-compilation-bytecode-file file #:modes (list mode) #:roots (list root)))))
  (when (equal? (path-get-extension file) #".ss")
    (record! (path-replace-extension file #".rkt"))))

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

(define (resolved-form form)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (resolved-module-path-name ((current-module-name-resolver) form #f #f #f))))

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

(define (datum->contribution datum)
  (match-define (list path references definitions) datum)
  (Doc-Contribution path
                    (for/hash ([entry (in-list references)])
                      (values (apply Module-Binding (car entry)) (map jsexpr->Location (cdr entry))))
                    (for/hash ([entry (in-list definitions)])
                      (values (apply Module-Binding (car entry)) (jsexpr->Location (cdr entry))))))

(define (known-reads results)
  (define files (mutable-set))
  (define forms (mutable-set))
  (for ([(path result) (in-hash results)])
    (set-add! files path)
    (for ([entry (in-list (Result-reads result))]) (set-add! files (car entry)))
    (for ([entry (in-list (Result-externals result))]) (set-add! files (car entry)))
    (for ([entry (in-list (Result-resolutions result))]) (set-add! forms (car entry))))
  (values (set->list files) (set->list forms)))

(define (result-current? result run path view disk resolved)
  (define (holds? entries table)
    (for/and ([entry (in-list entries)]) (equal? (cdr entry) (hash-ref table (car entry) 'unknown))))
  (and (equal? (Result-basis result) (analysis-basis run))
       (equal? (Result-fingerprint result) (hash-ref view path 'unknown))
       (holds? (Result-reads result) view)
       (holds? (Result-externals result) disk)
       (holds? (Result-resolutions result) resolved)))

;; What a retired run still has in hand does not count, as after a refresh.
(define (change-results! engine run change)
  (call-with-semaphore (WorkspaceAnalysis-lock engine)
    (lambda ()
      (unless (cancelled? run)
        (set-WorkspaceAnalysis-results! engine (change (WorkspaceAnalysis-results engine)))))))

(define (analyse-file engine run path disk stop)
  (define held (hash-ref (WorkspaceAnalysis-results engine) path #f))
  (define before
    (for/hash ([entry (in-list (if held (Result-externals held) '()))])
      (values (car entry) (hash-ref disk (car entry) 'unknown))))
  (define config (Run-settings run))
  (match (compute engine run (Settings-timeout config)
                  (list 'analyse path (Settings-max-bytes config)
                        (hash-ref (Run-buffers run) path #f) #f (Run-buffers run) (Run-roots run) before)
                  stop #:note-stop? #f)
    [(list 'ok contribution text count _ (list fingerprint reads externals resolutions))
     (define (shared entries)
       (for/list ([entry (in-list entries)])
         (hash-ref! (WorkspaceAnalysis-interned engine) entry entry)))
     (define result (Result (analysis-basis run) text (datum->contribution contribution) count fingerprint
                            (shared reads) (shared externals) (shared resolutions)))
     (change-results! engine run (lambda (results) (hash-set results path result)))
     result]
    [failure failure]))

;; Analyses a pass's files in as many workers as the engine has, earliest file
;; first. What a worker finds counts as finished when it finishes, so cancelling
;; keeps it, but the pass reads each file's outcome in its own order, whichever
;; worker ended first. Returns how to read one, which waits for it, and how to
;; stop the rest, which returns once their workers have gone.
(define (start-analyses engine run paths disk)
  (define waiting paths)
  (define (next-path!)
    (call-with-semaphore (WorkspaceAnalysis-lock engine)
      (lambda ()
        (and (pair? waiting) (begin0 (car waiting) (set! waiting (cdr waiting)))))))
  (define stop (make-semaphore))
  (define stopped (semaphore-peek-evt stop))
  (define outcomes (make-hash))
  (define finished (for/hash ([path (in-list paths)]) (values path (make-semaphore))))
  ;; Once stopped, each remaining file comes back at once with no outcome.
  (define (work)
    (define path (next-path!))
    (when path
      (hash-set! outcomes path
                 (with-handlers ([exn:fail? values]) (analyse-file engine run path disk stopped)))
      (semaphore-post (hash-ref finished path))
      (work)))
  (define threads
    (for/list ([_ (in-range (min (length paths) (length (WorkspaceAnalysis-slots engine))))])
      (thread work)))
  (values
    (lambda (path)
      (semaphore-wait (hash-ref finished path))
      (define outcome (hash-ref outcomes path))
      (if (exn? outcome) (raise outcome) outcome))
    (lambda ()
      (semaphore-post stop)
      (for-each thread-wait threads))))

(define (run-index engine run)
  (define config (Run-settings run))
  (define indexed 0)
  (define failures (count not (hash-values (Run-buffers run))))
  (define bytes 0)
  (define facts 0)
  (dynamic-wind
    void
    (lambda ()
      (unless (sync/timeout (max 0 (/ (- (Run-not-before run) (current-inexact-monotonic-milliseconds)) 1000))
                            (semaphore-peek-evt (Run-cancel run)))
        (define-values (files forms) (known-reads (WorkspaceAnalysis-results engine)))
        (match (compute engine run 30 (list 'discover (Run-roots run) (Settings-excluded config)
                                            (Settings-max-files config) files forms))
          [(list 'ok paths incomplete? disk resolved)
           (when incomplete?
             (set! failures (add1 failures))
             (eprintf "Workspace discovery incomplete after finding ~a files under ~a\n"
                      (length paths) (Run-roots run)))
           (define sources
             (append (for/list ([(path text) (in-hash (Run-buffers run))] #:when text) path)
                     (filter (lambda (path) (not (hash-has-key? (Run-buffers run) path))) paths)))
           (when (> (length sources) (Settings-max-files config)) (set! failures (add1 failures)))
           (set-Run-total! run (min (length sources) (Settings-max-files config)))
           (report! engine run "indexing" indexed failures)
           ;; Reused and new contributions enter the store in the order of a fresh pass.
           (define view
             (for/fold ([view disk]) ([(path text) (in-hash (Run-buffers run))])
               (hash-set view path (buffer-fingerprint text))))
           (define planned (for/list ([path (in-list sources)] [n (in-range (Settings-max-files config))]) path))
           (define found (WorkspaceAnalysis-results engine))
           (define reused
             (for*/hash ([path (in-list planned)]
                         [held (in-value (hash-ref found path #f))]
                         #:when (and held (result-current? held run path view disk resolved)))
               (values path held)))
           (define-values (outcome-of stop-analyses!)
             (start-analyses engine run (filter (lambda (path) (not (hash-has-key? reused path))) planned) disk))
           (define unread planned)
           (dynamic-wind
             void
             (lambda ()
               (for ([path (in-list planned)]
                     #:break (or (cancelled? run) (> bytes (* 16 1024 1024)) (> facts 200000)))
                 (set! unread (cdr unread))
                 (match (or (hash-ref reused path #f) (outcome-of path))
                   [(? Result? result)
                    (set! bytes (+ bytes (bytes-length (string->bytes/utf-8 (Result-text result)))))
                    (set! facts (+ facts (Result-facts result)))
                    (cond
                      [(or (> bytes (* 16 1024 1024)) (> facts 200000)) (set! failures (add1 failures))]
                      [else
                       ;; Each run has its own store. A retired worker can never
                       ;; populate a replacement run, even if cancellation is late.
                       (workspace-set-contribution! (Run-workspace run) (Result-contribution result))
                       (hash-set! (Run-sources run) path (Result-text result))
                       (set! indexed (add1 indexed))])]
                   [failure
                    (set! failures (add1 failures))
                    (note-stop! run (list 'analyse path) failure)
                    (unless (cancelled? run)
                      (eprintf "Workspace analysis incomplete: ~a (~a)\n" path (analysis-failure failure)))])
                 (report! engine run "indexing" indexed failures)))
             (lambda ()
               (stop-analyses!)
               ;; A pass that stops at a limit never reached these files, so what
               ;; workers found ahead of it is not kept: the next pass finds what
               ;; this one found.
               (change-results! engine run
                 (lambda (results)
                   (for/fold ([results results]) ([path (in-list unread)])
                     (define held (hash-ref found path #f))
                     (if held (hash-set results path held) (hash-remove results path)))))))
           (define kept (list->set sources))
           (change-results! engine run
             (lambda (results)
               (for/hash ([(path result) (in-hash results)] #:when (set-member? kept path))
                 (values path result))))
           (report! engine run (if (zero? failures) "ready" "partial") indexed failures)]
          [failure
           (unless (cancelled? run)
             (eprintf "Workspace discovery incomplete: ~a\n" (analysis-failure failure)))
           (report! engine run "partial" indexed (add1 failures))])))
    void))

;; Runs a worker thread for `run`; its `done` is posted when the thread ends.
;; The caller holds the engine lock.
(define (start-worker! engine run work)
  (define done (Run-done run))
  (hash-set! (WorkspaceAnalysis-active-runs engine) done run)
  (thread
    (lambda ()
      (dynamic-wind
        void
        (lambda ()
          (with-handlers ([exn:fail?
                           (lambda (e)
                             (eprintf "Workspace analysis failed: ~a\n" (exn-message e))
                             (report! engine run "partial" (Run-indexed run) (add1 (Run-failures run))))])
            (work)))
        (lambda ()
          (call-with-semaphore (WorkspaceAnalysis-lock engine)
            (lambda () (hash-remove! (WorkspaceAnalysis-active-runs engine) done)))
          (semaphore-post done))))))

;; Replaces the current run with one that has no pass yet. A pass it stops is
;; reported, since a client shows it as running. The caller holds the lock.
(define (replace-run! engine revision documents buffers config roots #:not-before [not-before 0] #:changed? [changed? #t])
  (define current (WorkspaceAnalysis-current-run engine))
  (when current (semaphore-post (Run-cancel current)))
  (define workspace (make-workspace))
  (for ([root (in-list roots)]) (workspace-add-folder! workspace root))
  (define run
    (Run revision (make-semaphore) (make-semaphore) (make-semaphore)
         (if (Settings-enabled? config) "outdated" "disabled") 0 0 0
         workspace documents buffers config roots (make-hash) #f not-before 0 changed?))
  (set-WorkspaceAnalysis-current-run! engine run)
  (cond
    [(not (Settings-enabled? config))
     ((WorkspaceAnalysis-notify engine) (status run))
     (semaphore-post (Run-done run))]
    [(and current (equal? "indexing" (Run-state current)))
     ((WorkspaceAnalysis-notify engine) (status run))]))

;; The same source view, to be analysed when next asked for. The caller holds the lock.
(define (renew-run! engine run)
  (replace-run! engine (Run-generation run) (Run-documents run) (Run-buffers run)
                (Run-settings run) (Run-roots run) #:changed? #f))

;; Waits with `wait` for what a run's pass decides. The first to wait starts the
;; pass, and the last to leave an unfinished one stops it: its completed files
;; stay in the engine's results for the next pass.
(define (wait-for-pass engine run wait)
  (call-with-semaphore (WorkspaceAnalysis-lock engine)
    (lambda ()
      (set-Run-waiting! run (add1 (Run-waiting run)))
      (when (equal? "outdated" (Run-state run))
        (set-Run-state! run "indexing")
        ((WorkspaceAnalysis-notify engine) (status run))
        (start-worker! engine run (lambda () (run-index engine run))))))
  (dynamic-wind
    void
    wait
    (lambda ()
      (call-with-semaphore (WorkspaceAnalysis-lock engine)
        (lambda ()
          (set-Run-waiting! run (sub1 (Run-waiting run)))
          (when (and (zero? (Run-waiting run))
                     (eq? run (WorkspaceAnalysis-current-run engine))
                     (equal? "indexing" (Run-state run)))
            (renew-run! engine run)))))))

;; An adapter submits complete snapshots: text, document identities, roots and
;; settings have one revision. The adapter owns incremental document updates.
;; A snapshot only marks the index out of date: no work starts until a request.
(define (workspace-analysis-update! engine params)
  (define revision (hash-ref params 'revision))
  (define config (read-settings (hash-ref params 'settings (hasheq))))
  (define roots (map uri->path (hash-ref params 'roots)))
  (define workspace (make-workspace))
  (for ([root (in-list roots)]) (workspace-add-folder! workspace root))
  ;; Only saved files belong to the workspace index.
  (define documents
    (for/hash ([doc (in-list (hash-ref params 'documents))] #:when (file-uri? (hash-ref doc 'uri)))
      (values (hash-ref doc 'uri) doc)))
  (define buffers
    (for/fold ([buffers (hash)]) ([(uri doc) (in-hash documents)])
      (define path (uri->path uri))
      (if (workspace-contains? workspace path)
          (hash-set buffers path (and (not (hash-has-key? buffers path)) (hash-ref doc 'text)))
          buffers)))
  ;; A revision that only opens or closes documents over unchanged sources
  ;; keeps the current run, and a request already past its pass keeps its answer.
  ;; A partial index is retried by a source change or a refresh. Replacing the
  ;; run instead would let a stream of such revisions starve every request.
  (define (adoptable? run)
    (and (not (cancelled? run)) (not (equal? "disabled" (Run-state run)))))
  ;; Only this thread replaces runs or their buffers, so files are compared
  ;; outside the lock and the run is checked again under it.
  (define unchanged
    (let ([current (call-with-semaphore (WorkspaceAnalysis-lock engine)
                     (lambda () (WorkspaceAnalysis-current-run engine)))])
      (and (eq? #t (hash-ref params 'documentsOnly #f)) current (adoptable? current)
           (equal? config (Run-settings current)) (equal? roots (Run-roots current))
           (same-sources? (Run-buffers current) buffers roots (Settings-excluded config)
                          (Settings-max-bytes config))
           current)))
  (call-with-semaphore (WorkspaceAnalysis-lock engine)
    (lambda ()
      (define current (WorkspaceAnalysis-current-run engine))
      (cond
        [(or (WorkspaceAnalysis-closed? engine)
             (and current (<= revision (Run-generation current))))
         (void)]
        [(and unchanged (eq? unchanged current) (adoptable? current))
         (define revised (Run-revised current))
         (set-Run-generation! current revision)
         (set-Run-documents! current documents)
         (set-Run-buffers! current buffers)
         (set-Run-revised! current (make-semaphore))
         (semaphore-post revised)
         (when (member (Run-state current) '("indexing" "ready"))
           (set-Run-unverified?! current #t))]
        ;; A run of changes while a pass runs would otherwise start and stop a
        ;; worker for each one, for a request that is waiting.
        [else (replace-run! engine revision documents buffers config roots
                            #:changed? (not (eq? #t (hash-ref params 'documentsOnly #f)))
                            #:not-before (if (and current (equal? "indexing" (Run-state current)))
                                             (+ (current-inexact-monotonic-milliseconds) 2000)
                                             0))]))))

;; Forgets what earlier analyses found, as for a file no analysis registered.
(define (workspace-analysis-forget! engine)
  (call-with-semaphore (WorkspaceAnalysis-lock engine)
    (lambda () (set-WorkspaceAnalysis-results! engine (hash)))))

(define (workspace-analysis-query engine operation params [cancel never-evt])
  (unless (memq operation '(references prepare-rename rename))
    (raise-argument-error 'workspace-analysis-query "analysis operation" operation))
  (define uri (hash-ref params 'uri))
  (define captured-text (and (eq? operation 'references) (hash-ref params 'text #f)))
  (define (current-document run path)
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
  ;; Ready when a revision adopted by `run` no longer holds the document.
  (define (retired-evt run path)
    (let check ()
      (define revised (Run-revised run))
      (if (current-document run path)
          (replace-evt (semaphore-peek-evt revised) (lambda (_) (check)))
          always-evt)))
  ;; A result stands while its run is current and holds the document.
  (define (settle run path respond)
    (call-with-semaphore (WorkspaceAnalysis-lock engine)
      (lambda ()
        (and (eq? run (WorkspaceAnalysis-current-run engine))
             (not (sync/timeout 0 cancel)) (current-document run path)
             (respond)))))
  ;; A request waits for the sources to settle, and a large first pass takes as long as
  ;; it takes. A replaced pass loses little, as what it finished is kept for the next, so
  ;; one after which more files have results is on its way to an answer, however long that
  ;; takes and however slow the machine. But sources that keep changing can replace every
  ;; pass at the same place. A request found replaced by a change, after waiting for the
  ;; time limit with no more results, stops waiting. It refuses, and answers from no older
  ;; view of the sources, which could be wrong. A document closing is no such change, even
  ;; one whose file has gone and whose buffer was a source: an editor closes documents long
  ;; after their tabs, and it has only so many. The request's own work is not waiting, and
  ;; has a limit of its own.
  (define last-run #f)
  (define most-results 0)
  (define further-at #f)
  (define (still-changing? run)
    (define replaced? (and last-run (not (eq? last-run run))))
    (set! last-run run)
    (and replaced? (Run-changed? run)
         (let ([results (hash-count (WorkspaceAnalysis-results engine))]
               [now (current-inexact-monotonic-milliseconds)])
           (when (or (not further-at) (> results most-results))
             (set! most-results results)
             (set! further-at now))
           (>= (- now further-at) (* 1000 (Settings-timeout (Run-settings run)))))))
  (define (own-work run seconds request evt)
    (define began (current-inexact-monotonic-milliseconds))
    (begin0 (compute engine run seconds request evt)
            (when further-at
              (set! further-at (+ further-at (- (current-inexact-monotonic-milliseconds) began))))))
  (let retry ()
    (define run
      (call-with-semaphore (WorkspaceAnalysis-lock engine)
        (lambda ()
          (define current (WorkspaceAnalysis-current-run engine))
          (when (and current (Run-unverified? current) (equal? "ready" (Run-state current)))
            (renew-run! engine current))
          (WorkspaceAnalysis-current-run engine))))
    (define path (and run (file-uri? uri) (uri->path uri)))
    (define doc (and run (current-document run path)))
    (cond
      [(sync/timeout 0 cancel) (AnalysisFailure 'cancelled "Request cancelled")]
      [(WorkspaceAnalysis-closed? engine) (AnalysisFailure 'closed "Workspace analysis closed")]
      [(not doc) (AnalysisFailure 'changed "Document changed during analysis")]
      [(not (Settings-enabled? (Run-settings run)))
       (if (eq? operation 'references) (accepted run '())
           (AnalysisFailure 'unavailable "Enable workspace analysis to rename safely across files."))]
      [(still-changing? run)
       (AnalysisFailure 'unsettled
                        (format "Workspace sources kept changing for ~a seconds. Try again when they settle."
                                (Settings-timeout (Run-settings run))))]
      [else
       (define retired (retired-evt run path))
       (wait-for-pass engine run
         (lambda ()
           (sync cancel (semaphore-peek-evt (Run-done run)) (semaphore-peek-evt (Run-cancel run)) retired)))
       (cond
         [(or (cancelled? run) (sync/timeout 0 cancel) (sync/timeout 0 retired)) (retry)]
         [(not (eq? operation 'references))
          (define result
            (if (not (equal? (Run-state run) "ready"))
                (cons 'failed (incomplete-index run))
                ;; Rename validates both complete source views. Bound the whole
                ;; transaction separately from the per-file indexing budget.
                (own-work run (if (eq? operation 'rename) 90 (Settings-timeout (Run-settings run)))
                         (list 'rename (make-immutable-hash (hash->list (Run-sources run)))
                               (Run-roots run) (Settings-excluded (Run-settings run))
                               (Settings-max-files (Run-settings run)) (Run-buffers run)
                               path (hash-ref params 'position) (hash-ref params 'newName #f))
                         (choice-evt cancel retired))))
          (or (and result
                   (settle run path
                           (lambda ()
                             (match result
                               [(list 'ok edit) (accepted run edit)]
                               [failure (AnalysisFailure 'unavailable (rename-failure failure))]))))
              (retry))]
         [else
          (define include? (hash-ref params 'includeDeclaration))
          ;; Local and module references use the same fresh analysis. No global
          ;; LSP trace or stale contribution is mixed into the index's results.
          (define result
            (own-work run (Settings-timeout (Run-settings run))
                     (list 'analyse path (Settings-max-bytes (Run-settings run))
                           (hash-ref doc 'text) (list uri (hash-ref params 'position) include? captured-text)
                           (Run-buffers run) (Run-roots run) (hash))
                     (choice-evt cancel retired)))
          (or (and result
                   (settle run path
                           (lambda ()
                             (match result
                               ['(changed)
                                (AnalysisFailure 'changed "Captured source differs from the current file")]
                               [(list 'ok _ _ _ #f _) (accepted run '())]
                               [(list 'ok _ _ _ (list locations binding) _)
                                (define live
                                  (Document-Reference-Result
                                    (Reference-Source (source-id (path->source path))
                                                      (map jsexpr->Location locations))
                                    (and binding (apply Module-Binding binding))))
                                (accepted run
                                          (for/list ([location (in-list (reference-locations (Run-workspace run) live include?))])
                                            (->jsexpr location)))]
                               [failure (AnalysisFailure 'failed (analysis-failure failure))]))))
              (retry))])])))

(provide make-workspace-analysis
         workspace-analysis-update!
         workspace-analysis-query
         workspace-analysis-forget!
         workspace-analysis-close!
         watch-analysis-timer
         default-workers
         (struct-out AnalysisResult)
         (struct-out AnalysisFailure))
