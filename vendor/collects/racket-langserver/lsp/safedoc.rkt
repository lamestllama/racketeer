#lang racket/base

;; This module provides `SafeDoc`, a thread-safe document representation for the
;; LSP server. It wraps a `Doc` object and uses a read-write lock to allow for
;; safe concurrent access from multiple threads, making it suitable for being
;; managed by the language server.

(require "../common/rwlock.rkt"
         "../doclib/doc.rkt"
         "../doclib/check-syntax.rkt"
         "../doclib/lexer.rkt"
         "../doclib/external/resyntax.rkt"
         "../workspace/current.rkt"
         "../workspace/state.rkt"
         "resyntax-place.rkt"
         "scheduler.rkt"
         racket/set
         "../common/json-util.rkt"
         "../common/path-util.rkt"
         "../common/source-snapshot.rkt"
         "../common/settings.rkt"
         racket/class
         racket/contract)

;; Tracks a check-syntax run for a specific document version.
;; state: 'running, 'succeeded, or 'failed
;; version: document version the run was started on
(struct/contract Check-Syntax-Status
  ([state (or/c 'running 'succeeded 'failed)]
   [version exact-nonnegative-integer?])
  #:transparent)

;; SafeDoc eliminators:
;;   with-read-safedoc / with-write-safedoc — get safe-doc, access any field
;;   with-read-doc / with-write-doc — get doc only (legacy)
;; Exported field accessors: SafeDoc-doc, SafeDoc-check-syntax-status.
;; Access fields only inside an eliminator that acquired the lock.
(struct SafeDoc
  (doc rwlock token check-syntax-status closed? analysis sources roots dependencies)
  #:mutable
  #:transparent)

(define (new-safedoc uri text version)
  (define doc (make-doc uri text version))
  ;; Token identifies this opened document instance in scheduler/query state.
  (define token (gensym 'doc-token))
  (scheduler-register-doc! token)
  (SafeDoc doc (make-rwlock) token #f #f #f (hash) '() #f))

(define (with-read-doc safe-doc proc)
  (call-with-read-lock
    (SafeDoc-rwlock safe-doc)
    (λ () (proc (SafeDoc-doc safe-doc)))))

(define (with-write-doc safe-doc proc)
  (call-with-write-lock
    (SafeDoc-rwlock safe-doc)
    (λ () (proc (SafeDoc-doc safe-doc)))))

(define (with-read-analysis safe-doc proc)
  (with-read-safedoc safe-doc
    (lambda (sd)
      (define doc (SafeDoc-doc sd))
      (call-with-source-snapshot (uri->path (Doc-uri doc)) (SafeDoc-sources sd)
        #:source? (lambda (file)
                    (for/or ([root (in-list (SafeDoc-roots sd))]) (directory-contains? root file)))
        (lambda () (proc doc))))))

(define (safedoc-depends-on? safe-doc path)
  (with-read-safedoc safe-doc
    (lambda (sd)
      (or (not (SafeDoc-dependencies sd))
          (safedoc-check-syntax-running? sd)
          (hash-has-key? (SafeDoc-dependencies sd) path)))))

(define (with-read-safedoc safe-doc proc)
  (call-with-read-lock
    (SafeDoc-rwlock safe-doc)
    (λ () (proc safe-doc))))

(define (with-write-safedoc safe-doc proc)
  (call-with-write-lock
    (SafeDoc-rwlock safe-doc)
    (λ () (proc safe-doc))))

;; Retirement and publication use the same lock, so work from a closed
;; document cannot restore diagnostics or workspace contributions.
(define (safedoc-close! safe-doc)
  (with-write-safedoc safe-doc
    (lambda (sd)
      (set-SafeDoc-closed?! sd #t))))

(define (with-current-safedoc safe-doc version proc)
  (with-write-safedoc safe-doc
    (lambda (sd)
      (and (not (SafeDoc-closed? sd))
           (equal? version (Doc-version (SafeDoc-doc sd)))
           (begin (proc sd) #t)))))

(define (safedoc-check-syntax-running? sd)
  (define doc (SafeDoc-doc sd))
  (define status (SafeDoc-check-syntax-status sd))
  (and (Check-Syntax-Status? status)
       (eq? 'running (Check-Syntax-Status-state status))
       (equal? (Check-Syntax-Status-version status) (Doc-version doc))))

;; TODO: add uri to each Diagnostic struct when make them, and remove uri here
;; Currently it uses the `uri` of the document that triggers
;; the check-syntax. But some diagnostics may come from other files.
;; In this case, it sends them with a wrong uri.
(define (send-diagnostics notify-client uri diag-lst)
  (notify-client "textDocument/publishDiagnostics"
                 (hasheq 'uri uri
                         'diagnostics (->jsexpr diag-lst))))

(define (send-doc-diagnostics notify-client doc)
  (send-diagnostics notify-client
                    (Doc-uri doc)
                    (doc-diagnostics doc)))

;; Success and failure share the same retirement and replacement guards.
(define (publish-analysis! safe-doc running-status state update)
  (define version (Check-Syntax-Status-version running-status))
  (define finished-status (Check-Syntax-Status state version))
  (with-current-safedoc safe-doc version
                        (lambda (sd)
                          (when (eq? running-status (SafeDoc-check-syntax-status sd))
                            (update sd)
                            (set-SafeDoc-check-syntax-status! sd finished-status))))
  ;; Query callbacks acquire document read locks. Check this run's identity
  ;; under the query semaphore, after releasing the document write lock.
  (clear-old-queries/check-syntax-finished
    (SafeDoc-token safe-doc)
    #:ready? (lambda ()
               (with-read-safedoc safe-doc
                 (lambda (sd)
                   (eq? finished-status (SafeDoc-check-syntax-status sd)))))))

;; The only place that actually runs check-syntax.
(define (safedoc-run-check-syntax! notify-client safe-doc
                                  #:sources [sources (hash)] #:roots [roots '()])
  (define-values (uri working-version text-buffer-copy token)
    (with-read-safedoc safe-doc
      (lambda (sd)
        (define doc (SafeDoc-doc sd))
        (values (Doc-uri doc)
                (Doc-version doc)
                (doc-copy-text-buffer doc)
                (SafeDoc-token sd)))))

  ;; Identity distinguishes reruns at the same document version.
  (define running-status (Check-Syntax-Status 'running working-version))
  (define dependencies (make-hash))
  (with-current-safedoc safe-doc working-version
                        (lambda (sd)
                          (doc-invalidate-analysis! (SafeDoc-doc sd))
                          (set-SafeDoc-analysis! sd running-status)
                          (set-SafeDoc-check-syntax-status! sd running-status)))

  (define (fail-analysis e)
    (publish-analysis! safe-doc running-status 'failed
                       (lambda (sd) (set-SafeDoc-dependencies! sd #f)))
    ((error-display-handler)
     (if (exn? e) (exn-message e) (format "check-syntax raised: ~e" e)) e))

  (define (resyntax-task)
    (define text (send text-buffer-copy get-text))
    (run-resyntax/in-place text uri))

  (define (publish-resyntax resyntax-results)
    (with-current-safedoc safe-doc working-version
                          (lambda (sd)
                            (when (eq? (SafeDoc-analysis sd) running-status)
                              (define doc (SafeDoc-doc sd))
                              (doc-update-resyntax-result! doc resyntax-results)
                              (send-doc-diagnostics notify-client doc)))))

  (define (check-syntax-task)
    (call-with-source-snapshot (uri->path uri) sources
      #:source? (lambda (file) (for/or ([root (in-list roots)]) (directory-contains? root file)))
      #:on-load (lambda (file) (hash-set! dependencies file #t))
      (lambda ()
        (define text (send text-buffer-copy get-text))
        (define lexer-state (build-lexer-state text uri))
        (define result (doc-expand uri text-buffer-copy lexer-state))
        (define trace (CSResult-trace result))
        ;; Derive contributions outside the document lock; publication only swaps
        ;; the accepted trace and facts into place.
        (define contribution
          (and (CSResult-succeed? result)
               (send trace get-contribution)))
        (values result contribution (set->list (send trace get-warn-diags))))))

  (define (publish-check-syntax result contribution diags)
    (define trace (CSResult-trace result))
    (publish-analysis! safe-doc running-status
                       (if (CSResult-succeed? result) 'succeeded 'failed)
                       (lambda (sd)
                         (define doc (SafeDoc-doc sd))
                         (set-SafeDoc-dependencies! sd (make-immutable-hash (hash->list dependencies)))
                         (send-diagnostics notify-client uri diags)

                         (when (CSResult-succeed? result)
                           (set-SafeDoc-sources! sd sources)
                           (set-SafeDoc-roots! sd roots)
                           (doc-update-trace! doc trace contribution working-version)
                           (workspace-set-contribution! current-workspace contribution)
                           (when (and (get-resyntax-enabled) (resyntax-available?))
                             (scheduler-push-task! token 'resyntax resyntax-task
                                                   #:publish publish-resyntax))))))

  (scheduler-stop-all-tasks! token)
  (scheduler-push-task! token 'check-syntax check-syntax-task
                        #:publish publish-check-syntax #:fail fail-analysis))

(provide SafeDoc-token
         SafeDoc?
         SafeDoc-doc
         SafeDoc-check-syntax-status
         (struct-out Check-Syntax-Status)
         new-safedoc
         safedoc-close!
         safedoc-run-check-syntax!
         safedoc-check-syntax-running?
         with-read-doc
         with-read-analysis
         safedoc-depends-on?
         with-write-doc
         with-read-safedoc
         with-write-safedoc)
