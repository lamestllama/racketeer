#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require "../process-group.rkt")

;; Runs `racket ARGUMENT ...` and owns its whole process tree: a new process
;; group on POSIX, a job object on Windows. Builds and Windows extension servers
;; run this way. Every descendant ends when the command ends, when this
;; supervisor is terminated, or when it is killed, including processes that
;; ignore breaks or outlive their parent. Output is inherited; input is shared
;; unless --supervise-input gives this supervisor the editor's EOF lease.
(module+ main
  (define windows? (eq? (system-type 'os) 'windows))
  ;; Extension servers need an independent EOF reader: their main thread or a
  ;; worker may be stuck in native code when the editor is killed. The writer
  ;; runs separately so a full child pipe cannot block the ownership lease.
  (define arguments (vector->list (current-command-line-arguments)))
  (define supervise-input? (and (pair? arguments) (equal? (car arguments) "--supervise-input")))
  (define input-ended (make-semaphore))
  (define executable (or (find-executable-path (find-system-path 'exec-file))
                         (error 'owned-command "Cannot resolve the running Racket executable.")))
  (define-values (owner group) (start-process-group executable))
  ;; A Windows job also holds every later child of a member, and closes with
  ;; this process's handle when it exits for any reason.
  (join-process-group! (process-group-name owner))
  (define (port-or-pipe port) (and (file-stream-port? port) port))
  (define child #f)
  (define status
    (with-handlers ([exn:break? (lambda (_) 1)])
      (dynamic-wind
        void
        (lambda ()
          (define-values (process output input error)
            (parameterize ([current-subprocess-keep-file-descriptors (if windows? 'inherited '())])
              (apply subprocess (current-output-port) (and (not supervise-input?) (port-or-pipe (current-input-port))) (current-error-port)
                     group executable (if supervise-input? (cdr arguments) arguments))))
          (set! child process)
          (cond
            [supervise-input?
             (define-values (pending queued) (make-pipe))
             (define (copy from to)
               (define bytes (make-bytes 4096))
               (let loop ()
                 (define count (read-bytes-avail! bytes from))
                 (unless (eof-object? count)
                   (write-bytes bytes to 0 count) (flush-output to) (loop))))
             (thread (lambda ()
                       (dynamic-wind void
                         (lambda () (copy (current-input-port) queued))
                         (lambda () (semaphore-post input-ended)))))
             (thread (lambda () (copy pending input)))]
            [input (close-output-port input)])
          (sync process input-ended)
          (let ([status (subprocess-status process)]) (if (integer? status) status 1)))
        (lambda ()
          (when (and child (eq? 'running (subprocess-status child))) (subprocess-kill child #t))
          (unless windows? (stop-process-group! owner))))))
  (exit status))
