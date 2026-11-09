#lang racket/base

(require "../../common/source.rkt"
         "../../common/interfaces.rkt"
         "../../doclib/internal-types.rkt"
         "../../workspace/state.rkt"
         racket/contract
         racket/list)

(provide reference-locations)

;; Locations for one references request.
;;
;; Order: the live document's locations, then the declaration when
;; `include-declaration?` is true and that file is a different source, then
;; locations from the other workspace sources.
;;
;; Keep each source's location order and duplicates. This function does not
;; sort sources against each other. Leave the live source out of the
;; workspace lists: its locations come from the request, and the index may
;; still hold older text for that document. The live source matches by exact
;; `Source-Id` equality.
(define/contract (reference-locations workspace document-result include-declaration?)
  (-> Workspace? Document-Reference-Result? boolean? (listof Location?))
  (define live-source (Document-Reference-Result-source document-result))
  (define module-binding (Document-Reference-Result-module-binding document-result))
  (define live-id (Reference-Source-id live-source))
  (define bindings
    (cond [(not module-binding) '()]
          [(list? module-binding) module-binding]
          [else (list module-binding)]))
  (define definitions
    (for*/list ([binding (in-list bindings)]
                #:when (and include-declaration?
                            (not (equal? (source-id (path->source (Module-Binding-filepath binding)))
                                         live-id)))
                [location (in-value (workspace-definition-location workspace binding))]
                #:when location)
      location))
  (define locations
    (append (Reference-Source-locations live-source)
            definitions
            (for*/list ([binding (in-list bindings)]
                        [source (in-list (workspace-reference-sources workspace binding))]
                        #:unless (equal? (Reference-Source-id source) live-id)
                        [location (in-list (Reference-Source-locations source))])
              location)))
  ;; A confirmed family or several selected identities can share a location. Preserve
  ;; the established ordering and duplicate behaviour for a single binding.
  (if (list? module-binding) (remove-duplicates locations) locations))
