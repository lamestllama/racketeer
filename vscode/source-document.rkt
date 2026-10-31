#lang racket/base

(require file/sha1 net/url racket/path
         racket-langserver/common/path-util)

(provide current-source-documents make-source-documents
         untitled-uri? source-document-path source-document-uri source-document-unbased?
         document-uri->path document-path->uri)

;; Workspace analysis gives each untitled document a file identity in its
;; import base, so the document can be expanded, indexed and renamed like a
;; saved module. An immutable view belongs to one analysis. These paths are
;; source identities; no placeholder files are created, and they never replace
;; a proposed save path.
(define current-source-documents (make-parameter (hash)))
(define (untitled-uri? uri) (equal? (url-scheme (string->url uri)) "untitled"))

(define (make-source-documents uris roots)
  (for/hash ([uri (in-list uris)] #:when (untitled-uri? uri))
    (define url (string->url uri))
    (define base
      (cond [(url-path-absolute? url) (path-only (url->path url))]
            [(= (length roots) 1) (car roots)]
            [else #f]))
    (define path
      (simple-form-path
        (build-path (or base (find-system-path 'temp-dir))
                    (format ".racketeer-untitled-~a.rkt" (sha1 (open-input-string uri))))))
    (when (or (file-exists? path) (directory-exists? path) (link-exists? path))
      (error 'source-document "Cannot assign an analysis location for ~a" uri))
    (values uri (cons path base))))

(define (source-document-path uri)
  (define source (hash-ref (current-source-documents) uri #f))
  (and source (car source)))

(define (source-document-uri path)
  (for/first ([(uri source) (in-hash (current-source-documents))]
              #:when (equal? path (car source))) uri))

(define (document-uri->path uri)
  (or (source-document-path uri) (uri->path uri)))

;; Results name an untitled document by its URI, never by its identity path.
(define (document-path->uri path)
  (or (source-document-uri (simple-form-path path)) (path->uri path)))

(define (source-document-unbased? path)
  (for/or ([source (in-hash-values (current-source-documents))])
    (and (equal? path (car source)) (not (cdr source)))))
