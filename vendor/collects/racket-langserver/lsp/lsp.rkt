#lang racket/base

(require racket/contract
         racket/path
         "../common/path-util.rkt"
         "../doclib/doc.rkt"
         "../workspace/current.rkt"
         "../workspace/state.rkt"
         "safedoc.rkt"
         "scheduler.rkt")

(define open-docs (make-hasheq))

(define/contract lsp-get-doc
  (case->
    (-> string? SafeDoc?)
    (-> string? any/c any/c))
  (case-lambda
    [(uri)
     (hash-ref open-docs (string->symbol uri))]
    [(uri default)
     (hash-ref open-docs (string->symbol uri) default)]))

(define/contract (lsp-open-doc! uri text version)
  (-> string? string? exact-nonnegative-integer? SafeDoc?)
  (lsp-close-doc! uri)
  (define safe-doc (new-safedoc uri text version))
  (hash-set! open-docs (string->symbol uri) safe-doc)
  safe-doc)

(define/contract (lsp-close-doc! uri)
  (-> string? void?)
  (define uri-sym (string->symbol uri))
  (define safe-doc (lsp-get-doc uri #f))
  (when safe-doc
    (define token (SafeDoc-token safe-doc))
    (scheduler-close-doc! token)
    (safedoc-close! safe-doc)
    (clear-old-queries/doc-close token))
  (hash-remove! open-docs uri-sym))

;; Callbacks may acquire a SafeDoc lock. Snapshot the registry so callback
;; mutations cannot invalidate hash iteration.
(define/contract (lsp-for-each-open-doc proc)
  (-> (-> SafeDoc? any/c) void?)
  (for ([safe-doc (in-list (hash-values open-docs))])
    (proc safe-doc)))

;; Freeze all editor text before scheduling any consumer. A dependency edit can
;; change exports or macro expansion without changing the consumer's version.
(define (lsp-refresh-analysis! notify-client uri)
  (define changed (simple-form-path (uri->path uri)))
  (define documents (hash-values open-docs))
  (define sources
    (for/fold ([sources (hash)]) ([sd (in-list documents)])
      (with-read-doc sd
        (lambda (doc)
          (define path (simple-form-path (uri->path (Doc-uri doc))))
          (hash-set sources path
                    (and (not (hash-has-key? sources path)) (doc-get-text doc)))))))
  (define roots
    (append (workspace-folders current-workspace)
            (map path-only (hash-keys sources))))
  (for ([sd (in-list documents)]
        #:when (or (with-read-doc sd (lambda (doc) (equal? changed (simple-form-path (uri->path (Doc-uri doc))))))
                   (safedoc-depends-on? sd changed)))
    (safedoc-run-check-syntax! notify-client sd #:sources sources #:roots roots)))

(provide lsp-get-doc
         lsp-open-doc!
         lsp-close-doc!
         lsp-refresh-analysis!
         lsp-for-each-open-doc)
