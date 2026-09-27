#lang racket/base

(require racket/async-channel racket/file racket/list racket/path racket/port
         racket/random racket/runtime-path racket/string racket/tcp
         "protocol.rkt" "commands.rkt" "process-group.rkt")
(define-runtime-path worker-path "worker/main.rkt")
(define input (current-input-port))
(define output (current-output-port))
(define messages (make-async-channel))
(define sequence 0)
(define client (hasheq))
(define process #f)
(define process-group #f)
(define connection-custodian #f)
(define bootstrap-out #f)
(define launch-request #f)
(define launch-deadline #f)
(define worker-in #f)
(define worker-out #f)
(define finished? #f)
(define initialized? #f)
(define launch-used? #f)
(define desired-exit #f)
(define actual-exit #f)
(define streams-done 0)
(define output-ports '())
(define terminal? #f)
(define pending (make-hasheqv))
(define (send message)
  (set! sequence (add1 sequence))
  (write-message (hash-set message 'seq sequence) output))
(define (reply request [body (hasheq)] [error #f])
  (send (hasheq 'type "response" 'request_seq (hash-ref request 'seq)
                'command (hash-ref request 'command) 'success (not error)
                'body body 'message (or error ""))))
(define (event name [body (hasheq)]) (send (hasheq 'type "event" 'event name 'body body)))
(define (terminate-worker)
  (cond
    [process-group
     (stop-process-group! process-group)
     (set! process-group #f)]
    [process (subprocess-kill process #t)]))
(define (fail-launch! message)
  (when launch-request
    (reply launch-request (hasheq) message)
    (set! launch-request #f)
    (set! launch-deadline #f)
    (when (and bootstrap-out (not (port-closed? bootstrap-out))) (close-output-port bootstrap-out))
    (when connection-custodian (custodian-shutdown-all connection-custodian))))
(define (complete! code)
  (unless finished?
    (terminate-worker)
    (fail-launch! "The Racket worker exited before initialization completed.")
    (set! finished? #t)
    (for ([request (in-hash-values pending)]) (reply request (hasheq) "The debug session ended."))
    (hash-clear! pending)
    (event "exited" (hasheq 'exitCode code))
    (event "terminated")
    (when worker-out (close-output-port worker-out))
    (when worker-in (close-input-port worker-in))
    (when connection-custodian (custodian-shutdown-all connection-custodian))))
(define (maybe-complete)
  (when (and actual-exit (= streams-done 2)) (complete! (or desired-exit actual-exit))))
(define (copy-output port category)
  (set! output-ports (cons port output-ports))
  (thread
   (lambda ()
     (dynamic-wind
       void
       (lambda ()
         (with-handlers ([exn:fail? void])
           (let loop ()
             (define first (read-char port))
             (unless (eof-object? first)
               (define text (open-output-string))
               (write-char first text)
               (let collect ([n 1])
                 (when (and (< n 1024) (char-ready? port))
                   (define char (read-char port))
                   (unless (eof-object? char) (write-char char text) (collect (add1 n)))))
               (async-channel-put messages (cons 'output (hasheq 'category category 'output (get-output-string text))))
               (loop)))))
       (lambda ()
         (unless (port-closed? port) (close-input-port port))
         (async-channel-put messages (cons 'streamDone category)))))))
(define (launch request)
  (unless initialized? (error 'launch "Initialize the adapter first."))
  (when finished? (error 'launch "The debug session has ended. Start a new session to launch a program."))
  (when launch-used? (error 'launch "Start a new debug session for another launch."))
  (define args (hash-ref request 'arguments))
  (when (and (hash-ref args 'testMode #f)
             (or (hash-ref args 'interactive #f) (hash-ref args 'entry #f)
                 (hash-ref args 'language #f) (hash-has-key? args 'submodule)))
    (error 'launch "testMode cannot be combined with interactive, entry, language, or submodule."))
  (unless (member (hash-ref args 'console "internalConsole") '("internalConsole" "integratedTerminal"))
    (error 'launch "console must be internalConsole or integratedTerminal."))
  (set! terminal? (equal? (hash-ref args 'console "internalConsole") "integratedTerminal"))
  (define program (simplify-path (path->complete-path (hash-ref args 'program))))
  (unless (file-exists? program) (error 'launch "Program does not exist: ~a" program))
  (define cwd (simplify-path (path->complete-path (hash-ref args 'cwd (path-only program)))))
  (unless (directory-exists? cwd) (error 'launch "Working directory does not exist: ~a" cwd))
  (unless (and (list? (hash-ref args 'args '())) (andmap string? (hash-ref args 'args '())))
    (error 'launch "args must be an array of strings."))
  (define packages (hash-ref args 'debugPackages '()))
  (unless (and (list? packages)
               (andmap (lambda (name) (and (string? name) (positive? (string-length name)))) packages))
    (error 'launch "debugPackages must be an array of nonempty package names."))
  (define config (hash-set (hash-set args 'program (path->string program)) 'cwd (path->string cwd)))
  (define executable
    (or (find-executable-path (hash-ref args 'racketExecutable (path->string (find-system-path 'exec-file))))
        (error 'launch "Cannot find the configured Racket executable.")))
  (define token (apply string-append (for/list ([b (in-bytes (crypto-random-bytes 32))]) (format "~x" b))))
  (define environment (environment-variables-copy (current-environment-variables)))
  (for ([(key value) (in-hash (hash-ref args 'env (hasheq)))])
    (environment-variables-set! environment (string->bytes/utf-8 (symbol->string key))
                                (and (not (eq? value 'null)) (string->bytes/utf-8 value))))
  (set! launch-used? #t)
  (set! connection-custodian (make-custodian))
  (with-handlers ([exn:fail? (lambda (e)
                             (custodian-shutdown-all connection-custodian)
                             (terminate-worker)
                             (raise e))])
    (define listener
      (parameterize ([current-custodian connection-custodian])
        (tcp-listen 0 1 #t "127.0.0.1")))
    (define-values (_local port _remote _remote-port) (tcp-addresses listener #t))
    (define-values (owned-group group-leader) (start-process-group))
    (set! process-group owned-group)
    (define-values (child child-out child-in child-error)
      (parameterize ([current-directory cwd] [current-environment-variables environment]
                     ;; Restricted descriptor inheritance prevents piped child
                     ;; creation on Windows Racket. Use its normal handle policy.
                     [current-subprocess-keep-file-descriptors
                      (if (eq? (system-type 'os) 'windows) 'inherited '())])
        (subprocess #f #f #f group-leader executable (path->string worker-path))))
    (set! process child)
    (set! bootstrap-out child-in)
    (set! launch-request request)
    ;; The deadline covers the entire bootstrap, accept, and framed handshake,
    ;; including peers that connect but send only a partial message.
    (set! launch-deadline (+ (current-inexact-monotonic-milliseconds) 15000))
    (copy-output child-out "stdout") (copy-output child-error "stderr")
    (thread (lambda () (subprocess-wait child)
              (async-channel-put messages (cons 'exit (subprocess-status child)))))
    (parameterize ([current-custodian connection-custodian])
      (thread
       (lambda ()
         (with-handlers ([exn:fail? (lambda (e) (async-channel-put messages (cons 'startupError (exn-message e))))])
           (dynamic-wind
             void
             (lambda ()
               (write-message (hasheq 'port port 'token token 'config config 'client client) child-in))
             (lambda () (unless (port-closed? child-in) (close-output-port child-in))))
           (define connection (sync (tcp-accept-evt listener)))
           (tcp-close listener)
           (define in (car connection))
           (define out (cadr connection))
           (define hello (read-message in))
           (unless (and (hash? hello) (equal? (hash-ref hello 'token #f) token)
                        (equal? (hash-ref hello 'version #f) 1))
             (error 'launch "Invalid worker authentication or protocol version."))
           (async-channel-put messages (cons 'ready (cons in out)))
           (with-handlers ([exn:fail? (lambda (_) (async-channel-put messages (cons 'workerEOF #f)))])
             (let loop ()
               (define message (read-message in))
               (if (eof-object? message) (async-channel-put messages (cons 'workerEOF #f))
                   (begin (async-channel-put messages (cons 'worker message)) (loop)))))))))))
(define (dispatch request)
  (define command (hash-ref request 'command))
  (case (string->symbol command)
    [(initialize)
     (when initialized? (error 'initialize "Adapter is already initialized."))
     (set! client (hash-ref request 'arguments (hasheq)))
     (unless (equal? (hash-ref client 'pathFormat "path") "path") (error 'initialize "Only filesystem paths are supported."))
     (set! initialized? #t)
     (reply request
            (hasheq 'supportsConfigurationDoneRequest #t 'supportsTerminateRequest #t
                    'supportsSetVariable #t 'supportsEvaluateForHovers #t
                    'supportsLoadedSourcesRequest #t 'supportsBreakpointLocationsRequest #t
                    'supportsSingleThreadExecutionRequests #t
                    'supportsConditionalBreakpoints #t 'supportsHitConditionalBreakpoints #t
                    'supportsLogPoints #t 'supportsCancelRequest #t 'supportsExceptionInfoRequest #t
                    'exceptionBreakpointFilters
                    (list (hasheq 'filter "uncaught" 'label "Uncaught Racket exceptions" 'default #t
                                  'description "Stop on uncaught runtime exceptions before the worker handles them."))))]
    [(launch) (launch request)]
    [(terminate disconnect)
     (reply request)
     (set! desired-exit 0)
     (fail-launch! "Launch cancelled by the client.")
     (if process (terminate-worker) (complete! 0))]
    [else
     (cond
       ;; A client can refresh its thread list after receiving an exit event.
       ;; No target threads remain once completion has closed the worker.
       [(and finished? (equal? command "threads"))
        (reply request (hasheq 'threads '()))]
       [(worker-command? command)
        (unless (and worker-out (not finished?)) (error 'debugger "No active launched program."))
        (hash-set! pending (hash-ref request 'seq) request)
        (write-message request worker-out)]
       [else (reply request (hasheq) (format "Unsupported request: ~a" command))])]))

(define input-reader (thread
 (lambda ()
   (with-handlers ([exn:fail? (lambda (_) (async-channel-put messages (cons 'eof #f)))])
     (let loop ()
       (define message (read-message input))
       (if (eof-object? message) (async-channel-put messages (cons 'eof #f))
           (begin (async-channel-put messages (cons 'request message)) (loop))))))))
(let loop ()
  (define item
    (sync messages
          (if launch-deadline
              (wrap-evt (alarm-evt launch-deadline #t) (lambda (_) (cons 'startupTimeout #f)))
              never-evt)))
  (case (car item)
    [(eof)
     (terminate-worker)
     ;; Termination can be asynchronous, notably on Windows. Reap the owned
     ;; worker before the adapter exits and the client releases its workspace.
     (when process (subprocess-wait process))
     (when connection-custodian (custodian-shutdown-all connection-custodian))
     (exit 0)]
    [(ready)
     (when (and launch-request (not finished?))
       (set! worker-in (car (cdr item)))
       (set! worker-out (cdr (cdr item)))
       (reply launch-request)
       (set! launch-request #f)
       (set! launch-deadline #f)
       (event "initialized"))]
    [(startupTimeout startupError)
     (when launch-request
       (fail-launch! (if (eq? (car item) 'startupTimeout)
                         "Racket worker initialization timed out after 15 seconds."
                         (cdr item)))
       (terminate-worker))]
    [(request)
     (with-handlers ([exn:fail? (lambda (e)
                                (hash-remove! pending (hash-ref (cdr item) 'seq))
                                (reply (cdr item) (hasheq) (exn-message e)))])
       (dispatch (cdr item)))]
    [(output) (unless finished? (event (if terminal? "racketdap/terminalOutput" "output") (cdr item)))]
    [(streamDone) (set! streams-done (add1 streams-done)) (maybe-complete)]
    [(exit)
     (set! actual-exit (cdr item))
     (fail-launch! "The Racket worker exited before initialization completed.")
     (terminate-worker)
     (maybe-complete)
     ;; A native crash can leave inherited pipe handles in descendants. Give
     ;; output a bounded drain interval instead of hanging termination forever.
     (unless finished?
       (thread (lambda () (sleep 1) (async-channel-put messages (cons 'drain #f)))))]
    [(drain)
     (unless finished?
       (for ([port (in-list output-ports)])
         (unless (port-closed? port) (close-input-port port))))]
    [(workerEOF) (unless finished? (terminate-worker))]
    [(worker)
     (define message (cdr item))
     (when (equal? (hash-ref message 'type) "response") (hash-remove! pending (hash-ref message 'request_seq)))
     (cond [(equal? (hash-ref message 'type) "workerExit")
            (set! desired-exit (hash-ref message 'exitCode)) (terminate-worker)]
           [(not finished?) (send message)])])
  (loop))
