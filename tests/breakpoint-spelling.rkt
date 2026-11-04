#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; The program's thread records a file as it loads, while requests arrive on another. A
;; breakpoint on that file in another spelling, set at that moment, must not be lost.
(require rackunit racket/async-channel racket/file racket/path racket/runtime-path
         "../racketdap/protocol.rkt"
         "../racketdap/worker/load.rkt"
         "../racketdap/worker/session.rkt")

;; A copy of the debugger whose request handling waits at one chosen moment, which no
;; timing from outside can hit reliably: after a request has chosen a source for its
;; spelling and before it links the two. Returns the copy's folder.
(define-runtime-path debugger-sources "../racketdap")
(define (debugger-with-pause directory)
  (define copy (build-path directory "racketdap"))
  (for ([file (in-directory debugger-sources (lambda (dir) (not (equal? (file-name-from-path dir) (string->path "compiled")))))]
        #:when (file-exists? file))
    (define target (build-path copy (find-relative-path (simple-form-path debugger-sources) (simple-form-path file))))
    (make-parent-directory* target)
    (copy-file file target))
  (define session (build-path copy "worker/session.rkt"))
  (define (insert text anchor added)
    (unless (regexp-match? anchor text) (error 'debugger-with-pause "session.rkt no longer has: ~a" anchor))
    (regexp-replace anchor text added))
  (display-to-file
   (insert (insert (file->string session) #rx"[(]provide serve-session "
                   "(define request-pause (make-parameter void))\n(provide request-pause serve-session ")
           #rx"[(]define path [(]source-path [(]hash-ref a 'source[)][)][)]\n *[(]unless"
           "(define path (source-path (hash-ref a 'source)))\n((request-pause))\n(unless")
   session #:exists 'truncate)
  copy)

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
    (display-to-file long-text source)
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

(module+ test
  ;; A request that has chosen another spelling's source while its own spelling loads must
  ;; not link the two afterwards. It would stop in the module the spelling did not load.
  (unless (eq? (system-type) 'windows) ; Making a link can take a privilege there.
    (test-case "a breakpoint request crossing its own spelling's load stays on that spelling"
      (define directory (simple-form-path (make-temporary-file "breakpoint-crossing-~a" 'directory)))
      (define copy (debugger-with-pause directory))
      (define (from-copy file name) (dynamic-require (build-path copy file) name))
      (define serve (from-copy "worker/session.rkt" 'serve-session))
      (define request-pause (from-copy "worker/session.rkt" 'request-pause))
      (define loader (from-copy "worker/load.rkt" 'make-debug-loader))
      ;; Apart from the copy, whose files would otherwise count as the program's sources.
      (define program (build-path directory "program"))
      (make-directory program)
      (define a (build-path program "a.rkt"))
      (define b (build-path program "b.rkt"))
      (display-to-file "#lang racket/base\n(provide f)\n(define (f)\n  (add1 1))\n" a)
      (make-file-or-directory-link a b)
      (define a-loaded (make-semaphore))
      (define load-b (make-semaphore))
      (define b-loaded (make-semaphore))
      (define call (make-semaphore))
      (define run-program
        (make-keyword-procedure
         (lambda (keywords arguments path)
           (define options (for/hasheq ([k (in-list keywords)] [v (in-list arguments)]) (values k v)))
           (define namespace (make-base-namespace))
           (define-values (compiled plain _select _finish)
             (loader namespace a #:sources (list b)
                     #:on-source-snapshot (hash-ref options '#:on-source-snapshot)
                     #:on-sites (hash-ref options '#:on-sites)
                     #:on-event (hash-ref options '#:on-event)
                     #:on-thread (hash-ref options '#:on-thread)
                     #:gate (hash-ref options '#:gate)))
           (parameterize ([current-namespace namespace]
                          [current-load/use-compiled compiled]
                          [current-load plain])
             (define in-a (dynamic-require a 'f))
             (semaphore-post a-loaded)
             (semaphore-wait load-b)
             (define in-b (dynamic-require b 'f))
             (semaphore-post b-loaded)
             (semaphore-wait call)
             (in-a)
             (in-b)))))
      (define owner (make-custodian))
      (dynamic-wind
        void
        (lambda ()
          (parameterize ([current-custodian owner]
                         ;; Lets the load begin, and gives it time to finish if nothing holds it back.
                         [request-pause (lambda ()
                                          (semaphore-post load-b)
                                          (sync/timeout 1 (semaphore-peek-evt b-loaded)))])
            (define-values (input requests) (make-pipe))
            (define-values (messages output) (make-pipe))
            (define incoming (make-async-channel))
            (thread (lambda () (let loop () (async-channel-put incoming (read-message messages)) (loop))))
            (thread (lambda ()
                      (serve input output
                             (hasheq 'program (path->string a) 'cwd (path->string program) 'debugCache #f)
                             (hasheq) run-program)))
            (define (wait-for found?)
              (let loop ()
                (define message (or (sync/timeout 30 incoming) (error "no message from the session")))
                (or (found? message) (loop))))
            (write-message (hasheq 'seq 1 'command "configurationDone" 'arguments (hasheq)) requests)
            (check-not-false (sync/timeout 30 a-loaded))
            (write-message
             (hasheq 'seq 2 'command "setBreakpoints"
                     'arguments (hasheq 'source (hasheq 'path (path->string b))
                                        'breakpoints (list (hasheq 'line 4))))
             requests)
            (check-not-false (sync/timeout 30 (semaphore-peek-evt b-loaded)))
            (semaphore-post call)
            (define stop (wait-for (lambda (m) (and (equal? (hash-ref m 'event #f) "stopped") m))))
            (write-message
             (hasheq 'seq 3 'command "stackTrace"
                     'arguments (hasheq 'threadId (hash-ref (hash-ref stop 'body) 'threadId)))
             requests)
            (define trace (wait-for (lambda (m) (and (equal? (hash-ref m 'request_seq #f) 3) m))))
            (check-equal? (hash-ref (hash-ref (car (hash-ref (hash-ref trace 'body) 'stackFrames)) 'source) 'path)
                          (path->string b))))
        (lambda ()
          (custodian-shutdown-all owner)
          (delete-directory/files directory))))))
