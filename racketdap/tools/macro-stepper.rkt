#lang racket/base

(require json racket/runtime-path "macro-source.rkt" "../process-group.rkt")
(provide open-macro-stepper wait-for-macro-stepper)

(define-runtime-path self "macro-stepper.rkt")

;; The expansion engine and GUI are the upstream macro-debugger package.
;; Public API: https://docs.racket-lang.org/macro-debugger/index.html
(define (open-macro-stepper request)
  (define expand/step (dynamic-require 'macro-debugger/stepper 'expand/step))
  (call-with-macro-source request expand/step))

(define (wait-for-macro-stepper)
  (define windows (dynamic-require 'racket/gui/base 'get-top-level-windows))
  (define sleep/yield (dynamic-require 'racket/gui/base 'sleep/yield))
  ;; No timer or callback is kept alive after the last owned window closes.
  (let loop ()
    (unless (null? (windows))
      (sleep/yield 0.1)
      (loop))))

(define (run-worker)
  (define request (read-json))
  (open-macro-stepper request)
  (displayln "Racket macro stepper opened. Close its windows or its editor terminal to finish.")
  (flush-output)
  (wait-for-macro-stepper))

(define (supervise)
  ;; Only this supervisor reads the editor's lifetime lease. A stalled reader
  ;; or transformer in the worker cannot prevent terminal/window cleanup.
  (define input (read-line (current-input-port) 'any))
  (unless (eof-object? input)
    (define executable (or (find-executable-path (find-system-path 'exec-file))
                           (error 'macro-stepper "Cannot resolve the running Racket executable.")))
    (define-values (owner group) (start-process-group executable))
    (define child #f)
    (dynamic-wind
      void
      (lambda ()
        (define-values (process output in error)
          (parameterize ([current-subprocess-keep-file-descriptors
                          (if (eq? (system-type 'os) 'windows) 'inherited '())])
            (subprocess (current-output-port) #f (current-error-port) group
                        executable (path->string self) "--worker")))
        (set! child process)
        (displayln input in)
        (close-output-port in)
        (define lease-ended
          (thread (lambda () (let loop () (unless (eof-object? (read-byte)) (loop))))))
        (sync process lease-ended))
      (lambda ()
        (when (and child (not owner)) (subprocess-kill child #t))
        (stop-process-group! owner)
        (when child (subprocess-wait child))))
    (exit (if child (let ([status (subprocess-status child)]) (if (integer? status) status 1)) 1))))

(module+ main
  (with-handlers ([exn:fail? (lambda (error)
                             (eprintf "Racket macro stepper: ~a\n" (exn-message error))
                             (exit 1))])
    (if (equal? (vector->list (current-command-line-arguments)) '("--worker"))
        (begin (run-worker) (exit 0))
        (supervise))))
