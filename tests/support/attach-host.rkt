#lang racket/base

(require racket/async-channel racket/match
         "../../racketdap/worker/attach.rkt"
         "../../racketdap/instrumentation/runtime.rkt")
(provide make-host host-thread host-results host-procedures host-submit! host-load!
         host-protected host-lock (struct-out parcel) (struct-out host-failure))

(struct parcel (label value))
(struct host-failure (value) #:transparent)
(struct host (thread jobs results procedures lock))
(define (make-host attachment #:namespace [namespace (current-namespace)])
  (define jobs (make-async-channel))
  (define results (make-async-channel))
  (define procedures (make-hash))
  (define lock (make-semaphore 1))
  (define target
    (thread
     (lambda ()
       (parameterize ([current-namespace namespace])
         (call-with-attached-program attachment
          (lambda ()
            (let loop ()
              (define job (async-channel-get jobs))
              (unless (eq? job 'stop)
                (async-channel-put results
                  (with-handlers ([(lambda (_) #t) host-failure])
                    (call-with-values job list)))
                (loop)))))))))
  (host target jobs results procedures lock))
(define (host-submit! host thunk) (async-channel-put (host-jobs host) thunk))
(define (host-load! host path [name 'run])
  (host-submit! host
    (lambda ()
      (define proc (dynamic-require path name))
      (hash-set! (host-procedures host) name proc)
      proc)))
(define (host-protected host thunk)
  (with-continuation-mark debugger-active-key #t
    (call-with-semaphore (host-lock host) thunk)))

(module+ main
  (require json racket/cmdline)
  (define file (command-line #:args (file) (path->complete-path file)))
  (define attachment (start-attach #:thread-name "Sample program"))
  (define-values (port token) (attachment-listen! attachment))
  (write-json (hasheq 'port port 'token token)) (newline) (flush-output)
  (unless (sync/timeout 15 (attachment-ready-evt attachment))
    (close-attachment! attachment) (error 'host "The debugger did not configure its session."))
  (define sample (make-host attachment #:namespace (make-base-namespace)))
  (host-load! sample file)
  (define loaded (sync (host-results sample)))
  (when (host-failure? loaded) (raise (host-failure-value loaded)))
  (host-submit! sample
    (lambda () (call-with-attached-code attachment (hash-ref (host-procedures sample) 'run) #:step-in? #t)))
  (define result (sync (host-results sample)))
  (close-attachment! attachment)
  (when (host-failure? result) (raise (host-failure-value result)))
  (displayln result))
