#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list
         "../common/source.rkt"
         "binding-facts.rkt"
         "internal-types.rkt")

(provide augment-binding-facts)

;; The caller supplies a procedure with its provider data already captured.
;; Discovery and provider loading belong to the embedding application.
(define (augment-binding-facts provider source text pre expanded facts)
  (define uri (source-uri source))
  (define (fail message value)
    (raise-arguments-error 'bindings message "value" value))
  (define (phase? value) (or (not value) (exact-integer? value)))
  (define (space? value) (or (not value) (and (symbol? value) (symbol-interned? value))))
  (define (identifier-record? record)
    (and (hash? record) (identifier? (hash-ref record 'identifier #f))
         (phase? (hash-ref record 'phase 0)) (space? (hash-ref record 'space #f))))
  (define (range? range)
    (and (pair? range) (exact-nonnegative-integer? (car range))
         (exact-nonnegative-integer? (cdr range))
         (< (car range) (cdr range)) (<= (cdr range) (string-length text))))
  (define result
    (parameterize ([current-output-port (current-error-port)])
      (provider (hasheq 'operation 'bindings 'uri uri 'text text
                      'reader #f 'language #f 'submodules '()
                      'pre pre 'expanded expanded 'phase 0 'space #f
                      'position #f 'facts facts 'cancelled? (lambda () #f) 'hooks (hasheq)))))
  (unless (hash? result) (fail "expected a hash of bindings facts" result))
  (for ([field '(names families runtime)])
    (unless (list? (hash-ref result field '())) (fail "expected a list of bindings facts" field)))
  (define names (hash-ref result 'names '()))
  (for ([name (in-list names)])
    (unless (and (identifier-record? name) (range? (hash-ref name 'range #f))
                 (equal? uri (hash-ref name 'uri uri))
                 (memq (hash-ref name 'role #f) '(definition use export))
                 (memq (hash-ref name 'certainty 'confirmed) '(confirmed predicted))
                 (or (eq? (hash-ref name 'certainty 'confirmed) 'predicted)
                     (identifier-binding (hash-ref name 'identifier) (hash-ref name 'phase 0))))
      (fail "expected an in-source name with a scoped binding" name))
    (when (eq? (hash-ref name 'role) 'definition)
      (define binding
        (identifier-module-binding (hash-ref name 'identifier) (hash-ref name 'phase 0)
                                   (source-file-path source) (hash-ref name 'space #f)))
      (when (and binding (not (equal? (Module-Binding-filepath binding) (source-file-path source))))
        (fail "expected a definition owned by this source" name))))
  (define families (hash-ref result 'families '()))
  (define family-members (make-hash))
  (for ([family (in-list families)])
    (unless (and (hash? family) (hash-has-key? family 'key)
                 (identifier? (hash-ref family 'canonical #f))
                 (list? (hash-ref family 'members #f))
                 (pair? (hash-ref family 'members)))
      (fail "expected a family with a canonical identifier and members" family))
    (define members (hash-ref family 'members))
    (for ([member (in-list members)])
      (unless (and (identifier-record? member) (hash-has-key? member 'anchor)
                   (memq (hash-ref member 'role #f) '(definition use export))
                   (identifier-binding (hash-ref member 'identifier) (hash-ref member 'phase 0)))
        (fail "expected a bound family member with a structural anchor" member)))
    (define anchors
      (for/list ([member (in-list members)])
        (list (hash-ref member 'phase 0) (hash-ref member 'space #f)
              (hash-ref member 'role) (hash-ref member 'anchor))))
    (unless (= (length anchors) (length (remove-duplicates anchors)))
      (fail "family anchors must be distinct" family))
    (unless (for/or ([member (in-list members)])
              (free-identifier=? (hash-ref family 'canonical) (hash-ref member 'identifier)
                                 (hash-ref member 'phase 0)))
      (fail "canonical identifier must belong to the family" family))
    (when (hash-has-key? family-members (hash-ref family 'key))
      (fail "duplicate family key" family))
    (hash-set! family-members (hash-ref family 'key) members))
  ;; Resolve module identities in the namespace that established the scopes.
  ;; Rename retains these records after that namespace has been released.
  (define (resolved record)
    (hash-set record 'binding
              (identifier-module-binding (hash-ref record 'identifier) (hash-ref record 'phase 0)
                                         (source-file-path source) (hash-ref record 'space #f))))
  (hash-set (hash-set (hash-set facts 'names (append (hash-ref facts 'names) (map resolved names)))
                      'families (append (hash-ref facts 'families)
                                        (for/list ([family (in-list families)])
                                          (hash-set family 'members (map resolved (hash-ref family 'members))))))
            'runtime (append (hash-ref facts 'runtime) (hash-ref result 'runtime '()))))
