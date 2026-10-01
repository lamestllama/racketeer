#lang racket/base

(require racket/runtime-path)
(provide start-process-group stop-process-group! process-group-name join-process-group!)

(define-runtime-path anchor-path "process-group.rkt")
(struct process-group (leader lease output error) #:transparent)

;; Racket cannot signal a group after observing its leader's exit: the numeric
;; group id could have been reused. Keep a separate, idle leader alive while the
;; adapter observes the worker. The lease also makes adapter EOF/crash release
;; the group without relying on a saved pid.
(define (start-process-group [executable (find-system-path 'exec-file)])
  (cond
    [(eq? (system-type 'os) 'windows)
     (values ((dynamic-require windows-job 'create-job)) 'new)]
    [else
     (define command (or (find-executable-path executable)
                         (error 'process-group "Cannot resolve the Racket executable: ~a" executable)))
     (define-values (leader output lease stderr)
       (parameterize ([current-subprocess-keep-file-descriptors '()])
         (subprocess #f #f #f 'new command
                     (path->string anchor-path))))
     (values (process-group leader lease output stderr) leader)]))

(define (process-group-name group)
  (and (eq? (system-type 'os) 'windows)
       ((dynamic-require windows-job 'job-name) group)))

(define (join-process-group! name)
  (when (eq? (system-type 'os) 'windows)
    (void ((dynamic-require windows-job 'join-job!) name))))

(define (stop-process-group! group)
  (cond
    [(not group) (void)]
    [(eq? (system-type 'os) 'windows)
     ((dynamic-require windows-job 'close-job!) group)]
    [else
     ;; Do not wait for or query the anchor before signalling its owned group.
     (subprocess-kill (process-group-leader group) #t)
     (close-output-port (process-group-lease group))
     (close-input-port (process-group-output group))
     (close-input-port (process-group-error group))
     (thread (lambda () (subprocess-wait (process-group-leader group))))]))

(module windows-job racket/base
  (require ffi/unsafe ffi/unsafe/define ffi/winapi racket/random file/sha1)
  (provide create-job job-name join-job! close-job!)

  ;; The adapter retains the only long-lived, noninheritable job handle.
  ;; Workers join before acknowledging startup or evaluating project code.
  ;; Closing the handle, including on adapter death, kills all descendants.
  ;; https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
  (struct job (name [handle #:mutable]))
  (define-ffi-definer define-kernel32 (ffi-lib "kernel32"))
  (define-kernel32 CreateJobObjectW
    (_fun #:abi winapi #:save-errno 'windows _pointer _string/utf-16 -> _pointer))
  (define-kernel32 OpenJobObjectW
    (_fun #:abi winapi #:save-errno 'windows _uint32 _bool _string/utf-16 -> _pointer))
  (define-kernel32 SetInformationJobObject
    (_fun #:abi winapi #:save-errno 'windows _pointer _int _pointer _uint32 -> _bool))
  (define-kernel32 AssignProcessToJobObject
    (_fun #:abi winapi #:save-errno 'windows _pointer _pointer -> _bool))
  (define-kernel32 GetCurrentProcess (_fun #:abi winapi -> _pointer))
  (define-kernel32 CloseHandle
    (_fun #:abi winapi #:save-errno 'windows _pointer -> _bool))

  (define-cstruct _basic-limits
    ([process-time _int64] [job-time _int64] [flags _uint32]
     [minimum-working-set _size] [maximum-working-set _size]
     [active-process-limit _uint32] [affinity _uintptr]
     [priority-class _uint32] [scheduling-class _uint32]))
  (define-cstruct _extended-limits
    ([basic _basic-limits] [io-counters (_array _uint64 6)]
     [process-memory-limit _size] [job-memory-limit _size]
     [peak-process-memory _size] [peak-job-memory _size]))
  (define JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE #x2000)
  (define JobObjectExtendedLimitInformation 9)
  (define JOB_OBJECT_ASSIGN_PROCESS #x0001)
  (define ERROR_ALREADY_EXISTS 183)

  (define (checked who result)
    (unless result (error who "Windows error ~a" (saved-errno)))
    result)

  (define (create-job)
    (define name (string-append "Local\\Racketeer-" (bytes->hex-string (crypto-random-bytes 16))))
    (define handle (checked 'CreateJobObjectW (CreateJobObjectW #f name)))
    (with-handlers ([exn:fail? (lambda (e) (CloseHandle handle) (raise e))])
      ;; Never adopt an existing named job, even on an unexpected collision.
      (when (= (saved-errno) ERROR_ALREADY_EXISTS) (error 'CreateJobObjectW "Job already exists"))
      (define limits (ptr-ref (malloc _extended-limits 'zeroed-atomic) _extended-limits))
      (set-basic-limits-flags! (extended-limits-basic limits) JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
      (checked 'SetInformationJobObject
               (SetInformationJobObject handle JobObjectExtendedLimitInformation
                                        limits (ctype-sizeof _extended-limits)))
      (job name handle)))

  (define (join-job! name)
    (define handle (checked 'OpenJobObjectW (OpenJobObjectW JOB_OBJECT_ASSIGN_PROCESS #f name)))
    (dynamic-wind
      void
      (lambda () (checked 'AssignProcessToJobObject
                           (AssignProcessToJobObject handle (GetCurrentProcess))))
      (lambda () (checked 'CloseHandle (CloseHandle handle)))))

  (define (close-job! group)
    (define handle (job-handle group))
    (when handle
      (set-job-handle! group #f)
      (checked 'CloseHandle (CloseHandle handle)))))

(define-runtime-module-path windows-job (submod "." windows-job))

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
