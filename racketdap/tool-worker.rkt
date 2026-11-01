#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require json racket/list "process-group.rkt")
(provide run-tool-worker)

;; The supervisor alone reads the editor's input lease. Readers and macros run
;; in an owned process group, released on completion, cancellation or host exit.
(define (run-tool-worker self run)
  (define (worker)
    (define request (read-json))
    (join-process-group! (hash-ref request 'processGroup #f))
    (run request))
  (define (supervise)
    (define input (read-line (current-input-port) 'any))
    (unless (eof-object? input)
      (define executable (or (find-executable-path (find-system-path 'exec-file))
                             (error 'tool "Cannot resolve the running Racket executable.")))
      (define-values (owner group) (start-process-group executable))
      (define child #f)
      (dynamic-wind
        void
        (lambda ()
          (define-values (process output in error)
            (parameterize ([current-subprocess-keep-file-descriptors
                            (if (eq? (system-type 'os) 'windows) 'inherited '())])
              (apply subprocess (current-output-port) #f (current-error-port) group executable
                     (append (append-map (lambda (p) (list "-S" (path->string p)))
                                         (current-library-collection-paths))
                             (list (path->string self) "--worker")))))
          (set! child process)
          (write-json (hash-set (string->jsexpr input) 'processGroup (process-group-name owner)) in)
          (newline in)
          (close-output-port in)
          (define lease-ended
            (thread (lambda () (let loop () (unless (eof-object? (read-byte)) (loop))))))
          (sync process lease-ended))
        (lambda ()
          (when (and child (eq? (system-type 'os) 'windows)) (subprocess-kill child #t))
          (stop-process-group! owner)
          (when child (subprocess-wait child))))
      (exit (if child (let ([status (subprocess-status child)]) (if (integer? status) status 1)) 1))))
  (with-handlers ([exn:fail? (lambda (error) (eprintf "~a\n" (exn-message error)) (exit 1))])
    (if (equal? (vector->list (current-command-line-arguments)) '("--worker"))
        (begin (worker) (exit 0))
        (supervise))))
