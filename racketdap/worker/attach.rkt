#lang racket/base

(require racket/random racket/tcp
         "../protocol.rkt" "../packages.rkt" "../instrumentation/runtime.rkt"
         "load.rkt" "session.rkt")
(provide attach-api-version start-attach attachment-listen!
         attachment-ready-evt attachment-ended-evt call-with-attached-program
         call-with-attached-code attachment-pause! close-attachment!)

(define attach-api-version 1)
(struct connection (ready ended [controller #:mutable] [listener #:mutable]
                          [input #:mutable] [output #:mutable] [closed? #:mutable]))
(struct attachment (exclude on-pause thread-name mark boundaries snapshots [sites #:mutable]
                            [program-thread #:mutable] [connection #:mutable]
                            [loaders #:mutable] [roots #:mutable] [next-site #:mutable]))
(define (new-connection)
  (connection (make-semaphore) (make-semaphore) #f #f #f #f #f))
(define (start-attach #:exclude [excluded? (lambda (_) #f)]
                      #:on-pause [on-pause void] #:thread-name [name "Attached program"])
  (define c (new-connection))
  (semaphore-post (connection-ended c))
  (attachment excluded? on-pause name (make-thread-cell #f #t)
              (make-weak-hasheq) (make-hash) '() #f c (make-weak-hasheq) '() 0))
(define (attachment-ready-evt a)
  (semaphore-peek-evt (connection-ready (attachment-connection a))))
(define (attachment-ended-evt a)
  (semaphore-peek-evt (connection-ended (attachment-connection a))))
(define (controller a)
  (define c (attachment-connection a))
  (and (not (connection-closed? c)) (connection-controller c)))
(define (close-connection! c)
  ;; Closing never acquires a lock a suspended program thread might own.
  (unless (connection-closed? c)
    (set-connection-closed?! c #t)
    (when (connection-controller c) ((attached-controller-close! (connection-controller c))))
    (semaphore-post (connection-ended c))
    (when (connection-listener c)
      (tcp-close (connection-listener c))
      (set-connection-listener! c #f))
    (for ([port (in-list (list (connection-input c) (connection-output c)))])
      (when port
        (with-handlers ([exn:fail? void])
          (if (input-port? port) (close-input-port port) (close-output-port port)))))))
(define (close-attachment! a) (close-connection! (attachment-connection a)))
(define (inside-call? a t)
  (for/or ([token (in-list (continuation-mark-set->list (continuation-marks t) context-key))])
    (hash-ref (attachment-boundaries a) token #f)))

;; A module's namespace may have a different registry from the host's. Build
;; its loader there, attaching our own instrumentation modules before expansion.
;; The dispatcher stays installed across connections; callbacks always address
;; the current session, including in procedures loaded by an earlier session.
(define (call-with-attached-program a thunk)
  (define cell (attachment-mark a))
  (define previous (thread-cell-ref cell))
  (unless (attachment-program-thread a) (set-attachment-program-thread! a (current-thread)))
  (define ordinary-load (current-load/use-compiled))
  (define ordinary-source-load (current-load))
  (define (loader)
    (hash-ref!
     (attachment-loaders a) (namespace-module-registry (current-namespace))
     (lambda ()
       (parameterize ([current-load/use-compiled ordinary-load] [current-load ordinary-source-load])
         (define-values (compiled source _select _finish)
           (make-debug-loader
            (current-namespace) #f #:exclude (attachment-exclude a)
            #:fresh-id (lambda () (begin0 (attachment-next-site a)
                                   (set-attachment-next-site! a (add1 (attachment-next-site a)))))
            #:source-roots (attachment-roots a)
            #:source-selected? (lambda (path)
                                 (define c (controller a))
                                 (and c ((attached-controller-selected? c) path)))
            #:on-source-snapshot
            (lambda (path text)
              (hash-set! (attachment-snapshots a) path text)
              (define c (controller a))
              (when c ((attached-controller-on-source-snapshot c) path text)))
            #:on-sites
            (lambda (sites)
              (set-attachment-sites! a (append sites (attachment-sites a)))
              (define c (controller a))
              (when c ((attached-controller-on-sites c) sites)))
            #:on-event (lambda (stop)
                         (define c (controller a))
                         (when c ((attached-controller-on-event c) stop)))))
         (cons compiled source)))))
  (dynamic-wind
    (lambda () (thread-cell-set! cell a))
    (lambda ()
      (parameterize ([current-load/use-compiled
                      (lambda (path expected)
                        (if (controller a) ((car (loader)) path expected) (ordinary-load path expected)))]
                     [current-load
                      (lambda (path expected)
                        (if (controller a) ((cdr (loader)) path expected) (ordinary-source-load path expected)))])
        (thunk)))
    (lambda () (thread-cell-set! cell previous))))
(define (call-with-attached-code a thunk #:step-in? [step-in? #f])
  (define token (gensym 'attached-call))
  (dynamic-wind
    (lambda () (hash-set! (attachment-boundaries a) token
                            (eq? (thread-cell-ref (attachment-mark a)) a)))
    (lambda ()
      (with-continuation-mark context-key token
        (let ([c (controller a)])
          (if c ((attached-controller-run-code c) thunk step-in?)
              (values (call-with-values thunk list) #f #f)))))
    (lambda () (hash-remove! (attachment-boundaries a) token))))
(define (attachment-pause! a t)
  (define c (controller a))
  (when c ((attached-controller-pause! c) t)))

(define (serve-attachment a c input output config client)
  (set-connection-input! c input)
  (set-connection-output! c output)
  (dynamic-wind
    void
    (lambda ()
      (set-attachment-roots! a
        (append (hash-ref config 'sourceRoots (lambda () (if (hash-ref config 'cwd #f) (list (hash-ref config 'cwd)) '())))
                (package-source-roots (hash-ref config 'debugPackages '()))))
      (set-attachment-loaders! a (make-weak-hasheq))
      (serve-session
       input output config client #f
       #:attach
       (attach-hooks
        (lambda () (eq? (thread-cell-ref (attachment-mark a)) a))
        (lambda () (attachment-program-thread a)) (attachment-thread-name a)
        (lambda (t) (inside-call? a t)) (attachment-on-pause a)
        (lambda (control)
          (set-connection-controller! c control)
          (for ([(path text) (in-hash (attachment-snapshots a))])
            ((attached-controller-on-source-snapshot control) path text))
          ((attached-controller-on-sites control) (attachment-sites a)))
        (lambda () (semaphore-post (connection-ready c))))))
    (lambda () (close-connection! c))))

(define (attachment-listen! a)
  (define old (attachment-connection a))
  (unless (or (connection-closed? old) (sync/timeout 0 (semaphore-peek-evt (connection-ended old))))
    (error 'attachment-listen! "An attachment is already listening or connected."))
  (define listener (tcp-listen 0 4 #t "127.0.0.1"))
  (define-values (_host port _remote _remote-port) (tcp-addresses listener #t))
  (define token
    (apply string-append (for/list ([b (in-bytes (crypto-random-bytes 32))])
                           (string-append (if (< b 16) "0" "") (number->string b 16)))))
  (define c (new-connection))
  (set-connection-listener! c listener)
  (set-attachment-connection! a c)
  (thread
   (lambda ()
     (with-handlers ([exn:fail? (lambda (_) (close-connection! c))])
       (let accept ()
         (define-values (input output) (tcp-accept listener))
         (set-connection-input! c input)
         (set-connection-output! c output)
         ;; Bound a partial or silent peer's hello so it cannot keep the only
         ;; accept loop. No program thread belongs to this connection reader.
         (define hello-channel (make-channel))
         (define reader
           (thread (lambda ()
                     (channel-put hello-channel
                       (with-handlers ([exn:fail? (lambda (_) #f)]) (read-message input))))))
         (define hello (sync/timeout 15 hello-channel))
         (unless (thread-dead? reader) (kill-thread reader))
         (cond
           [(and (hash? hello) (equal? (hash-ref hello 'type #f) "hello")
                 (equal? (hash-ref hello 'version #f) 1)
                 (equal? (hash-ref hello 'token #f) token))
            (tcp-close listener)
            (set-connection-listener! c #f)
            (write-message (hasheq 'type "hello" 'version 1) output)
            (serve-attachment a c input output (hash-ref hello 'config) (hash-ref hello 'client (hasheq)))]
           [else
            (close-input-port input) (close-output-port output)
            (set-connection-input! c #f) (set-connection-output! c #f)
            (accept)])))))
  (values port token))

;; Exercise the same session over pipes where loopback listeners are unavailable.
(module+ test-support
  (provide serve-attachment/ports)
  (define (serve-attachment/ports a input output config [client (hasheq)])
    (define c (new-connection))
    (set-attachment-connection! a c)
    (serve-attachment a c input output config client)))
