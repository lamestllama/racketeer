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

;; LSP 3.17 error codes.
(define parse-error -32700)
(define invalid-request -32600)
(define method-not-found -32601)
(define server-not-initialized -32002)
;; A valid request that could not be answered.
(define request-failed -32803)
(define content-modified -32801)
(define request-cancelled -32800)

(define operations
  (hash "racketeer/references" 'references
        "racketeer/sourceReferences" 'references
        "racketeer/prepareRename" 'prepare-rename
        "racketeer/rename" 'rename))

(define initialize-result
  (hasheq 'capabilities
          (hasheq 'positionEncoding "utf-16"
                  'experimental (hasheq 'racketeer (hasheq 'version 1 'indexStatus #t 'sourceReferences #t)))
          'serverInfo (hasheq 'name "racketeer-workspace-index")))

;; Private messages are negotiated under this member, which a generic client
;; never sets. Such a client sees a standard server.
(define (racketeer-capability params key)
  (for/fold ([value (hash-ref params 'capabilities #f)]) ([member (list 'experimental 'racketeer key)])
    (and (hash? value) (hash-ref value member #f))))

;; This adapter owns framing, request identifiers, cancellation subscriptions,
;; and the connection lifetime. The analysis engine has no wire-protocol state.
;; Returns the exit code.
(define (serve)
  (define protocol-out (current-output-port))
  (define reply (make-reply protocol-out))
  (define report-status? #f)
  (define engine
    (make-workspace-analysis
      #:on-status (lambda (status)
                    (when report-status?
                      (reply (hasheq 'jsonrpc "2.0" 'method "racketeer/indexStatus" 'params status))))))
  (define pending (make-hash))
  ;; 'starting until `initialize`, 'serving until `shutdown`, then 'stopped.
  (define state 'starting)
  (thread watch-analysis-timer)
  (define (response id operation result)
    (match result
      [(AnalysisResult revision value)
       (success-response id (if (eq? operation 'references) value
                                (hasheq 'revision revision 'result value)))]
      [(AnalysisFailure reason message)
       (error-response id (case reason
                            [(cancelled) request-cancelled]
                            [(closed) invalid-request]
                            [(changed) content-modified]
                            [else request-failed]) message)]))
  ;; Reap the workers if that is quick, then go on even if one is wedged: the
  ;; owning supervisor ends anything left in the process tree.
  (define (close-engine!)
    (sync/timeout 5 (thread (lambda () (workspace-analysis-close! engine)))))
  (define (serve-message id method params)
    (match method
      ["initialized" (void)]
      ["racketeer/update" (workspace-analysis-update! engine params)]
      ["shutdown"
       (set! state 'stopped)
       (close-engine!)
       (reply (success-response id (json-null)))]
      ["$/cancelRequest"
       (define cancel (hash-ref pending (hash-ref params 'id) #f))
       (when cancel (semaphore-post cancel))]
      [(app (lambda (name) (hash-ref operations name #f)) (? symbol? operation))
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
      ["initialize" (reply (error-response id invalid-request "The index server is already initialized"))]
      [_ (when id (reply (error-response id method-not-found "Unknown index method")))]))
  (let/ec finish
    (dynamic-wind
      void
      (lambda ()
        (for ([message (in-port read-message)])
          (define id (and (hash? message) (hash-ref message 'id #f)))
          (with-handlers ([exn:fail? (lambda (e)
                                       (if id (reply (error-response id request-failed (exn-message e)))
                                           (eprintf "Index message failed: ~a\n" (exn-message e))))])
            (parameterize ([current-output-port (open-output-nowhere)])
              (define method (if (eq? message 'parse-json-error) message (hash-ref message 'method #f)))
              (define params (if (hash? message) (hash-ref message 'params (hasheq)) (hasheq)))
              (match* (method state)
                [('parse-json-error _) (reply (error-response (json-null) parse-error "Malformed JSON"))]
                [("exit" _) (finish (if (eq? state 'stopped) 0 1))]
                [("initialize" 'starting)
                 (set! report-status? (eq? #t (racketeer-capability params 'indexStatus)))
                 (set! state 'serving)
                 (reply (success-response id initialize-result))]
                [(_ 'starting)
                 (when id (reply (error-response id server-not-initialized "The index server is not initialized")))]
                [(_ 'stopped)
                 (when id (reply (error-response id invalid-request "The index server has shut down")))]
                [(_ 'serving) (serve-message id method params)]))))
        ;; The client has gone once its input ends.
        0)
      close-engine!)))

(provide make-reply)

(module+ main (exit (serve)))
