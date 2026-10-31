#lang racket/base

;; textDocument/definition. A local location, or no binding, is returned
;; immediately. A module binding is resolved by `target-query`.
(require net/url
         "../../common/interfaces.rkt"
         "../../common/time.rkt"
         "../../doclib/doc.rkt"
         "target.rkt"
         "../../workspace/source-store.rkt"
         "../analysis.rkt"
         "../analysis-query.rkt"
         "../responses.rkt"
         "../safedoc.rkt"
         "../source-controller.rkt")

(provide definition-query)

(define (untitled-uri? uri)
  (equal? "untitled" (url-scheme (string->url uri))))

(define (definition-query safe-doc id uri pos)
  (define deadline (+ (current-deadline-milliseconds)
                      (* 1000 (current-analysis-request-timeout))))
  (define controller (current-source-controller))
  (define-values (view target)
    (with-read-safedoc safe-doc
      (lambda (sd)
        (define doc (SafeDoc-doc sd))
        (values (SafeDoc-source-view sd)
                (or (doc-definition doc uri pos)
                    ;; An untitled draft imports ordinary files; find their
                    ;; definitions as for a saved file. Hover and other
                    ;; virtual documents stay document-local.
                    (and (untitled-uri? uri) (doc-module-binding-at doc pos)))))))
  (cond
    [(Module-Binding? target)
     (target-query id controller deadline view target "Definition"
                   (lambda (facts binding)
                     (hash-ref (Analysis-Summary-definition-ranges facts) binding #f))
                   (lambda (snapshot range)
                     (and range (Location (Source-Snapshot-uri snapshot) range))))]
    [else (success/enc id target)]))
