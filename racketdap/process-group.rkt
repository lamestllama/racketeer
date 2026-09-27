#lang racket/base

(require racket/runtime-path)
(provide start-process-group stop-process-group!)

(define-runtime-path anchor-path "process-group.rkt")
(struct process-group (leader lease output error) #:transparent)

;; Racket cannot signal a group after observing its leader's exit: the numeric
;; group id could have been reused. Keep a separate, idle leader alive while the
;; adapter observes the worker. The lease also makes adapter EOF/crash release
;; the group without relying on a saved pid.
(define (start-process-group [executable (find-system-path 'exec-file)])
  (cond
    [(eq? (system-type 'os) 'windows) (values #f 'new)]
    [else
     (define-values (leader output lease error)
       (parameterize ([current-subprocess-keep-file-descriptors '()])
         (subprocess #f #f #f 'new executable
                     (path->string anchor-path))))
     (values (process-group leader lease output error) leader)]))

(define (stop-process-group! group)
  (when group
    ;; Do not wait for or query the anchor before signalling its owned group.
    (subprocess-kill (process-group-leader group) #t)
    (close-output-port (process-group-lease group))
    (close-input-port (process-group-output group))
    (close-input-port (process-group-error group))
    (thread (lambda () (subprocess-wait (process-group-leader group))))))

(module+ main
  (require ffi/unsafe)
  (define libc (ffi-lib #f))
  (define getpid (get-ffi-obj "getpid" libc (_fun -> _int)))
  (define getpgrp (get-ffi-obj "getpgrp" libc (_fun -> _int)))
  (define kill-group (get-ffi-obj "kill" libc (_fun _int _int -> _int)))
  (unless (= (getpid) (getpgrp)) (error 'process-group "Expected an owned process group"))
  (let loop () (unless (eof-object? (read-byte)) (loop)))
  ;; Only the live group leader signals its own group; pid reuse is impossible.
  (kill-group 0 9))
