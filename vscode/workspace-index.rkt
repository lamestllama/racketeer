#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require json
         racket/match
         racket/port
         racket-langserver/lsp/msg-io
         racket-langserver/lsp/responses
         "workspace-analysis.rkt")

;; A frame is written in several steps, and a full pipe can suspend any of them.
;; Results and status reports come from different threads, so each frame waits
;; for the one before it.
(define (make-reply out)
  (define writing (make-semaphore 1))
  (lambda (message)
    (call-with-semaphore writing (lambda () (display-message/flush message out)))))

;; LSP 3.17 RequestFailed: a valid request that could not be answered.
(define request-failed -32803)

;; This adapter owns framing, request identifiers, cancellation subscriptions,
;; and the connection lifetime. The analysis engine has no wire-protocol state.
(define (serve)
  (define protocol-out (current-output-port))
  (define reply (make-reply protocol-out))
  (define engine
    (make-workspace-analysis
      #:on-status (lambda (status)
                    (reply (hasheq 'jsonrpc "2.0" 'method "status" 'params status)))))
  (define pending (make-hash))
  (thread watch-analysis-timer)
  (define (response id operation result)
    (match result
      [(AnalysisResult revision value)
       (success-response id (if (eq? operation 'references) value
                                (hasheq 'revision revision 'result value)))]
      [(AnalysisFailure reason message)
       (error-response id (case reason
                            [(cancelled closed) -32800]
                            [(changed) -32801]
                            [else request-failed]) message)]))
  (dynamic-wind
    void
    (lambda ()
      (for ([message (in-port read-message)])
        (define id (and (hash? message) (hash-ref message 'id #f)))
        (with-handlers ([exn:fail? (lambda (e)
                                     (if id (reply (error-response id request-failed (exn-message e)))
                                         (eprintf "Index message failed: ~a\n" (exn-message e))))])
          (parameterize ([current-output-port (open-output-nowhere)])
            (define params (if (hash? message) (hash-ref message 'params (hasheq)) (hasheq)))
            (match (if (eq? message 'parse-json-error) message (hash-ref message 'method))
              ['parse-json-error (reply (error-response (json-null) -32700 "Malformed JSON"))]
              [(or "initialize" "update")
               (workspace-analysis-update! engine params)
               (when id (reply (success-response id (hasheq))))]
              [(and method (or "references" "prepareRename" "rename"))
               (define operation (if (equal? method "prepareRename") 'prepare-rename (string->symbol method)))
               (define cancel (make-semaphore))
               (hash-set! pending id cancel)
               (thread
                 (lambda ()
                   (dynamic-wind
                     void
                     (lambda ()
                       (reply (with-handlers ([exn:fail? (lambda (e) (error-response id request-failed (exn-message e)))])
                                (response id operation
                                          (workspace-analysis-query engine operation params (semaphore-peek-evt cancel))))))
                     (lambda () (hash-remove! pending id)))))]
              ["$/cancelRequest"
               (define cancel (hash-ref pending (hash-ref params 'id) #f))
               (when cancel (semaphore-post cancel))]
              [_ (when id (reply (error-response id -32601 "Unknown index method")))])))))
    ;; The client has gone once its input ends. Reap the workers if that is
    ;; quick, then exit even if one is wedged: the owning supervisor ends
    ;; anything left in the process tree.
    (lambda () (sync/timeout 5 (thread (lambda () (workspace-analysis-close! engine)))))))

(provide make-reply)

(module+ main (serve) (exit 0))
