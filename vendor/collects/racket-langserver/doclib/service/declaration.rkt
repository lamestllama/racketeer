#lang racket/base

;; Binding graph for one document. Answers: which occurrence is at a
;; position, the local definition range, other uses in this document, and a
;; Module-Binding when the name can leave this document.
;;
;; Check Syntax can report several identities at one range. This service stores
;; Check Syntax and scoped expansion facts as a graph. Each occurrence has a private integer
;; id. Callers never hold those ids. Uses share a graph owner: a local
;; def-id for an unlabelled lexical arrow, an exact Module-Binding for
;; module-backed uses, or a Module-Lang-Use-Key for a leftover `#lang`
;; export use. Only Module-Binding may leave this document.
;;
;; Check Syntax positions are a snapshot. After edits, def-at-position and
;; use-at-position move with the text. id->range stays at the snapshot
;; until a query replays a position journal into a live CharRange
;; (character offsets, not an LSP line/character Range). The query
;; position is already live, so it hits the moved maps directly.
;;
;; Callbacks may arrive in any order. Lexical arrows, jumps, and definition
;; targets form one graph either way. Module-language arrows mark `#lang`
;; export uses. Those arrows wait until walk-stx, then fill only ranges
;; that lexical arrows and jumps left free. A leftover `#lang` use has no
;; local definition and no Module-Binding, so it must not leave this
;; document.

(require "interface.rkt"
         "char-range-edit.rkt"
         "interval-map-edit.rkt"
         "position-journal.rkt"
         "../../common/interfaces.rkt"
         "../../common/path-util.rkt"
         (only-in "../../common/source.rkt" source-file-path source-syntax-source)
         "../internal-types.rkt"
         "../binding-facts.rkt"
         data/interval-map
         drracket/check-syntax
         racket/class
         racket/dict
         racket/list
         racket/match
         syntax/id-table
         syntax/modresolve)

(provide declaration% current-retain-binding-facts?)

;; Rename validates transient expansions before discarding their scoped facts.
(define current-retain-binding-facts? (make-parameter #f))

;; Private graph owner for a leftover `#lang` export use. Not a
;; Module-Binding. Do not return this key from public methods or treat the
;; key as a definition. language-start/end is the `#lang` range Check Syntax
;; reported as the arrow start. use-text is the use-site text, not the
;; language name. equal? groups leftover `#lang` uses that share the same
;; `#lang` range, phase-level, and use-site text.
(struct Module-Lang-Use-Key
  (language-start language-end phase-level use-text)
  #:transparent)

;; A `'module-lang` use held until walk-stx, so lexical arrows and jumps can
;; claim the range first.
(struct Pending-Module-Lang-Use
  (key use-start use-end)
  #:transparent)

(define declaration%
  (class base-service%
    (init-field source doc-text [contribution-only? #f])
    (define file-path (source-file-path source))
    (super-new)

    (define def-at-position (make-interval-map))
    (define use-at-position (make-interval-map))
    ;; Snapshot CharRange for each id. Edits do not rewrite id->range;
    ;; queries replay range-journal instead.
    (define id->range (make-hash))
    (define def->use-ids (make-hash))
    (define use->def (make-hash))
    ;; This document's definitions that have a Module-Binding. Imports are not
    ;; in these two hashes; an import uses the Module-Binding itself as the
    ;; graph owner.
    (define module-binding->def-id (make-hash))
    (define def-id->module-bindings (make-hash))
    (define import-alias-def-ids (make-hash))
    (define binding-families (make-hash))
    (define accepted-binding-facts #f)
    (define source-bindings '())
    (define precise-uses (make-hash))
    ;; Scoped lexical binders may also share one physical definition range.
    (define lexical-owners (make-hash))
    (define lexical-definitions (make-hash))
    (define coarse-definitions (make-hash))
    (define component-at-position (make-interval-map))
    (define component-ranges (make-hash))
    (define incomplete-components (make-hash))
    (define confirmed-use-ids (make-hasheqv))
    (define range-journal (make-position-journal))
    ;; `'module-lang` uses held until walk-stx.
    (define pending-module-lang-uses '())

    (define fresh-id!
      (let ([id 0])
        (lambda ()
          (begin0 id
            (set! id (add1 id))))))

    ;; Lexical arrows and jumps treat a zero-width Check Syntax report as a
    ;; one-character range. Module-language arrows do not call this function.
    ;; A zero-width module-language range is dropped instead.
    (define/private (normalize-end start end)
      (if (= start end)
          (add1 end)
          end))

    (define/private (def-at-exact-range start end)
      (define-values (found-start found-end def-id)
        (interval-map-ref/bounds def-at-position start #f))
      (and (eqv? found-start start)
           (eqv? found-end end)
           def-id))

    ;; Reuse the def-id for this snapshot range so later arrows and
    ;; definition targets join the same definition.
    (define/private (get-or-create-def start end)
      (or (def-at-exact-range start end)
          (let ([def-id (fresh-id!)])
            (interval-map-set! def-at-position start end def-id)
            (hash-set! id->range def-id (CharRange start end))
            (hash-set! def->use-ids def-id '())
            def-id)))

    (define/private (use-at-exact-range start end)
      (define-values (found-start found-end use-id)
        (interval-map-ref/bounds use-at-position start #f))
      (and (eqv? found-start start)
           (eqv? found-end end)
           use-id))

    (define/private (alloc-use start end def)
      (define narrowed? (positive? (hash-count precise-uses)))
      (define existing
        (if narrowed?
            (filter (lambda (id) (equal? (hash-ref id->range id) (CharRange start end)))
                    (interval-map-ref use-at-position start '()))
            (or (use-at-exact-range start end) '())))
      (or (for/first ([use-id (in-list existing)]
                      #:when (equal? (hash-ref use->def use-id #f) def))
            use-id)
          (let ([use-id (fresh-id!)])
            (if narrowed?
                (interval-map-update*! use-at-position start end (lambda (ids) (cons use-id ids)) '())
                (interval-map-set! use-at-position start end (cons use-id existing)))
            (hash-set! id->range use-id (CharRange start end))
            use-id)))

    ;; Keep exact module identities as owners, even for same-file jumps.
    ;; The range's def-id remains the owner of unlabelled lexical arrows.
    (define/private (link-use! use-id def)
      (hash-set! use->def use-id def)
      (hash-update! def->use-ids def
                    (lambda (use-ids) (if (member use-id use-ids) use-ids (cons use-id use-ids)))
                    '()))

    (define/private (remove-shared-lexical-uses! start)
      (for ([use-id (in-list (interval-map-ref use-at-position start '()))])
        (define def (hash-ref use->def use-id))
        (when (and (exact-nonnegative-integer? def)
                   (not (hash-ref confirmed-use-ids use-id #f))
                   (or (> (length (hash-ref def-id->module-bindings def '())) 1)
                       (> (length (hash-ref lexical-owners def '())) 1)))
          (define old-range (hash-ref id->range use-id))
          (define old-start (CharRange-start old-range))
          (define old-end (CharRange-end old-range))
          (if (positive? (hash-count precise-uses))
              (begin
                (interval-map-update*! use-at-position old-start old-end
                                      (lambda (ids) (remove use-id ids)) '())
                (for ([entry (in-list (dict->list use-at-position))] #:when (null? (cdr entry)))
                  (interval-map-remove! use-at-position (caar entry) (cdar entry))))
              (let ([remaining (remove use-id (use-at-exact-range old-start old-end))])
                (if (null? remaining)
                    (interval-map-remove! use-at-position old-start old-end)
                    (interval-map-set! use-at-position old-start old-end remaining))))
          (hash-update! def->use-ids def (lambda (ids) (remove use-id ids)))
          (hash-remove! use->def use-id))))

    ;; Replay the snapshot CharRange in id->range through range-journal.
    ;; Returns #f if an edit removed the range: a CharRange a deletion
    ;; collapses to empty is dropped, and later journal steps cannot restore
    ;; it. Replay must move a snapshot CharRange the same way expand and
    ;; contract move the interval maps.
    (define/private (live-range-for-id id)
      (position-journal-replay range-journal
                               (hash-ref id->range id)
                               expand-char-range
                               contract-char-range))

    ;; Install a held `'module-lang` use only when no use already occupies
    ;; the pending use's exact snapshot range. Do not overwrite a lexical
    ;; arrow or a jump.
    (define/private (apply-pending-module-lang-uses!)
      (for ([pending (in-list pending-module-lang-uses)])
        (define use-start (Pending-Module-Lang-Use-use-start pending))
        (define use-end (Pending-Module-Lang-Use-use-end pending))
        (unless (use-at-exact-range use-start use-end)
          (define def (Pending-Module-Lang-Use-key pending))
          (define use-id (alloc-use use-start use-end def))
          (link-use! use-id def)))
      (set! pending-module-lang-uses '()))

    (define/private (sort-ranges ranges)
      (sort ranges
            (lambda (left right)
              (or (< (CharRange-start left) (CharRange-start right))
                  (and (= (CharRange-start left) (CharRange-start right))
                       (< (CharRange-end left) (CharRange-end right)))))))

    (define/private (defs-at pos)
      (define use-ids (interval-map-ref use-at-position pos #f))
      (if use-ids
          (let ([defs (remove-duplicates (map (lambda (id) (hash-ref use->def id)) use-ids))])
            ;; An import alias can have both a lexical anchor and an exact
            ;; jump. Suppress only anchors identified in expanded require
            ;; forms; other lexical owners remain part of the selection.
            (if (ormap Module-Binding? defs)
                (remove-duplicates
                  (append-map
                    (lambda (def)
                      (define bindings (def->module-bindings def))
                      (cond [(hash-ref import-alias-def-ids def #f) '()]
                            [(pair? bindings) bindings]
                            [else (list def)]))
                    defs))
                defs))
          (let ([def (interval-map-ref def-at-position pos #f)])
            (cond [(not def) '()]
                  [(hash-has-key? lexical-owners def)
                   (append (hash-ref lexical-owners def)
                           (if (null? (def->module-bindings def)) '() (list def)))]
                  [else (list def)]))))

    (define/private (def->module-bindings def)
      (cond
        [(Module-Binding? def) (list def)]
        [(exact-nonnegative-integer? def)
         (hash-ref def-id->module-bindings def '())]
        [else '()]))

    ;; Component maps keep precise navigation independent of whole binding keys.
    ;; Like all other ranges, they are replayed through the position journal.
    (define/public (component-definition-at pos)
      (define target (interval-map-ref component-at-position pos #f))
      (and target (live-range-for-id target)))

    (define/public (component-edit-ranges-at pos)
      (define target (interval-map-ref component-at-position pos #f))
      (and accepted-binding-facts target
           (not (hash-ref incomplete-components target #f))
           (sort-ranges (filter values (map (lambda (id) (live-range-for-id id))
                                           (hash-ref component-ranges target))))))

    (define/public (occurrence-at pos)
      (define-values (use-start use-end use-id)
        (interval-map-ref/bounds use-at-position pos #f))
      (define-values (def-start def-end def-id)
        (interval-map-ref/bounds def-at-position pos #f))
      (define-values (component-start component-end component)
        (interval-map-ref/bounds component-at-position pos #f))
      (cond
        [component (CharRange component-start component-end)]
        [use-id (CharRange use-start use-end)]
        [def-id (CharRange def-start def-end)]
        [else #f]))

    ;; Same-document definition range, including exact same-file jumps.
    ;; Imported and module-language owners have no local definition range.
    (define/public (definition-ranges-at pos)
      (define component (send this component-definition-at pos))
      (if component (list component)
      (sort-ranges
        (remove-duplicates
          (for*/list ([def (in-list (defs-at pos))]
                      [id (in-value (if (Module-Binding? def)
                                        (hash-ref module-binding->def-id def #f) def))]
                      #:when (exact-nonnegative-integer? id)
                      [range (in-value (live-range-for-id id))]
                      #:when range)
            range)))))

    (define/public (definition-at pos)
      (define ranges (definition-ranges-at pos))
      (and (= (length ranges) 1) (car ranges)))

    (define/public (binding-count-at pos)
      (length
        (remove-duplicates
          (append-map (lambda (def)
                        (define bindings (def->module-bindings def))
                        (if (null? bindings) (list def) bindings))
                      (defs-at pos)))))

    (define/public (coarse-definition-at? pos)
      (for/or ([def (in-list (defs-at pos))])
        (hash-ref coarse-definitions def #f)))

    ;; Union the selected identities, deduplicating physical occurrences.
    ;; A shared definition range selects its whole family; an exact jump
    ;; selects only that module binding.
    (define/private (uses-for selected)
      (define defs
        (remove-duplicates
          (append-map (lambda (def)
                        (cons def (if (Module-Binding? def) '() (def->module-bindings def))))
                      selected)))
      (define owners
        (remove-duplicates
          (append defs
                  (for/list ([def (in-list defs)]
                             #:when (and (Module-Binding? def)
                                         (hash-has-key? module-binding->def-id def)))
                    (hash-ref module-binding->def-id def)))))
      (sort-ranges
        (remove-duplicates
          (for*/list ([def (in-list owners)]
                      [use-id (in-list (hash-ref def->use-ids def '()))]
                      [range (in-value (live-range-for-id use-id))]
                      #:when range)
            range))))

    (define/public (uses-at pos) (uses-for (defs-at pos)))

    ;; Family membership is explicit scoped evidence. Sharing a range alone
    ;; continues to select exact identities, never their other family members.
    (define/private (reference-owners-at pos)
      (remove-duplicates
        (append-map
          (lambda (owner) (hash-ref binding-families owner (list owner)))
          (append-map (lambda (def)
                        (define bindings (def->module-bindings def))
                        (if (null? bindings) (list def) bindings))
                      (defs-at pos)))))

    (define/public (reference-module-bindings-at pos)
      (remove-duplicates (append-map (lambda (owner) (def->module-bindings owner))
                                    (reference-owners-at pos))))

    (define/public (reference-ranges-at pos include-declaration?)
      (define owners (reference-owners-at pos))
      (remove-duplicates
        (append (if include-declaration?
                    (sort-ranges
                      (remove-duplicates
                        (append (definition-ranges-at pos)
                                (for*/list ([owner (in-list owners)]
                                            [id (in-value (if (Module-Binding? owner)
                                                              (hash-ref module-binding->def-id owner #f)
                                                              owner))]
                                            #:when (exact-nonnegative-integer? id)
                                            [range (in-value (live-range-for-id id))]
                                            #:when range)
                                  range))))
                    '())
                (uses-for (append (defs-at pos) owners)))))

    ;; Called in the expansion namespace, in both analysis modes. Core binders
    ;; supply anchors even when originalness prevented Check Syntax callbacks.
    (define/public (get-binding-facts) accepted-binding-facts)
    (define/public (get-source-bindings) source-bindings)

    (define/public (add-binding-facts facts)
      (set! accepted-binding-facts facts)
      (set! component-at-position (make-interval-map))
      (set! component-ranges (make-hash))
      (set! incomplete-components (make-hash))
      (unless (null? (hash-ref facts 'components '()))
        (define component-names
          (filter (lambda (name) (eq? (hash-ref name 'certainty 'confirmed) 'confirmed))
                  (hash-ref facts 'names '())))
        ;; Index the scoped directives, then project every authored occurrence.
        ;; A missing mapping for any identity sharing an edited range refuses rename.
        (define directives (make-hash))
        (define targets (make-hash))
        (define projected (make-hash))
        (define affected (make-hash))
        (define (affected-table phase)
          (hash-ref! affected phase (lambda () (make-free-id-table #:phase phase))))
        (define (affect! id phase target)
          (define table (affected-table phase))
          (free-id-table-set! table id (cons target (free-id-table-ref table id '()))))
        (define (directive-table phase)
          (hash-ref! directives phase (lambda () (make-free-id-table #:phase phase))))
        (define (install-component! binding range offset width)
          (define phase (hash-ref binding 'phase 0))
          (define table (directive-table phase))
          (define id (hash-ref binding 'identifier))
          (define target
            (hash-ref! targets range
                       (lambda ()
                         (define id (fresh-id!))
                         (hash-set! id->range id (CharRange (car range) (cdr range)))
                         (hash-set! component-ranges id (list id))
                         id)))
          (affect! id phase target)
          (free-id-table-set! table id
                              (remove-duplicates
                                (cons (list target offset width)
                                      (free-id-table-ref table id '())))))
        (for ([component (in-list (hash-ref facts 'components '()))])
          (install-component! component (hash-ref component 'range)
                              (hash-ref component 'offset) (hash-ref component 'width)))
        (define (mappings-for name)
          (define table (directive-table (hash-ref name 'phase 0)))
          (remove-duplicates
            (append-map (lambda (id) (free-id-table-ref table id '()))
                        (cons (hash-ref name 'identifier) (hash-ref name 'origins '())))))
        ;; Only the directive's scoped target can be a direct member.
        (for ([component (in-list (hash-ref facts 'components '()))])
          (define target (hash-ref component 'target))
          (define phase (hash-ref component 'phase))
          (define range (hash-ref component 'range))
          (when (and (identifier-binding target phase)
                     (equal? (send doc-text get-text (car range) (cdr range))
                             (symbol->string (syntax-e target))))
            (install-component! (hasheq 'identifier target 'phase phase) range 0
                                (- (cdr range) (car range)))))
        (for ([name (in-list component-names)]
              #:when (memq (hash-ref name 'role) '(use export)))
          (define range (hash-ref name 'range))
          (define id (hash-ref name 'identifier))
          (define spelling (symbol->string (syntax-e id)))
          (define mappings (mappings-for name))
          (define exact-spelling? (equal? spelling (send doc-text get-text (car range) (cdr range))))
          (for ([mapping (in-list mappings)])
              (match-define (list target offset width) mapping)
              (define start (+ (car range) offset))
              (define end (+ start width))
              (define target-range (hash-ref id->range target))
              (cond
                [(and exact-spelling? (<= end (cdr range))
                      (equal? (send doc-text get-text start end)
                              (send doc-text get-text (CharRange-start target-range)
                                                     (CharRange-end target-range))))
                 (define previous (interval-map-ref component-at-position start #f))
                 (when (and previous (not (= previous target)))
                   (hash-set! incomplete-components previous #t)
                   (hash-set! incomplete-components target #t))
                 (interval-map-set! component-at-position start end target)
                 (define occurrence (fresh-id!))
                 (hash-set! id->range occurrence (CharRange start end))
                 (hash-update! component-ranges target (lambda (ids) (cons occurrence ids)))
                 (affect! id (hash-ref name 'phase 0) target)
                 (hash-update! projected range (lambda (ids) (cons id ids)) '())]
                [else (hash-set! incomplete-components target #t)])))
        (for ([(range target) (in-hash targets)])
          (interval-map-set! component-at-position (car range) (cdr range) target)
          (hash-set! component-ranges target
                     (remove-duplicates (hash-ref component-ranges target)
                                        (lambda (a b) (equal? (hash-ref id->range a) (hash-ref id->range b))))))
        ;; Every authored identity at a projected use must have scoped evidence.
        (for ([name (in-list component-names)]
              #:when (memq (hash-ref name 'role) '(use export)))
          (define range (hash-ref name 'range))
          (define id (hash-ref name 'identifier))
          (when (and (hash-has-key? projected range)
                     (null? (mappings-for name)))
            (for ([pos (in-range (car range) (cdr range))])
              (define target (interval-map-ref component-at-position pos #f))
              (when target (hash-set! incomplete-components target #t)))))
        ;; Include every scoped binder at the edited anchor in the completeness
        ;; check, without treating its location as evidence of membership.
        (for ([name (in-list component-names)]
              #:when (eq? (hash-ref name 'role) 'definition))
          (define target (hash-ref targets (hash-ref name 'range) #f))
          (when target (affect! (hash-ref name 'identifier) (hash-ref name 'phase 0) target)))
        (for ([name (in-list component-names)]
              #:when (memq (hash-ref name 'role) '(use export)))
          (define range (hash-ref name 'range))
          (define id (hash-ref name 'identifier))
          (define mapped-targets (map car (mappings-for name)))
          (for ([target (in-list (free-id-table-ref (affected-table (hash-ref name 'phase 0)) id '()))]
                #:unless (or (member target mapped-targets)
                             (equal? (hash-ref id->range target)
                                     (CharRange (car range) (cdr range)))))
            (hash-set! incomplete-components target #t))))
      (define lexical lexical-definitions)
      (define names (hash-ref facts 'names '()))
      ;; Preserve a provider's smaller written component for the same scoped
      ;; occurrence, both here and during shared-binder disambiguation.
      (set! precise-uses (make-hash))
      (for ([name (in-list names)]
            #:when (and (eq? (hash-ref name 'role) 'use)
                        (eq? (hash-ref name 'certainty 'confirmed) 'confirmed)))
        (define id (hash-ref name 'identifier))
        (define range (hash-ref name 'range))
        (when (and (equal? (syntax-source id) (source-syntax-source source))
                   (syntax-position id) (syntax-span id)
                   (<= (sub1 (syntax-position id)) (car range) (cdr range)
                       (+ (sub1 (syntax-position id)) (syntax-span id)))
                   (< (- (cdr range) (car range)) (syntax-span id)))
          (hash-update! precise-uses
                        (list (hash-ref name 'phase 0) (syntax-position id) (syntax-span id))
                        (lambda (ids) (cons id ids)) '())))
      (define language-ranges
        (for/hash ([pending (in-list pending-module-lang-uses)])
          (values (CharRange (Pending-Module-Lang-Use-use-start pending)
                             (Pending-Module-Lang-Use-use-end pending)) #t)))
      (define resolved-bindings (make-hasheq))
      (define (key name)
        (hash-ref! resolved-bindings name
                   (lambda ()
                     (identifier-module-binding (hash-ref name 'identifier) (hash-ref name 'phase 0)
                                                file-path (hash-ref name 'space #f)))))
      (define (lexical-table name)
        (define phase (hash-ref name 'phase 0))
        (hash-ref! lexical (cons phase (hash-ref name 'space #f))
                   (lambda () (make-free-id-table #:phase phase))))
      (define (confirmed? name) (eq? (hash-ref name 'certainty 'confirmed) 'confirmed))
      (define generated-definitions (make-hash))
      (define exact-anchors (make-hash))
      (define (exact-anchor? name)
        (define range (hash-ref name 'range))
        (hash-ref! exact-anchors range
          (lambda ()
            (define text (send doc-text get-text (car range) (cdr range)))
            (or (equal? text (format "~s" (syntax-e (hash-ref name 'identifier))))
                (with-handlers ([exn:fail:read? (lambda (_) #f)])
                  (parameterize ([read-accept-reader #f] [read-accept-lang #f])
                    (define token (read-syntax #f (open-input-string text)))
                    (and (identifier? token) (equal? (syntax-position token) 1)
                         (equal? (syntax-span token) (- (cdr range) (car range))))))))))
      (for ([name (in-list names)]
            #:when (and (confirmed? name) (eq? (hash-ref name 'role) 'definition)))
        (define range (hash-ref name 'range))
        (define exact? (exact-anchor? name))
        ;; Generated coarse locations retain identities without replacing an
        ;; authored definition anchor or becoming editable definition ranges.
        (define def
          (if exact?
              (get-or-create-def (car range) (cdr range))
              (hash-ref! generated-definitions range
                (lambda ()
                  (define id (fresh-id!))
                  (hash-set! id->range id (CharRange (car range) (cdr range)))
                  (hash-set! def->use-ids id '())
                  id))))
        (define binding (key name))
        (unless exact? (hash-set! coarse-definitions (or binding def) #t))
        (cond [binding
               (when (equal? file-path (Module-Binding-filepath binding))
                 (attach-module-binding! def binding))]
              [else
               (unless (free-id-table-ref (lexical-table name) (hash-ref name 'identifier) #f)
                 (define owners (hash-ref lexical-owners def '()))
                 (define owner
                   (if (and (null? owners) (null? (def->module-bindings def)))
                       def
                       (let ([id (fresh-id!)])
                         (hash-set! id->range id (CharRange (car range) (cdr range)))
                         (hash-set! def->use-ids id '())
                         id)))
                 (hash-set! lexical-owners def (cons owner owners))
                 (unless exact? (hash-set! coarse-definitions owner #t))
                 (free-id-table-set! (lexical-table name) (hash-ref name 'identifier) owner))]))
      (set! lexical-definitions lexical)
      (define (owner-of name)
        (or (key name)
            (free-id-table-ref (lexical-table name) (hash-ref name 'identifier) #f)))
      (define resolved-at (make-hash))
      (for ([name (in-list names)]
            #:when (and (confirmed? name) (memq (hash-ref name 'role) '(use export))))
        (define binding (key name))
        (when binding
          (hash-update! resolved-at (hash-ref name 'range) (lambda (keys) (cons binding keys)) '())))
      (define (reconcile-import-shift! name owner range)
        ;; Check Syntax reports the import shift for an imported binding.
        ;; The scoped identifier supplies its declaration phase. Keep other
        ;; phased identities independently present at this same source range.
        (when (Module-Binding? owner)
          (define binding-info
            (identifier-binding (hash-ref name 'identifier) (hash-ref name 'phase 0)))
          (define import-shift (list-ref binding-info 5))
          (for ([use-id (in-list (or (use-at-exact-range (car range) (cdr range)) '()))])
            (define previous (hash-ref use->def use-id))
            (when (and (Module-Binding? previous)
                       (not (member previous (hash-ref resolved-at range '())))
                       (equal? (Module-Binding-filepath previous) (Module-Binding-filepath owner))
                       (equal? (Module-Binding-submods previous) (Module-Binding-submods owner))
                       (eq? (Module-Binding-id previous) (Module-Binding-id owner))
                       (or (equal? (Module-Binding-phase+space previous) import-shift)
                           (equal? (Module-Binding-phase+space previous)
                                   (cons import-shift (hash-ref name 'space #f)))))
              (hash-update! def->use-ids previous (lambda (ids) (remove use-id ids)))
              (link-use! use-id owner)))))
      ;; Replace only an existing occurrence of the narrowed scoped identity.
      ;; Other owners at the whole span retain their own occurrence ranges.
      (for ([name (in-list names)]
            #:when (and (positive? (hash-count precise-uses))
                        (confirmed? name) (eq? (hash-ref name 'role) 'use)))
        (define id (hash-ref name 'identifier))
        (define owner (owner-of name))
        (when (and owner (syntax-position id) (syntax-span id)
                   (member id (hash-ref precise-uses
                                        (list (hash-ref name 'phase 0)
                                              (syntax-position id) (syntax-span id)) '())))
          (define start (sub1 (syntax-position id)))
          (define end (+ start (syntax-span id)))
          (reconcile-import-shift! name owner (cons start end))
          (for ([use-id (in-list (interval-map-ref use-at-position start '()))]
                #:when (equal? (hash-ref id->range use-id) (CharRange start end)))
            (define previous (hash-ref use->def use-id))
            (when (or (equal? previous owner)
                      (equal? (def->module-bindings previous) (list owner)))
              (interval-map-update*! use-at-position start end (lambda (ids) (remove use-id ids)) '())
              (hash-update! def->use-ids previous (lambda (ids) (remove use-id ids)))
              (hash-remove! use->def use-id)
              (hash-remove! id->range use-id)
              (hash-remove! confirmed-use-ids use-id)))))
      (when (positive? (hash-count precise-uses))
        (for ([entry (in-list (dict->list use-at-position))] #:when (null? (cdr entry)))
          (interval-map-remove! use-at-position (caar entry) (cdar entry))))
      (for ([name (in-list names)]
            #:when (and (confirmed? name) (memq (hash-ref name 'role) '(use export)))
            #:unless
            (let ([id (hash-ref name 'identifier)] [range (hash-ref name 'range)])
              (and (syntax-position id) (syntax-span id)
                   (= (- (cdr range) (car range)) (syntax-span id))
                   (for/or ([precise (in-list (hash-ref precise-uses
                                                      (list (hash-ref name 'phase 0)
                                                            (syntax-position id) (syntax-span id)) '()))])
                     (free-identifier=? precise id (hash-ref name 'phase 0))))))
        (define range (hash-ref name 'range))
        (define owner (owner-of name))
        (reconcile-import-shift! name owner range)
        (define def (def-at-exact-range (car range) (cdr range)))
        (when (and owner
                   ;; A language fallback remains local unless a definition or
                   ;; an exact jump independently established this identity.
                   (or (not (Module-Binding? owner))
                       (not (hash-has-key? language-ranges (CharRange (car range) (cdr range))))
                       (hash-has-key? module-binding->def-id owner)
                       (for/or ([id (in-list (interval-map-ref use-at-position (car range) '()))])
                         (equal? owner (hash-ref use->def id))))
                   (not (and (exact-nonnegative-integer? owner)
                             (equal? (hash-ref id->range owner) (CharRange (car range) (cdr range)))))
                   (not (and def (member owner (def->module-bindings def)))))
          (remove-shared-lexical-uses! (car range))
          (define use-id (alloc-use (car range) (cdr range) owner))
          (link-use! use-id owner)
          (hash-set! confirmed-use-ids use-id #t)))
      (for ([family (in-list (hash-ref facts 'families '()))])
        (define members
          (remove-duplicates
            (filter values
                    (for/list ([member (in-list (hash-ref family 'members))])
                      (owner-of member)))))
        (for ([owner (in-list members)])
          (define previous (hash-ref binding-families owner #f))
          (when (and previous
                     (not (and (= (length previous) (length members))
                               (andmap (lambda (key) (member key previous)) members))))
            (error 'bindings "conflicting binding families"))
          (hash-set! binding-families owner members))))

    (define/public (module-bindings-at pos)
      (remove-duplicates (append-map (lambda (def) (def->module-bindings def)) (defs-at pos))))

    ;; Scalar callers must never pick an arbitrary identity at a shared range.
    (define/public (module-binding-at pos)
      (define bindings (module-bindings-at pos))
      (and (= (length bindings) 1) (car bindings)))

    ;; Export every identity at every live use range.
    (define/public (module-binding-uses)
      (remove-duplicates
        (for*/list ([(range use-ids) (in-dict use-at-position)]
                    [use-id (in-list use-ids)]
                    [module-binding (in-list (def->module-bindings (hash-ref use->def use-id)))])
          (cons (if (positive? (hash-count precise-uses))
                    (live-range-for-id use-id)
                    (CharRange (car range) (cdr range)))
                module-binding))))

    ;; Each result is (cons live-definition-range Module-Binding). Local-only
    ;; definitions are omitted; those names must not leave this document.
    (define/public (module-binding-definitions)
      (for*/list ([(module-binding def-id) (in-hash module-binding->def-id)]
                  [range (in-value (live-range-for-id def-id))]
                  #:when range)
        (cons range module-binding)))

    ;; Retain every identity for a definition range. Jumps keep their exact
    ;; Module-Binding owner, independently of target callback order.
    (define/private (attach-module-binding! def-id module-binding)
      (hash-update! def-id->module-bindings def-id
                    (lambda (bindings)
                      (if (member module-binding bindings) bindings (cons module-binding bindings)))
                    '())
      (hash-set! module-binding->def-id module-binding def-id))

    (define/override (reset)
      (set! def-at-position (make-interval-map))
      (set! use-at-position (make-interval-map))
      (set! id->range (make-hash))
      (set! def->use-ids (make-hash))
      (set! use->def (make-hash))
      (set! module-binding->def-id (make-hash))
      (set! def-id->module-bindings (make-hash))
      (set! import-alias-def-ids (make-hash))
      (set! binding-families (make-hash))
      (set! accepted-binding-facts #f)
      (set! source-bindings '())
      (set! precise-uses (make-hash))
      (set! lexical-owners (make-hash))
      (set! lexical-definitions (make-hash))
      (set! coarse-definitions (make-hash))
      (set! component-at-position (make-interval-map))
      (set! component-ranges (make-hash))
      (set! incomplete-components (make-hash))
      (set! confirmed-use-ids (make-hasheqv))
      (set! pending-module-lang-uses '())
      (position-journal-reset! range-journal))

    ;; Lexical arrows carry ranges but no names. For a shared target, use
    ;; the expanded identifier's binding to separate those arrows. This runs
    ;; in contribution-only mode too, before any queries or edits.
    (define/override (walk-stx expand-result)
      (define identified (make-hash))
      (define seen (make-hash))
      (when (and expand-result
                 (or (for/or ([bindings (in-hash-values def-id->module-bindings)])
                       (> (length bindings) 1))
                     (for/or ([ids (in-dict-values use-at-position)])
                       (> (length ids) 1))))
        (let walk ([value (ExpandResult-post-syntax expand-result)] [phase 0])
          (cond
            [(syntax? value)
             (unless (hash-ref seen (cons value phase) #f)
               (hash-set! seen (cons value phase) #t)
               (when (and file-path (identifier? value)
                          (equal? (syntax-source value) (source-syntax-source source))
                          (syntax-position value) (syntax-span value)
                          (positive? (syntax-span value)))
                 (define start (sub1 (syntax-position value)))
                 (define end (+ start (syntax-span value)))
                 (define binding (identifier-binding value phase))
                 (when (and (list? binding) (not (def-at-exact-range start end)))
                   (define module (resolve-module-path-index (car binding) file-path))
                   (define-values (path submods)
                     (match module
                       [(? path? path) (values path '())]
                       [`(submod ,(? path? path) ,submods ...) (values path submods)]
                       [_ (values #f '())]))
                   (when path
                     (define key
                       (Module-Binding (normalize-source-path path) submods
                                       (list-ref binding 4)
                                       (cadr binding)))
                     (define def (hash-ref module-binding->def-id key #f))
                     (when (and def (> (length (hash-ref def-id->module-bindings def)) 1)
                                (not (for/or ([id (in-list (hash-ref precise-uses
                                                                    (list phase (syntax-position value)
                                                                          (syntax-span value)) '()))])
                                       (free-identifier=? id value phase))))
                       (hash-update! identified (CharRange start end)
                                     (lambda (keys) (if (member key keys) keys (cons key keys)))
                                     '())))))
               (walk (syntax-property value 'disappeared-use) phase)
               (walk (syntax-property value 'origin) phase)
               ;; Inspect core bindings so quoted data and shadowed spellings do
               ;; not change the phase used to read an identifier's binding.
               (define parts (syntax->list value))
               (define head (and (pair? parts) (car parts)))
               (define binding (and (identifier? head) (identifier-binding head phase)))
               (define core
                 (and (list? binding)
                      (eq? '#%core (resolved-module-path-name (module-path-index-resolve (car binding))))
                      (cadr binding)))
               (case core
                 [(quote quote-syntax) (void)]
                 [(#%require)
                  (let walk-require ([spec value])
                    (when (syntax? spec)
                      (define parts (syntax->list spec))
                      (when (pair? parts)
                        (when (and (eq? (syntax-e (car parts)) 'rename)
                                   (= (length parts) 4))
                          (define local-id (caddr parts))
                          (when (and (equal? (syntax-source local-id) (source-syntax-source source))
                                     (syntax-position local-id) (syntax-span local-id))
                            (define start (sub1 (syntax-position local-id)))
                            (define def (def-at-exact-range start (+ start (syntax-span local-id))))
                            (when def (hash-set! import-alias-def-ids def #t))))
                        (for ([part (in-list parts)]) (walk-require part)))))]
                 [(module module*)
                  (for ([part (in-list (cdddr parts))])
                    (walk part (if (syntax-e (caddr parts)) 0 phase)))]
                 [(begin-for-syntax)
                  (for ([part (in-list (cdr parts))]) (walk part (add1 phase)))]
                 [(define-syntaxes)
                  (walk (cadr parts) phase)
                  (walk (caddr parts) (add1 phase))]
                 [else (walk (syntax-e value) phase)]))]
            [(pair? value) (walk (car value) phase) (walk (cdr value) phase)])))
      (for ([(range bindings) (in-hash identified)])
        (define start (CharRange-start range))
        (define end (CharRange-end range))
        ;; Expanded identifiers also cover shared bindings whose generated
        ;; Check Syntax arrows were absent or used the binder's shorter span.
        (remove-shared-lexical-uses! start)
        (for ([binding (in-list bindings)])
          (link-use! (alloc-use start end binding) binding)))
      (apply-pending-module-lang-uses!)
      ;; Resolve scoped identities before releasing the expansion and its syntax
      ;; properties. Later service queries need only names, keys and source data.
      (when (and accepted-binding-facts (not (current-retain-binding-facts?)))
        (define facts accepted-binding-facts)
        (cond
          [contribution-only? (set! accepted-binding-facts (hasheq))]
          [else
           (define tables (make-hash))
           (define next-identity 0)
           (define (identity name)
             (define phase (hash-ref name 'phase 0))
             (define table (hash-ref! tables (cons phase (hash-ref name 'space #f))
                                     (lambda () (make-free-id-table #:phase phase))))
             (define id (hash-ref name 'identifier))
             (or (free-id-table-ref table id #f)
                 (let ([key next-identity])
                   (set! next-identity (add1 next-identity))
                   (free-id-table-set! table id key)
                   key)))
           (set! source-bindings (confirmed-source-bindings facts (send doc-text get-text) identity))
           (define kinds
             (for/hasheqv ([binding (in-list source-bindings)])
               (values (hash-ref binding 'identity) (hash-ref binding 'kind))))
           (set! accepted-binding-facts
                 (hasheq
                  'regions (hash-ref facts 'regions '())
                  'binders
                  (for/list ([binder (in-list (hash-ref facts 'binders '()))])
                    (hasheq 'name (syntax-e (hash-ref binder 'identifier))
                            'authored? (hash-ref binder 'authored? #t)))
                  'names
                  (for/list ([name (in-list (hash-ref facts 'names '()))])
                    (hasheq 'name (syntax-e (hash-ref name 'identifier))
                            'identity (identity name) 'kind (hash-ref kinds (identity name) #f)
                            'range (hash-ref name 'range)
                            'role (hash-ref name 'role) 'certainty (hash-ref name 'certainty 'confirmed)))))]))
      (set! lexical-definitions (make-hash))
      ;; Queries only need to know whether narrowed occurrences were installed.
      (set! precise-uses (if (positive? (hash-count precise-uses)) (make-hash '((narrowed . #t)))
                            (make-hash))))

    (define/override (text-replaced start end)
      (set! accepted-binding-facts #f)
      (set! source-bindings '()))

    (define/override (expand start end)
      (set! accepted-binding-facts #f)
      (set! source-bindings '())
      ;; Typing inside a name must stay one occurrence. Do not use the
      ;; interval-map default, which splits the range.
      (interval-map-expand/policy! component-at-position start end #:interior 'extend)
      (interval-map-expand/policy! def-at-position start end #:interior 'extend)
      (interval-map-expand/policy! use-at-position start end #:interior 'extend)
      (position-journal-record-expand! range-journal start end))

    (define/override (contract start end)
      (set! accepted-binding-facts #f)
      (set! source-bindings '())
      ;; Do not rewrite id->range here. Position maps shrink or drop ranges now.
      ;; Queries replay range-journal to move snapshot CharRanges.
      (interval-map-contract! component-at-position start end)
      (interval-map-contract! def-at-position start end)
      (interval-map-contract! use-at-position start end)
      (position-journal-record-contract! range-journal start end))

    (define/override (syncheck:add-jump-to-definition/phase-level+space
                       _src-obj start end id filename submods phase+space)
      (define normalized-end (normalize-end start end))
      ;; Check Syntax paths use the expansion's load directory when relative.
      (define binding-path
        (normalize-source-path
          (path->complete-path filename
                               (or (current-load-relative-directory) (current-directory)))))
      (define module-binding (Module-Binding binding-path submods phase+space id))
      (define use-id (alloc-use start normalized-end module-binding))
      (link-use! use-id module-binding))

    (define/override (syncheck:add-definition-target/phase-level+space
                       _src-obj start end id submods phase+space)
      (define normalized-end (normalize-end start end))
      (define def-id (get-or-create-def start normalized-end))
      ;; Virtual declarations remain local; only files have cross-file bindings.
      (when file-path
        (define module-binding (Module-Binding file-path submods phase+space id))
        (attach-module-binding! def-id module-binding)))

    (define/override (syncheck:unused-binder _src-obj start end)
      ;; This callback can still supply the only usable range for an unused
      ;; binder. Scoped facts and module definitions reuse the same range.
      (get-or-create-def start (normalize-end start end))
      (void))

    (define/override (syncheck:add-arrow/name-dup _start-src-obj start-left start-right
                                                  _end-src-obj end-left end-right
                                                  _actual? phase-level
                                                  require-arrow? _name-dup?)
      (match require-arrow?
        [#f
         (define def-id (get-or-create-def start-left (normalize-end start-left start-right)))
         (define use-id (alloc-use end-left (normalize-end end-left end-right) def-id))
         (link-use! use-id def-id)]
        ['module-lang
         ;; Chosen over `normalize-end`: a zero-width report means disappeared
         ;; syntax, not a one-character name. Keep punctuation ranges that
         ;; Check Syntax reported, such as quote.
         (when (< end-left end-right)
           (define key
             (Module-Lang-Use-Key start-left
                                  start-right
                                  phase-level
                                  (send doc-text get-text end-left end-right)))
           (set! pending-module-lang-uses
                 (cons (Pending-Module-Lang-Use key end-left end-right)
                       pending-module-lang-uses)))]
        [_
         ;; Ordinary require arrows are ignored. Imported uses come from
         ;; syncheck:add-jump-to-definition.
         (void)]))))
