#lang racket/base

(require rackunit pkg/lib racket/async-channel racket/file racket/list racket/path racket/port racket/tcp
         compiler/compile-file
         "../racketdap/protocol.rkt" "../racketdap/worker/attach.rkt"
         (submod "../racketdap/worker/attach.rkt" test-support)
         "support/attach-host.rkt")

(struct client (input output session [seq #:mutable] seen))
(define (send c command [arguments (hasheq)])
  (set-client-seq! c (add1 (client-seq c)))
  (write-message (hasheq 'seq (client-seq c) 'command command 'arguments arguments) (client-output c)))
(define (await c predicate)
  (let loop ()
    (unless (sync/timeout 10 (client-input c)) (error 'attach-test "Timed out waiting for debugger message"))
    (define msg (read-message (client-input c)))
    (when (eof-object? msg) (error 'attach-test "The connection ended"))
    (set-box! (client-seen c) (cons msg (unbox (client-seen c))))
    (if (predicate msg) msg (loop))))
(define (response c command [success? #t])
  (define msg (await c (lambda (msg) (equal? (hash-ref msg 'command #f) command))))
  (check-equal? (hash-ref msg 'success) success? (hash-ref msg 'message ""))
  (hash-ref msg 'body))
(define (ask c command [arguments (hasheq)] [success? #t])
  (send c command arguments) (response c command success?))
(define (stop c)
  (hash-ref (await c (lambda (msg) (equal? (hash-ref msg 'event #f) "stopped"))) 'body))
(define (resume c body [command "continue"])
  (ask c command (hasheq 'threadId (hash-ref body 'threadId))))
(define (result h)
  (define value (sync/timeout 10 (host-results h)))
  (check-not-false value "The host did not finish its job")
  (when (host-failure? value) (raise (host-failure-value value)))
  value)
(define (connect/ports a config)
  (define-values (input requests) (make-pipe))
  (define-values (messages output) (make-pipe))
  (define session (thread (lambda () (serve-attachment/ports a input output config))))
  (define c (client messages requests session 0 (box '())))
  (ask c "configurationDone")
  (check-not-false (sync/timeout 5 (attachment-ready-evt a)))
  c)
(define (with-sample thunk #:roots? [roots? #t] #:exclude [exclude (lambda (_) #f)]
                     #:fresh? [fresh? #f] #:text [text #f])
  (define owner (make-custodian))
  (define dir (make-temporary-file "attached-program-~a" 'directory))
  (define file (build-path dir "sample.rkt"))
  (display-to-file
   (or text "#lang racket/base\n(provide run)\n(define (run [n 10])\n  (define doubled (* n 2))\n  (+ doubled 1))\n") file)
  (dynamic-wind
    void
    (lambda ()
      (parameterize ([current-custodian owner])
        (define pauses (make-async-channel))
        (define a (start-attach #:exclude exclude #:on-pause (lambda (t) (async-channel-put pauses t))
                                #:thread-name "Sample program"))
        (define config (hasheq 'sourceRoots (if roots? (list (path->string dir)) '()) 'debugPackages '()))
        (define c (connect/ports a config))
        (define h
          (parameterize ([current-inspector (make-inspector)])
            (if fresh? (make-host a #:namespace (make-base-namespace)) (make-host a))))
        (dynamic-wind void (lambda () (thunk a c h file dir pauses config))
                          (lambda () (close-attachment! a)))))
    (lambda () (custodian-shutdown-all owner) (delete-directory/files dir))))
(define (load-run h file) (host-load! h file) (car (result h)))
(define (call! a h proc [step-in? #t])
  (host-submit! h (lambda () (call-with-attached-code a proc #:step-in? step-in?))))
(define (break! c file line)
  (ask c "setBreakpoints" (hasheq 'source (hasheq 'path (path->string file))
                                 'breakpoints (list (hasheq 'line line)))))

(module+ test
  (test-case "API version and the three selection-independent host options"
    (check-equal? attach-api-version 1)
    (define-values (required allowed) (procedure-keywords start-attach))
    (check-equal? required '())
    (check-equal? allowed '(#:exclude #:on-pause #:thread-name)))

  (for ([fresh? '(#f #t)])
    (test-case (if fresh? "a program in a fresh namespace shares the instrumentation runtime"
                         "entry, locals, host thread name and Step Out hand back")
      (with-sample #:fresh? fresh?
       (lambda (a c h file dir pauses config)
         (define proc (load-run h file))
         (call! a h proc)
         (define paused (stop c))
         (check-equal? (hash-ref paused 'reason) "step")
         (define threads (hash-ref (ask c "threads") 'threads))
         (check-equal? (map (lambda (t) (hash-ref t 'name)) threads) '("Sample program"))
         (define frames (hash-ref (ask c "stackTrace" (hasheq 'threadId (hash-ref paused 'threadId))) 'stackFrames))
         (check-equal? (hash-ref (hash-ref (car frames) 'source) 'path) (path->string file))
         (define scopes (hash-ref (ask c "scopes" (hasheq 'frameId (hash-ref (car frames) 'id))) 'scopes))
         (define locals (hash-ref (ask c "variables" (hasheq 'variablesReference (hash-ref (car scopes) 'variablesReference))) 'variables))
         (check-true (pair? locals))
         (resume c paused "stepOut")
         (check-equal? (result h) '((21) #t #t))))))

  (test-case "Continue hands back without a pending step"
    (with-sample (lambda (a c h file dir pauses config)
      (call! a h (load-run h file))
      (resume c (stop c))
      (check-equal? (result h) '((21) #f #t)))))

  (test-case "Step Over through the last expression hands back with its step pending"
    (with-sample (lambda (a c h file dir pauses config)
      (call! a h (load-run h file))
      (let loop ([paused (stop c)] [remaining 12])
        (check-true (> remaining 0))
        (resume c paused "next")
        (define next
          (let wait ()
            (define ready
              (sync/timeout 10 (handle-evt (host-results h) (lambda (v) (cons 'result v)))
                               (handle-evt (client-input c) (lambda (_) 'message))))
            (unless ready (error 'attach-test "Step Over did not stop or return"))
            (if (pair? ready) ready
                (let ([msg (read-message (client-input c))])
                  (if (equal? (hash-ref msg 'event #f) "stopped")
                      (cons 'stop (hash-ref msg 'body)) (wait))))))
        (cond [(eq? (car next) 'result) (check-equal? (cdr next) '((21) #t #t))]
              [else (loop (cdr next) (sub1 remaining))])))))

  (test-case "an unused entry stays pending and reports that no selected code ran"
    (with-sample (lambda (a c h file dir pauses config)
      (call! a h (lambda () (values 'one 'two)))
      (check-equal? (result h) '((one two) #t #f)))))

  (test-case "a breakpoint selects a module outside roots and still stops without entry stepping"
    (with-sample #:roots? #f
     (lambda (a c h file dir pauses config)
       (break! c file 4)
       (call! a h (load-run h file) #f)
       (define paused (stop c))
       (check-equal? (hash-ref paused 'reason) "breakpoint")
       (resume c paused)
       (check-equal? (result h) '((21) #f #t)))))

  (test-case "an exclusion wins over roots and breakpoints and preserves bytecode"
    (with-sample #:exclude (lambda (path) (equal? (file-name-from-path path) (string->path "sample.rkt")))
     (lambda (a c h file dir pauses config)
       (define compiled (build-path dir "compiled")) (make-directory compiled)
       (define cache (build-path compiled "sample_rkt.zo"))
       (parameterize ([current-namespace (make-base-namespace)] [read-accept-reader #t]) (compile-file file cache))
       (define bytes (file->bytes cache))
       (break! c file 4)
       (call! a h (load-run h file))
       (check-equal? (result h) '((21) #t #f))
       (check-equal? (file->bytes cache) bytes)
       (check-equal? (hash-ref (ask c "loadedSources") 'sources) '()))))

  (test-case "instrumented source neither replaces nor writes selected bytecode"
    (with-sample (lambda (a c h file dir pauses config)
      (define compiled (build-path dir "compiled")) (make-directory compiled)
      (define cache (build-path compiled "sample_rkt.zo"))
      (parameterize ([current-namespace (make-base-namespace)] [read-accept-reader #t]) (compile-file file cache))
      (define bytes (file->bytes cache))
      (call! a h (load-run h file))
      (resume c (stop c)) (result h)
      (check-equal? (file->bytes cache) bytes)))))

(module+ test
  (test-case "a captured parameterization cannot admit events from a host thread"
    (with-sample (lambda (a c h file dir pauses config)
      (define proc (load-run h file))
      (host-submit! h current-parameterization)
      (define parameters (car (result h)))
      (break! c file 4)
      (define foreign-result (make-async-channel))
      (thread (lambda () (async-channel-put foreign-result (call-with-parameterization parameters proc))))
      (check-equal? (sync/timeout 5 foreign-result) 21)
      (ask c "threads")
      (check-false (for/or ([msg (in-list (unbox (client-seen c)))])
                     (equal? (hash-ref msg 'event #f) "stopped")))
      (call! a h proc #f)
      (define paused (stop c))
      (check-equal? (hash-ref paused 'reason) "breakpoint")
      (resume c paused) (check-equal? (result h) '((21) #f #t)))))

  (test-case "a child thread inherits admission and keeps its ordinary Racket name"
    (with-sample
     #:text "#lang racket/base\n(provide run)\n(define (run)\n  (define child (thread (lambda ()\n    (define n 3)\n    (+ n 2))))\n  (thread-wait child)\n  'done)\n"
     (lambda (a c h file dir pauses config)
       (break! c file 6)
       (call! a h (load-run h file) #f)
       (define paused (stop c))
       (define names (map (lambda (row) (hash-ref row 'name)) (hash-ref (ask c "threads") 'threads)))
       (check-not-false (member "Sample program" names))
       (check-true (ormap (lambda (name) (regexp-match? #rx"^Racket thread " name)) names))
       (resume c paused) (check-equal? (result h) '((done) #f #t)))))

  (test-case "an uncaught exception stops before propagating to the host"
    (with-sample #:text "#lang racket/base\n(provide run)\n(define (run)\n  (error 'sample \"expected failure\"))\n"
     (lambda (a c h file dir pauses config)
       (ask c "setExceptionBreakpoints" (hasheq 'filters '("uncaught")))
       (call! a h (load-run h file) #f)
       (define paused (stop c))
       (check-equal? (hash-ref paused 'reason) "exception")
       (check-false (sync/timeout 0 (host-results h)))
       (resume c paused)
       (define failure (sync/timeout 5 (host-results h)))
       (check-true (host-failure? failure))
       (check-regexp-match #rx"expected failure" (exn-message (host-failure-value failure))))))

  (test-case "Pause inside a blocked call inspects from an unmarked service thread"
    (with-sample
     #:text "#lang racket/base\n(provide run)\n(define (run entered gate)\n  (semaphore-post entered)\n  (semaphore-wait gate)\n  'done)\n"
     (lambda (a c h file dir pauses config)
       (define proc (load-run h file))
       (define entered (make-semaphore)) (define gate (make-semaphore))
       (call! a h (lambda () (proc entered gate)) #f)
       (check-not-false (sync/timeout 5 entered))
       (sleep 0.2)
       (attachment-pause! a (host-thread h))
       (define paused (stop c))
       (check-equal? (hash-ref paused 'reason) "pause")
       (check-true (hash-ref paused 'racketdapApproximate))
       (check-false (sync/timeout 0 pauses))
       (check-false (thread-running? (host-thread h)))
       (define stack (hash-ref (ask c "stackTrace" (hasheq 'threadId (hash-ref paused 'threadId))) 'stackFrames))
       (check-true (pair? stack))
       (resume c paused)
       (semaphore-post gate)
       (check-equal? (result h) '((done) #f #t)))))

  (test-case "Pause outside a boundary delegates to the host without a Racket stop"
    (with-sample (lambda (a c h file dir pauses config)
      (call! a h (load-run h file) #f) (result h)
      (attachment-pause! a (host-thread h))
      (check-eq? (sync/timeout 5 pauses) (host-thread h))
      (define row (car (hash-ref (ask c "threads") 'threads)))
      (ask c "pause" (hasheq 'threadId (hash-ref row 'id)))
      (check-eq? (sync/timeout 5 pauses) (host-thread h))
      (ask c "threads")
      (check-false (for/or ([msg (in-list (unbox (client-seen c)))])
                     (equal? (hash-ref msg 'event #f) "stopped"))))))

  (test-case "Disconnect releases a source pause and leaves host threads alive"
    (with-sample (lambda (a c h file dir pauses config)
      (call! a h (load-run h file)) (stop c)
      (close-output-port (client-output c))
      (check-not-false (sync/timeout 5 (attachment-ended-evt a)))
      (check-equal? (result h) '((21) #f #t))
      (check-false (thread-dead? (host-thread h)))
      (check-not-false (sync/timeout 5 (client-session c)))
      (check-false (for/or ([msg (in-list (unbox (client-seen c)))])
                     (equal? (hash-ref msg 'type #f) "workerExit"))))))

  (test-case "closing releases a suspension pause without terminating the host"
    (with-sample
     #:text "#lang racket/base\n(provide run)\n(define (run entered gate)\n  (semaphore-post entered)\n  (semaphore-wait gate)\n  'done)\n"
     (lambda (a c h file dir pauses config)
       (define proc (load-run h file))
       (define entered (make-semaphore)) (define gate (make-semaphore))
       (call! a h (lambda () (proc entered gate)) #f)
       (check-not-false (sync/timeout 5 entered)) (sleep 0.2)
       (attachment-pause! a (host-thread h)) (stop c)
       (close-attachment! a)
       (check-not-false (sync/timeout 5 (attachment-ended-evt a)))
       (semaphore-post gate)
       (check-equal? (result h) '((done) #f #t)))))

  (test-case "close after the host program thread is killed takes no program lock"
    (with-sample (lambda (a c h file dir pauses config)
      (call! a h (load-run h file)) (stop c)
      (kill-thread (host-thread h))
      (define closer (thread (lambda () (close-attachment! a))))
      (check-not-false (sync/timeout 5 closer))
      (check-not-false (sync/timeout 5 (attachment-ended-evt a))))))

  (test-case "a new session uses instrumentation loaded by the previous session"
    (with-sample (lambda (a c h file dir pauses config)
      (define proc (load-run h file))
      (close-output-port (client-output c))
      (check-not-false (sync/timeout 5 (attachment-ended-evt a)))
      (check-not-false (sync/timeout 5 (client-session c)))
      (define next (connect/ports a config))
      (break! next file 4)
      (call! a h proc #f)
      (define paused (stop next))
      (check-equal? (hash-ref paused 'reason) "breakpoint")
      (resume next paused)
      (check-equal? (result h) '((21) #f #t)))))

  (test-case "attach refuses input and interrupt and never starts a program"
    (with-sample (lambda (a c h file dir pauses config)
      (ask c "racketdap/input" (hasheq 'text "input") #f)
      (ask c "racketdap/interrupt" (hasheq) #f)
      (ask c "configurationDone" (hasheq) #f)
      (check-false (thread-dead? (host-thread h))))))
  (test-case "an attach configuration without roots selects nothing by the host's directory"
    (with-sample #:roots? #f
     (lambda (a c h file dir pauses config)
       (close-output-port (client-output c))
       (check-not-false (sync/timeout 5 (attachment-ended-evt a)))
       (check-not-false (sync/timeout 5 (client-session c)))
       (parameterize ([current-directory dir]) (connect/ports a (hasheq)))
       (call! a h (load-run h file))
       (check-equal? (result h) '((21) #t #f)))))
  (test-case "Pause of a thread the attached code starts stops it in Racket, not in the host"
    (with-sample
     #:text "#lang racket/base\n(provide run)\n(define (run started finish)\n  (define child\n    (thread (lambda ()\n      (semaphore-post started)\n      (let loop ([i 0])\n        (if (semaphore-try-wait? finish) i (loop (add1 i)))))))\n  (thread-wait child)\n  'done)\n"
     (lambda (a c h file dir pauses config)
       (define proc (load-run h file))
       (define started (make-semaphore)) (define finish (make-semaphore))
       (call! a h (lambda () (proc started finish)) #f)
       (check-not-false (sync/timeout 5 started))
       (define child (for/first ([row (in-list (hash-ref (ask c "threads") 'threads))]
                                 #:when (regexp-match? #rx"^Racket thread " (hash-ref row 'name)))
                       row))
       (check-not-false child)
       (ask c "pause" (hasheq 'threadId (hash-ref child 'id)))
       (check-equal? (hash-ref (stop c) 'threadId) (hash-ref child 'id))
       (check-false (sync/timeout 0.5 pauses))
       (semaphore-post finish)))))

(module+ test
  (test-case "debugPackages in the attach configuration selects installed source"
    (with-sample #:roots? #f #:fresh? #t
     (lambda (a c h file dir pauses config)
       (close-output-port (client-output c))
       (check-not-false (sync/timeout 5 (attachment-ended-evt a)))
       (check-not-false (sync/timeout 5 (client-session c)))
       (define next (connect/ports a (hasheq 'sourceRoots '() 'debugPackages '("rackunit-lib"))))
       (define selected (build-path (pkg-directory "rackunit-lib") "rackunit" "private" "location.rkt"))
       (host-submit! h (lambda () (dynamic-require selected #f)))
       (result h)
       (define sources (hash-ref (ask next "loadedSources") 'sources))
       (check-not-false (member (path->string selected) (map (lambda (source) (hash-ref source 'path)) sources))))))

  ;; The preceding cases exercise the same session over pipes. Without
  ;; loopback TCP the token rule is unverified, so this case then fails.
  (define tcp-owner (make-custodian))
  (define tcp-attachment #f)
  (define listener-result
    (parameterize ([current-custodian tcp-owner])
      (set! tcp-attachment (start-attach))
      (with-handlers ([exn:fail:network? values])
        (call-with-values (lambda () (attachment-listen! tcp-attachment)) list))))
  (cond
    [(exn? listener-result)
     (test-case "listener rejects a wrong token, authenticates and can listen again"
       (fail (string-append "Loopback TCP is unavailable: " (exn-message listener-result))))]
    [else
     (test-case "listener rejects a wrong token, authenticates and can listen again"
       (define port (car listener-result)) (define token (cadr listener-result))
       (define-values (bad-in bad-out) (tcp-connect "127.0.0.1" port))
       (write-message (hasheq 'type "hello" 'version 1 'token "incorrect") bad-out)
       (check-not-false (sync/timeout 5 bad-in)) (check-true (eof-object? (read-byte bad-in)))
       (close-input-port bad-in) (close-output-port bad-out)
       (define-values (input output) (tcp-connect "127.0.0.1" port))
       (write-message (hasheq 'type "hello" 'version 1 'token token
                             'config (hasheq 'sourceRoots '() 'debugPackages '()) 'client (hasheq)) output)
       (check-not-false (sync/timeout 5 input))
       (check-equal? (read-message input) (hasheq 'type "hello" 'version 1))
       (define c (client input output #f 0 (box '())))
       (ask c "configurationDone")
       (check-not-false (sync/timeout 5 (attachment-ready-evt tcp-attachment)))
       (close-output-port output)
       (check-not-false (sync/timeout 5 (attachment-ended-evt tcp-attachment)))
       (close-input-port input)
       (define-values (next-port next-token) (attachment-listen! tcp-attachment))
       (check-true (exact-positive-integer? next-port))
       (check-not-equal? token next-token)
       (close-attachment! tcp-attachment))])
  (close-attachment! tcp-attachment)
  (custodian-shutdown-all tcp-owner))

(module+ test
  (test-case "Pause can suspend an attached call before any selected source runs"
    (with-sample #:roots? #f
     (lambda (a c h file dir pauses config)
       (define entered (make-semaphore)) (define gate (make-semaphore))
       (call! a h (lambda () (semaphore-post entered) (semaphore-wait gate) 'done) #f)
       (check-not-false (sync/timeout 5 entered))
       (attachment-pause! a (host-thread h))
       (define paused (stop c))
       (check-equal? (hash-ref paused 'reason) "pause")
       (check-true (hash-ref paused 'racketdapApproximate))
       (resume c paused)
       (semaphore-post gate)
       (check-equal? (result h) '((done) #f #f)))))

  (test-case "the host's protected lock region delays suspension until its lock is released"
    (with-sample #:roots? #f
     (lambda (a c h file dir pauses config)
       (define entered (make-semaphore)) (define gate (make-semaphore))
       (define left (make-semaphore)) (define finish (make-semaphore))
       (call! a h
        (lambda ()
          (host-protected h (lambda () (semaphore-post entered) (semaphore-wait gate)))
          (semaphore-post left) (semaphore-wait finish) 'done) #f)
       (check-not-false (sync/timeout 5 entered))
       (attachment-pause! a (host-thread h))
       (sleep 0.2)
       ;; Request handling remains live while suspension is refused.
       (ask c "threads")
       (check-false (for/or ([msg (in-list (unbox (client-seen c)))])
                      (equal? (hash-ref msg 'event #f) "stopped")))
       (semaphore-post gate)
       (check-not-false (sync/timeout 5 left))
       (define paused (stop c))
       (check-not-false (sync/timeout 1 (host-lock h)))
       (semaphore-post (host-lock h))
       (resume c paused) (semaphore-post finish)
       (check-equal? (result h) '((done) #f #f)))))

  (test-case "Pause delayed until a call returns delegates to the host once"
    (with-sample #:roots? #f
     (lambda (a c h file dir pauses config)
       (define entered (make-semaphore)) (define gate (make-semaphore))
       (call! a h
        (lambda () (host-protected h (lambda () (semaphore-post entered) (semaphore-wait gate))) 'done) #f)
       (check-not-false (sync/timeout 5 entered))
       (attachment-pause! a (host-thread h))
       (semaphore-post gate)
       (check-equal? (result h) '((done) #f #f))
       (check-eq? (sync/timeout 5 pauses) (host-thread h))
       (check-false (sync/timeout 0 pauses))))))

(module+ test
  (test-case "exception callbacks in an unmarked thread cannot pause the session"
    (with-sample
     #:text "#lang racket/base\n(provide run)\n(define (run)\n  (error 'sample \"foreign failure\"))\n"
     (lambda (a c h file dir pauses config)
       (define proc (load-run h file))
       (host-submit! h current-parameterization)
       (define parameters (car (result h)))
       (ask c "setExceptionBreakpoints" (hasheq 'filters '("uncaught")))
       (define observed (make-async-channel))
       (thread
        (lambda ()
          (async-channel-put observed
            (with-handlers ([exn:fail? values])
              (call-with-parameterization parameters
                (lambda () (call-with-attached-code a proc #:step-in? #t)))))))
       (define failure (sync/timeout 5 observed))
       (check-true (exn:fail? failure))
       (check-regexp-match #rx"foreign failure" (exn-message failure))
       (ask c "threads")
       (check-false (for/or ([msg (in-list (unbox (client-seen c)))])
                      (equal? (hash-ref msg 'event #f) "stopped")))))))

(module+ test
  (test-case "the library's superior inspector opens a fresh program's opaque structures"
    (with-sample #:fresh? #t
     #:text "#lang racket/base\n(provide run)\n(struct specimen (tag value))\n(define (run)\n  (define item (specimen 'packet 42))\n  (list item))\n"
     (lambda (a c h file dir pauses config)
       (break! c file 6)
       (call! a h (load-run h file) #f)
       (define paused (stop c))
       (define frames (hash-ref (ask c "stackTrace" (hasheq 'threadId (hash-ref paused 'threadId))) 'stackFrames))
       (define scopes (hash-ref (ask c "scopes" (hasheq 'frameId (hash-ref (car frames) 'id))) 'scopes))
       (define locals (hash-ref (ask c "variables" (hasheq 'variablesReference (hash-ref (car scopes) 'variablesReference))) 'variables))
       (define item (findf (lambda (row) (equal? (hash-ref row 'name) "item")) locals))
       (check-not-false item)
       (define fields (hash-ref (ask c "variables" (hasheq 'variablesReference (hash-ref item 'variablesReference))) 'variables))
       (check-equal? (length fields) 2)
       (check-equal? (hash-ref (cadr fields) 'value) "42")
       (resume c paused)
       (check-equal? (cdr (result h)) '(#f #t))))))
