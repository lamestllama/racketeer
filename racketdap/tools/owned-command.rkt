#lang racket/base

(require "../process-group.rkt")

;; Runs `racket ARGUMENT ...` and owns its whole process tree: a new process
;; group on POSIX, a job object on Windows. Builds and the extension's servers
;; run this way. Every descendant ends when the command ends, when this
;; supervisor is terminated, or when it is killed, including processes that
;; ignore breaks or outlive their parent. The command shares this process's
;; standard ports, so a server still sees its client close its input.
(module+ main
  (define windows? (eq? (system-type 'os) 'windows))
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
              (apply subprocess (current-output-port) (port-or-pipe (current-input-port)) (current-error-port)
                     group executable (vector->list (current-command-line-arguments)))))
          (set! child process)
          (when input (close-output-port input))
          (subprocess-wait process)
          (let ([status (subprocess-status process)]) (if (integer? status) status 1)))
        (lambda ()
          (when (and child (eq? 'running (subprocess-status child))) (subprocess-kill child #t))
          (unless windows? (stop-process-group! owner))))))
  (exit status))
