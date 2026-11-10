#lang racket/base
;; Adapted from racket-langserver, doclib/service/declaration.rkt and doclib/doc.rkt.
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require drracket/check-syntax
         racket/class racket/list racket/match syntax/id-table
         racket-langserver/common/source
         racket-langserver/common/path-util
         racket-langserver/doclib/internal-types
         racket-langserver/doclib/service/interface
         racket-langserver/doclib/binding-facts
         racket-langserver/doclib/bindings-provider
         (only-in racket-langserver/doclib/service/declaration current-retain-binding-facts?))

(provide bindings-service% bindings-factory)

;; One expansion owns these identities. Only Module-Binding keys can leave the
;; document; scoped local keys are private to this service. Queries use character
;; offsets and return half-open ranges, ready for the caller's position converter.
;; Navigation shows predicted occurrences. identities-at and references report
;; only what expansion confirmed unless asked, so a rename can rely on them.
(define bindings-service%
  (class base-service%
    (init-field source doc-text [provider #f])
    (super-new)
    (define src (source-syntax-source source))
    (define file (source-file-path source))
    (define names '())
    (define callbacks '())
    (define arrows '())
    (define targets (make-hash))
    (define families (make-hash))
    (define accepted-facts #f)
    (define source-bindings '())
    (define collected? #f)
    (define invalidated? #f)

    (define/override (reset)
      (set! names '())
      (set! callbacks '())
      (set! arrows '())
      (set! targets (make-hash))
      (set! families (make-hash))
      (set! accepted-facts #f)
      (set! source-bindings '())
      (set! collected? #f)
      (set! invalidated? #f))
    ;; Exact navigation never replays positions from an earlier source view.
    (define/override (text-replaced _start _end) (send this reset) (set! invalidated? #t))
    (define/override (expand _start _end) (send this reset) (set! invalidated? #t))
    (define/override (contract _start _end) (send this reset) (set! invalidated? #t))

    (define/private (range start end) (cons start (if (= start end) (add1 end) end)))
    (define/private (confirmed? name)
      (eq? (hash-ref name 'certainty 'confirmed) 'confirmed))
    (define/private (record range key role [certainty 'confirmed])
      (hasheq 'range range 'identity key 'role role 'certainty certainty))
    (define/private (target! key range)
      (hash-update! targets key (lambda (old) (remove-duplicates (cons range old))) '()))
    (define/private (install! name)
      (set! names (cons name names))
      (when (and (confirmed? name) (eq? (hash-ref name 'role) 'definition))
        (target! (hash-ref name 'identity) (hash-ref name 'range))))

    (define/override (syncheck:add-definition-target/phase-level+space obj start end id mods phase)
      (when (and file (equal? obj src))
        (set! callbacks (cons (hash-set (record (range start end) (Module-Binding file mods phase id)
                                               'definition)
                                       'phase (if (pair? phase) (car phase) phase)) callbacks))))
    (define/override (syncheck:add-jump-to-definition/phase-level+space obj start end id path mods phase)
      (when (equal? obj src)
        (define key
          (Module-Binding (normalize-source-path
                           (path->complete-path path (or (current-load-relative-directory)
                                                        (current-directory)))) mods phase id))
        (set! callbacks (cons (hash-set (record (range start end) key 'use) 'point? (= start end))
                             callbacks))))
    (define/override (syncheck:add-arrow/name-dup from left right to start end actual? phase imported? _dup?)
      (when (and (equal? from src) (equal? to src)
                 (or (not (eq? imported? 'module-lang)) (< start end)))
        (set! arrows (cons (list (range left right) (range start end) phase imported? actual?) arrows))))

    (define/override (walk-stx result)
      (unless (or collected? invalidated?)
        (set! collected? #t)
        (define text (send doc-text get-text))
        (define pre (ExpandResult-pre-syntax result))
        (define expanded (ExpandResult-post-syntax result))
        (when (syntax? expanded)
          (define generic (collect-binding-facts source expanded text pre))
          ;; Validation completes before any provider result enters the graph.
          ;; A declining or invalid provider leaves the generic evidence intact.
          (define facts
            (if provider
                (with-handlers ([exn:fail:contract? (lambda (_) generic)])
                  (augment-binding-facts
                   (lambda (request) (or (provider request) (hasheq)))
                   source text pre expanded generic))
                generic))
          (define tables (make-hash))
          (define identities (make-hasheq))
          (define (identity name)
            (hash-ref! identities name
              (lambda ()
                (define phase (hash-ref name 'phase 0))
                (define space (hash-ref name 'space #f))
                (define id (hash-ref name 'identifier))
                (define binding (identifier-module-binding id phase file space))
                (or (and binding
                         (if space
                             (struct-copy Module-Binding binding
                               [phase+space (cons (Module-Binding-phase+space binding) space)])
                             binding))
                    (and (or (eq? (identifier-binding id phase) 'lexical) (not (confirmed? name)))
                         (let ([table (hash-ref! tables (cons phase space)
                                                (lambda () (make-free-id-table #:phase phase)))])
                           (if (or (eq? (hash-ref name 'role) 'definition) (not (confirmed? name)))
                               (free-id-table-ref! table id (lambda () (gensym 'local)))
                               (free-id-table-ref table id #f))))))))
          (define raw (hash-ref facts 'names '()))
          (for ([name (in-list raw)] #:when (eq? (hash-ref name 'role) 'definition))
            (identity name))
          (define exact-anchors (make-hash))
          (define (exact-anchor? r)
            (hash-ref! exact-anchors r
              (lambda ()
                (with-handlers ([exn:fail:read? (lambda (_) #f)])
                  (parameterize ([read-accept-reader #f] [read-accept-lang #f])
                    (define token (read-syntax #f (open-input-string (substring text (car r) (cdr r)))))
                    (and (identifier? token) (= (syntax-position token) 1)
                         (= (syntax-span token) (- (cdr r) (car r)))))))))
          ;; Preserve a provider's smaller written component for the same scoped
          ;; occurrence. Keep all owners tied at the smallest written range.
          (define precise (make-hash))
          (for ([name (in-list raw)]
                #:when (and (confirmed? name) (eq? (hash-ref name 'role) 'use)))
            (define id (hash-ref name 'identifier))
            (define r (hash-ref name 'range))
            (when (and (equal? (syntax-source id) src) (syntax-position id) (syntax-span id)
                       (<= (sub1 (syntax-position id)) (car r) (cdr r)
                           (+ (sub1 (syntax-position id)) (syntax-span id)))
                       (< (- (cdr r) (car r)) (syntax-span id)))
              (hash-set! precise (list (identity name) (syntax-position id) (syntax-span id)) #t)))
          (for ([name (in-list raw)])
            (define id (hash-ref name 'identifier))
            (define r (hash-ref name 'range))
            (define key (identity name))
            (when key
              (unless (and (confirmed? name) (eq? (hash-ref name 'role) 'use)
                           (syntax-position id) (syntax-span id)
                           (= (- (cdr r) (car r)) (syntax-span id))
                           (hash-ref precise (list key (syntax-position id) (syntax-span id)) #f))
                (if (and (confirmed? name) (eq? (hash-ref name 'role) 'definition)
                         (not (exact-anchor? r)))
                    (target! key r)
                    (install! (hash-set* (record r key (hash-ref name 'role)
                                                (hash-ref name 'certainty 'confirmed))
                                        'phase (hash-ref name 'phase 0) 'space (hash-ref name 'space #f)
                                        'name (syntax-e id)))))))
          ;; The scoped identifier supplies the declaration phase; callbacks may
          ;; instead carry the import shift. Replace only that superseded owner.
          (define (phase-of key)
            (define phase (Module-Binding-phase+space key))
            (if (pair? phase) (car phase) phase))
          (define (arrows-by-use actual?)
            (for/fold ([table (hash)])
                      ([arrow (in-list arrows)] #:when (eq? (and (list-ref arrow 4) #t) actual?))
              (hash-update table (list (cadr arrow) (caddr arrow))
                           (lambda (binders) (cons (car arrow) binders)) '())))
          (define actual-binders (arrows-by-use #t))
          (define predicted-binders (arrows-by-use #f))
          (define own-binders (make-hash))
          (define owners-at (make-hash))
          (for ([callback (in-list callbacks)])
            (define key (hash-ref callback 'identity))
            (if (eq? (hash-ref callback 'role) 'definition)
                (hash-update! own-binders key (lambda (ranges) (cons (hash-ref callback 'range) ranges)) '())
                (hash-update! owners-at (list (hash-ref callback 'range) (phase-of key))
                              (lambda (keys) (remove-duplicates (cons key keys))) '())))
          ;; A binder that is the identity's own definition says whose arrow it is, and
          ;; an actual arrow from it settles the use. An imported binder is shared, so
          ;; its actual arrow settles only an identity that is alone at the use.
          (define (predicted-use? key r)
            (define at (list r (phase-of key)))
            (define actual (hash-ref actual-binders at '()))
            (define own (hash-ref own-binders key '()))
            (for/or ([binder (in-list (hash-ref predicted-binders at '()))])
              (and (or (null? own) (member binder own))
                   (or (not (member binder actual))
                       (and (null? own) (> (length (hash-ref owners-at at '())) 1))))))
          (for ([callback (in-list callbacks)])
            (define key (hash-ref callback 'identity))
            (define r (hash-ref callback 'range))
            (define replaced?
              (and (eq? (hash-ref callback 'role) 'use)
                   (for/or ([name (in-list raw)]
                            #:when (and (confirmed? name) (memq (hash-ref name 'role) '(use export))))
                     (define owner (identity name))
                     (define id (hash-ref name 'identifier))
                     (define info (identifier-binding id (hash-ref name 'phase 0)))
                     (and (Module-Binding? owner) (list? info)
                          (equal? (Module-Binding-filepath key) (Module-Binding-filepath owner))
                          (equal? (Module-Binding-submods key) (Module-Binding-submods owner))
                          (eq? (Module-Binding-id key) (Module-Binding-id owner))
                          (or (equal? key owner)
                              (equal? (Module-Binding-phase+space key) (list-ref info 5)))
                          (or (equal? r (hash-ref name 'range))
                              (and (hash-ref callback 'point? #f) (not (equal? key owner))
                                   (= (car r) (car (hash-ref name 'range))))
                              (and (syntax-position id) (syntax-span id)
                                   (equal? r (cons (sub1 (syntax-position id))
                                                   (+ (sub1 (syntax-position id)) (syntax-span id))))))))))
            (unless replaced?
              (install! (if (and (eq? (hash-ref callback 'role) 'use) (predicted-use? key r))
                            (hash-set callback 'certainty 'predicted) callback))))
          ;; Scoped occurrences disambiguate arrows whose generated binders share
          ;; a written anchor. Retain callback-only local and implicit uses.
          (for ([arrow (in-list arrows)])
            (match-define (list binder use phase imported? actual?) arrow)
            (unless (or (and imported? (not (eq? imported? 'module-lang)))
                        (and actual? (for/or ([name (in-list names)])
                          (and (confirmed? name)
                               (let ([r (hash-ref name 'range)])
                                 (if imported? (equal? use r)
                                     (<= (car r) (car use) (cdr use) (cdr r))))))))
              (define owners
                (remove-duplicates
                 (for/list ([name (in-list names)]
                            #:when (and (confirmed? name) (eq? (hash-ref name 'role) 'definition)
                                        (equal? binder (hash-ref name 'range))
                                        (equal? phase (hash-ref name 'phase phase))))
                   (hash-ref name 'identity))))
              (when (null? owners)
                (set! owners (list (list (if imported? 'implicit 'arrow) binder phase
                                        (and imported? (substring text (car use) (cdr use)))))))
              (for ([owner (in-list owners)])
                (when (and actual? (not imported?))
                  (install! (hash-set (record binder owner 'definition) 'phase phase)))
                (install! (hash-set (record use owner 'use (if actual? 'confirmed 'predicted)) 'phase phase)))))
          (set! names (remove-duplicates names))
          (for ([family (in-list (hash-ref facts 'families '()))])
            (define members (remove-duplicates (map identity (hash-ref family 'members))))
            (for ([owner (in-list members)]) (hash-set! families owner members)))
          (set! source-bindings (confirmed-source-bindings facts text identity))
          ;; Resolve scoped identities before releasing the expansion's syntax.
          (set! accepted-facts
                (if (current-retain-binding-facts?) facts
                    (hasheq 'regions (hash-ref facts 'regions '()) 'names names
                            'binders (for/list ([binder (in-list (hash-ref facts 'binders '()))])
                                       (hasheq 'name (syntax-e (hash-ref binder 'identifier))
                                               'authored? (hash-ref binder 'authored? #t)))))))
        (set! callbacks '())
        (set! arrows '())))

    (define/public (get-binding-facts) accepted-facts)
    (define/public (get-source-bindings) source-bindings)
    (define/public (names-at pos)
      (define hits (filter (lambda (name)
                             (define r (hash-ref name 'range))
                             (<= (car r) pos (sub1 (cdr r)))) names))
      (if (null? hits) '()
          (let ([width (apply min (map (lambda (name)
                                        (define r (hash-ref name 'range))
                                        (- (cdr r) (car r))) hits))])
            (filter (lambda (name)
                      (define r (hash-ref name 'range))
                      (= width (- (cdr r) (car r)))) hits))))
    (define/public (identities-at pos #:predicted? [predicted? #f])
      (remove-duplicates
       (for/list ([name (in-list (send this names-at pos))]
                  #:when (or predicted? (confirmed? name)))
         (hash-ref name 'identity))))
    (define/private (sort-ranges ranges)
      (sort (remove-duplicates ranges)
            (lambda (a b) (or (< (car a) (car b))
                             (and (= (car a) (car b)) (< (cdr a) (cdr b)))))))
    (define/public (definitions keys)
      (sort-ranges (append-map (lambda (key) (hash-ref targets key '())) keys)))
    (define/public (references keys [include-declaration? #f] #:predicted? [predicted? #f])
      (sort-ranges
       (append (if include-declaration? (send this definitions keys) '())
               (for/list ([name (in-list names)]
                          #:when (and (or predicted? (confirmed? name))
                                      (not (eq? (hash-ref name 'role) 'definition))
                                      (member (hash-ref name 'identity) keys)
                                      (not (member (hash-ref name 'range)
                                                   (hash-ref targets (hash-ref name 'identity) '())))))
                 (hash-ref name 'range)))))
    (define/public (definition-ranges-at pos)
      (send this definitions (send this identities-at pos #:predicted? #t)))
    (define/public (reference-ranges-at pos [include-declaration? #f])
      (define keys (remove-duplicates
                    (append-map (lambda (key) (hash-ref families key (list key)))
                                (send this identities-at pos #:predicted? #t))))
      (send this references keys include-declaration? #:predicted? #t))))

(define ((bindings-factory [provider #f]) source doc-text _lexer-state)
  (new bindings-service% [source source] [doc-text doc-text] [provider provider]))
