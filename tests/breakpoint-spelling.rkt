#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; The program's thread records a file as it loads, while requests arrive on another. A
;; breakpoint on that file in another spelling, set at that moment, must not be lost.
(require rackunit racket/async-channel racket/file
         "../racketdap/protocol.rkt"
         "../racketdap/worker/load.rkt"
         "../racketdap/worker/session.rkt")

(define text "#lang racket/base\n(define (run)\n  (add1 1))\n(run)\n")
(define breakpoint-line 3)
;; Recording a source takes time in proportion to its text, which holds the moment open.
(define long-text (string-append text ";" (make-string 8000000 #\x) "\n"))

(module+ test
  (test-case "a breakpoint set while its file is being recorded, in another spelling, stops"
    (define directory (make-temporary-file "breakpoint-spelling-~a" 'directory))
    (define real (build-path directory "real"))
    ;; Making a link can take a privilege on Windows, whose file system ignores case.
    (define windows? (eq? (system-type) 'windows))
    (define link (build-path directory (if windows? "REAL" "link")))
    (make-directory real)
    (unless windows? (make-file-or-directory-link real link))
    (define source (build-path real "main.rkt"))
    (display-to-file text source)
    (define recording (make-semaphore))
    (define run-program
      (make-keyword-procedure
       (lambda (keywords arguments path)
         (define options (for/hasheq ([k (in-list keywords)] [v (in-list arguments)]) (values k v)))
         (define namespace (make-base-namespace))
         (define-values (compiled plain _select _finish)
           (make-debug-loader
            namespace source
            #:on-sites (hash-ref options '#:on-sites)
            #:on-event (hash-ref options '#:on-event)
            #:on-thread (hash-ref options '#:on-thread)
            #:gate (hash-ref options '#:gate)
            #:on-source-snapshot
            (lambda (path _text)
              (semaphore-post recording)
              ((hash-ref options '#:on-source-snapshot) path long-text))))
         (parameterize ([current-namespace namespace]
                        [current-load/use-compiled compiled]
                        [current-load plain])
           (dynamic-require source #f)))))
    (define owner (make-custodian))
    (dynamic-wind
      void
      (lambda ()
        (parameterize ([current-custodian owner])
          (define-values (input requests) (make-pipe))
          (define-values (messages output) (make-pipe))
          (define incoming (make-async-channel))
          (thread (lambda () (let loop () (async-channel-put incoming (read-message messages)) (loop))))
          (thread (lambda ()
                    (serve-session input output
                                   (hasheq 'program (path->string source) 'cwd (path->string real)
                                           'debugCache #f)
                                   (hasheq) run-program)))
          (write-message (hasheq 'seq 1 'command "configurationDone" 'arguments (hasheq)) requests)
          (check-not-false (sync/timeout 30 recording))
          (write-message
           (hasheq 'seq 2 'command "setBreakpoints"
                   'arguments (hasheq 'source (hasheq 'path (path->string (build-path link "main.rkt")))
                                      'breakpoints (list (hasheq 'line breakpoint-line))))
           requests)
          (define ending
            (let loop ()
              (define message (or (sync/timeout 60 incoming) (error "no message from the session")))
              (cond
                [(equal? (hash-ref message 'event #f) "stopped") 'stopped]
                [(equal? (hash-ref message 'type #f) "workerExit") 'finished]
                [else (loop)])))
          (check-equal? ending 'stopped)))
      (lambda ()
        (custodian-shutdown-all owner)
        (delete-directory/files directory)))))
