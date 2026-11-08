#lang racket/base

(require rackunit racket/runtime-path)
(define-runtime-path environment "../../vscode/racket-environment.rkt")
(define-runtime-path index "../../vscode/workspace-index.rkt")
(dynamic-require environment #f)
(define make-reply (dynamic-require index 'make-reply))
(define read-message (dynamic-require 'racket-langserver/lsp/msg-io 'read-message))

(define writers 8)
(define replies 20)
(define (message writer n)
  (hasheq 'writer writer 'n n 'text (make-string 300 #\x)))
(define (sorted messages)
  (sort messages < #:key (lambda (m) (+ (* replies (hash-ref m 'writer)) (hash-ref m 'n)))))

;; Takes a few bytes at a time and lets other threads run after each, as a pipe
;; that a client is slow to read suspends its writer partway through a frame.
(define (make-slow-port sink)
  (make-output-port 'slow always-evt
    (lambda (bytes start end non-block? breakable?)
      (define taken (min 8 (- end start)))
      (write-bytes bytes sink start (+ start taken))
      (unless non-block? (sleep 0))
      taken)
    void))

(module+ test
  (test-case "concurrent replies reach the client as whole messages"
    (define sink (open-output-bytes))
    (define reply (make-reply (make-slow-port sink)))
    (for-each thread-wait
      (for/list ([writer (in-range writers)])
        (thread (lambda () (for ([n (in-range replies)]) (reply (message writer n)))))))
    (define received
      (for/list ([m (in-port read-message (open-input-bytes (get-output-bytes sink)))]) m))
    (check-equal? (sorted (filter hash? received))
                  (for*/list ([writer (in-range writers)] [n (in-range replies)]) (message writer n)))
    (check-equal? (length received) (* writers replies))))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
