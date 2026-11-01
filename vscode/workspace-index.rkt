#lang racket/base

(require racket/match
         racket/port
         racket-langserver/lsp/msg-io
         racket-langserver/lsp/responses
         "workspace-analysis.rkt")

;; This adapter owns framing, request identifiers, cancellation subscriptions,
;; and the connection lifetime. The analysis engine has no wire-protocol state.
(define (serve)
  (define protocol-out (current-output-port))
  (define (reply message) (display-message/flush message protocol-out))
  (define engine
    (make-workspace-analysis
      #:on-status (lambda (status)
                    (reply (hasheq 'jsonrpc "2.0" 'method "status" 'params status)))))
  (define pending (make-hash))
  (define (response id operation result)
    (match result
      [(AnalysisResult revision value)
       (success-response id (if (eq? operation 'references) value
                                (hasheq 'revision revision 'result value)))]
      [(AnalysisFailure reason message)
       (error-response id (case reason
                            [(cancelled closed) -32800]
                            [(changed) -32801]
                            [(unavailable) -32803]
                            [else -32603]) message)]))
  (dynamic-wind
    void
    (lambda ()
      (for ([message (in-port read-message)])
        (define id (and (hash? message) (hash-ref message 'id #f)))
        (with-handlers ([exn:fail? (lambda (e)
                                     (if id (reply (error-response id -32603 (exn-message e)))
                                         (eprintf "Index message failed: ~a\n" (exn-message e))))])
          (parameterize ([current-output-port (open-output-nowhere)])
            (define params (hash-ref message 'params (hasheq)))
            (match (hash-ref message 'method)
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
                       (reply (with-handlers ([exn:fail? (lambda (e) (error-response id -32603 (exn-message e)))])
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

(module+ main (serve) (exit 0))
