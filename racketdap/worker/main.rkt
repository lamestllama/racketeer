#lang racket/base

(require racket/tcp
         "../protocol.rkt" "../process-group.rkt" "load.rkt" "session.rkt")

(define bootstrap (read-message (current-input-port)))
(join-process-group! (hash-ref bootstrap 'processGroup #f))
(define-values (control-in control-out)
  (tcp-connect "127.0.0.1" (hash-ref bootstrap 'port)))
(write-message (hasheq 'type "hello" 'version 1 'token (hash-ref bootstrap 'token)) control-out)
(serve-session control-in control-out
               (hash-ref bootstrap 'config) (hash-ref bootstrap 'client) run-module)
