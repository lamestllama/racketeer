#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Rename is a proposed edit over one immutable workspace snapshot. Expansion
;; validates the proposal in memory; neither source files nor editor buffers are
;; changed here. Binding queries come from the same analyser as the index.
(require racket/class
         racket/list
         racket/match
         racket/path
         racket/promise
         racket/set
         racket/string
         drracket/check-syntax
         racket-langserver/common/source
         racket-langserver/common/source-snapshot
         syntax/modresolve
         syntax/modcollapse
         racket-langserver/common/interfaces
         racket-langserver/common/path-util
         racket-langserver/common/json-util
         racket-langserver/doclib/doc
         racket-langserver/doclib/doc-trace
         racket-langserver/doclib/check-syntax
         racket-langserver/doclib/internal-types
         racket-langserver/doclib/lexer)

(provide workspace-rename current-analysis-observer)

;; Told each file before its analysis begins, for a worker that must be able to
;; say which file it was analysing when it was stopped.
(define current-analysis-observer (make-parameter void))

(struct Source (doc forms arrows bindings) #:transparent)
(struct Arrow (from to imported?) #:transparent)

(define (refuse message)
  (error 'rename message))

(define (identifier-name text)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (define in (open-input-string text))
    (define value (read in))
    (and (symbol? value) (eof-object? (read in))
         ;; Keep the edit a single identifier, without reader directives,
         ;; comments, leading whitespace, or a changed spelling convention.
         (equal? text (format "~s" value)) value)))

(define (in-snapshot path sources proc)
  (parameterize ([current-namespace (make-base-namespace)]
                 [current-directory (path-only path)]
                 [current-load-relative-directory (path-only path)])
    (call-with-source-snapshot sources proc)))

(define (analyse path sources)
  ((current-analysis-observer) path)
  (in-snapshot path sources
    (lambda ()
      (define text (hash-ref sources path))
      (define doc (make-doc (path->uri path) text))
      (define buffer (doc-copy-text-buffer doc))
      (define lexer (build-lexer-state text (Doc-uri doc)))
      (define arrows (make-hasheqv))
      (define trace
        (new (class build-trace%
               (super-new)
               (define/override (syncheck:add-arrow/name-dup/pxpy from left right px py
                                                                to start end qx qy actual? phase imported? dup?)
                 (when (and actual? (equal? from path) (equal? to path))
                   (hash-update! arrows end
                                 (lambda (at-end) (cons (Arrow (cons left right) (cons start end) imported?) at-end))
                                 '()))
                 (super syncheck:add-arrow/name-dup/pxpy from left right px py
                        to start end qx qy actual? phase imported? dup?)))
             [source (path->source path)] [doc-text buffer] [lexer-state lexer]))
      (define expand? (Language-Policy-expand? (LexerState-language-policy lexer)))
      (define result (expand-source (path->source path) (open-input-string text) trace #:expand? expand?))
      (unless (and (ExpandResult-pre-syntax result)
                   (or (not expand?) (ExpandResult-post-syntax result)))
        (refuse (format "Cannot analyse ~a with the proposed names and current buffers." path)))
      (send trace walk-stx result)
      (send trace walk-log (ExpandResult-logs result))
      (doc-update-trace! doc trace (send trace get-contribution) (Doc-version doc))
      ;; Keep source and origin identifiers, not the whole expansion result
      ;; and the module namespaces it retains, while other files are analysed.
      (define original (ExpandResult-pre-syntax result))
      (define contexts (expansion-contexts (ExpandResult-post-syntax result) path))
      (Source doc (delay (standard-imports doc original contexts path)) arrows
              (expansion-bindings doc (ExpandResult-post-syntax result) path)))))

;; Source identifiers in the expansion retain their defining module and phase,
;; including references that Check Syntax cannot attach to relative imports.
;; One written name can carry several bindings, as when Rhombus's fun binds the
;; function and a generated helper at its name, so each range keeps them all.
(define (expansion-bindings doc expanded file)
  (define bindings (make-hash))
  (define text (doc-get-text doc))
  (define seen (make-hash))
  (define (walk value phase)
    (cond
      [(syntax? value)
       (unless (hash-ref seen (cons value phase) #f)
         (hash-set! seen (cons value phase) #t)
         (define range (and (identifier? value) (source-range value file)))
         (when (and range (<= 0 (car range) (cdr range) (string-length text))
                    (equal? (substring text (car range) (cdr range)) (format "~s" (syntax-e value))))
           (define binding (identifier-binding value phase))
           (when (and (list? binding) (= (length binding) 7))
             (define module (resolve-module-path-index (car binding) file))
             (define path (if (pair? module) (cadr module) module))
             (when (path? path)
               (define export-phase (list-ref binding 6))
               (define normalized
                 (Module-Binding path (if (pair? module) (cddr module) '())
                   (if (pair? export-phase) (cons (list-ref binding 4) (cdr export-phase)) (list-ref binding 4))
                   (cadr binding)))
               (hash-update! bindings range (lambda (old) (set-add old normalized)) (set)))))
         (define parts (syntax->list value))
         (define head (and (pair? parts) (syntax-e (car parts))))
         (case head
           [(quote quote-syntax #%require) (void)]
           [(#%provide) (for-each (lambda (part) (walk-provide part phase)) (cdr parts))]
           [(module module*) (for-each (lambda (part) (walk part 0)) (cdddr parts))]
           [(begin-for-syntax) (for-each (lambda (part) (walk part (add1 phase))) (cdr parts))]
           [(define-syntaxes) (walk (cadr parts) phase) (walk (caddr parts) (add1 phase))]
           [else (walk (syntax-e value) phase)]))]
      [(pair? value) (walk (car value) phase) (walk (cdr value) phase)]))
  (define (walk-provide spec phase)
    (cond
      [(identifier? spec) (walk spec phase)]
      [else
       (define parts (syntax->list spec))
       (when (pair? parts)
         (case (syntax-e (car parts))
           [(rename) (walk (cadr parts) phase)]
           [(for-meta)
            (define shift (syntax-e (cadr parts)))
            (when (and phase shift)
              (for-each (lambda (part) (walk-provide part (+ phase shift))) (cddr parts)))]
           [(protect for-space)
            (for-each (lambda (part) (walk-provide part phase))
                      (if (eq? (syntax-e (car parts)) 'for-space) (cddr parts) (cdr parts)))]))]))
  (walk expanded 0)
  bindings)

(define (source-bindings-at source position)
  (define doc (Source-doc source))
  (define occurrence (doc-occurrence-at doc position))
  (or (and occurrence (hash-ref (Source-bindings source) (absolute-range doc occurrence) #f))
      (let ([binding (doc-module-binding-at doc position)])
        (if binding (set binding) (set)))))

;; Only the identifier being renamed must name one binding.
(define (source-binding-at source position)
  (define bindings (source-bindings-at source position))
  (when (> (set-count bindings) 1) (refuse "This source identifier represents more than one binding."))
  (and (= (set-count bindings) 1) (set-first bindings)))

(define (absolute-range doc range)
  (cons (doc-pos->abs-pos doc (Range-start range))
        (doc-pos->abs-pos doc (Range-end range))))

(define (contains-range? outer inner)
  (and (<= (car outer) (car inner)) (<= (cdr inner) (cdr outer))))

;; An explicit import alias has both a local binding arrow and a module
;; identity. Prefer its local binding when renaming an alias or its uses.
(define (alias-at source range)
  (define doc (Source-doc source))
  (for/or ([arrow (in-list (hash-ref (Source-arrows source) (cdr range) '()))]
           #:when (and (not (Arrow-imported? arrow)) (equal? range (Arrow-to arrow))))
    (define from (Arrow-from arrow))
    (define pos (doc-abs-pos->pos doc (car from)))
    (and (not (doc-module-binding-at doc pos)) (doc-definition-at doc pos) from)))

(struct ImportName (name alias anchor active? relevant?) #:transparent)
(struct ImportPlan (selectors names) #:transparent)

;; Import arrows distinguish equal spellings introduced by different forms.
(define (matching-imports source range text plan)
  (for/list ([name (in-list (ImportPlan-names plan))]
             #:when (and (ImportName-relevant? name) (equal? text (ImportName-name name))
                         (for/or ([arrow (in-list (hash-ref (Source-arrows source) (cdr range) '()))])
                           (and (Arrow-imported? arrow)
                                (contains-range? (ImportName-anchor name) (Arrow-from arrow))))))
    name))

(define (imported-range source text range name plan)
  (or (for/or ([arrow (in-list (hash-ref (Source-arrows source) (cdr range) '()))]
                #:when (and (Arrow-imported? arrow) (contains-range? range (Arrow-to arrow))))
        (define use (Arrow-to arrow))
        (and (equal? (substring text (car use) (cdr use)) name) use))
      (and (for/or ([entry (in-list (matching-imports source range (substring text (car range) (cdr range)) plan))])
             (ImportName-active? entry))
           (cons (- (cdr range) (string-length name)) (cdr range)))))

(define (source-range stx file)
  (and (equal? (syntax-source stx) file) (syntax-position stx) (syntax-span stx)
       (cons (sub1 (syntax-position stx)) (+ (sub1 (syntax-position stx)) (syntax-span stx)))))

(define (resolved-import spec file base)
  (define datum (syntax->datum spec))
  (and (module-path? datum)
       (resolve-module-path (collapse-module-path datum base) file)))

(define (target-module target)
  (if (null? (Module-Binding-submods target)) (Module-Binding-filepath target)
      `(submod ,(Module-Binding-filepath target) ,@(Module-Binding-submods target))))

(struct ExpansionContext (identifier module) #:transparent)

(define (expansion-contexts expanded file)
  (define contexts (make-hash))
  (define seen (make-hasheq))
  (define (origin value module)
    (cond
      [(identifier? value)
       (define range (source-range value file))
       (when range
         (define context (ExpansionContext value module))
         (hash-update! contexts range
           (lambda (prior)
             (if (and (ExpansionContext? prior)
                      (equal? module (ExpansionContext-module prior))
                      (bound-identifier=? (ExpansionContext-identifier prior) value)) prior 'ambiguous)) context))]
      [(pair? value) (origin (car value) module) (origin (cdr value) module)]))
  (define (origins value modules [root? #f])
    (cond
      [(syntax? value)
       (unless (hash-ref seen value #f)
         (hash-set! seen value #t)
         (origin (syntax-property value 'origin) (if (null? modules) file `(submod ,file ,@modules)))
         (define parts (syntax->list value))
         (if (and (pair? parts) (memq (syntax-e (car parts)) '(module module*)))
             (for-each (lambda (part) (origins part (if root? modules (append modules (list (syntax-e (cadr parts)))))))
                       (cdddr parts))
             (origins (syntax-e value) modules)))]
      [(pair? value) (origins (car value) modules) (origins (cdr value) modules)]))
  (origins expanded '() #t)
  contexts)

;; Retain original import syntax only for an actual expansion of a standard
;; transformer. A binding alone can also occur in an unused syntax template.
(define (standard-imports doc original contexts file)
  (define found '())
  (define transformers
    (for/list ([id (in-list (list #'only-in #'except-in #'rename-in #'prefix-in #'combine-in))])
      (define binding (identifier-binding id))
      (cons (resolve-module-path-index (car binding) file) (cadr binding))))
  (define (walk stx [scoped? #f] [module file])
    (when (syntax? stx)
      (define parts (syntax->list stx))
      (when (pair? parts)
        (define head (car parts))
        (define range (source-range head file))
        (define context (and (not scoped?) (hash-ref contexts range #f)))
        (define binding (and (not scoped?) range (identifier? head)
                             (doc-module-binding-at doc (doc-abs-pos->pos doc (car range)))))
        (define identity
          (if scoped?
              (let ([binding (and (identifier? head) (identifier-binding head 0))])
                (and (list? binding) (cons (resolve-module-path-index (car binding) file) (cadr binding))))
              (and binding (cons (Module-Binding-filepath binding) (Module-Binding-id binding)))))
        (cond
          [(and identity (>= (length parts) 2) (member identity transformers) (or scoped? context))
           (when (eq? context 'ambiguous) (refuse "This import has more than one expansion context."))
           (define phase (and binding (Module-Binding-phase+space binding)))
           (define transfer? (and context (exact-integer? phase)))
           (define base (if context (ExpansionContext-module context) module))
           (define operands
             (cdr (if transfer?
                      (syntax->list
                       ((make-syntax-delta-introducer (ExpansionContext-identifier context) head phase) stx))
                      parts)))
           (set! found (cons (list (cdr identity) operands base) found))
           ;; Only a standard transformer's require-spec operand shares this
           ;; context. An arbitrary transformer may interpret its operands.
           (for ([child (in-list (case (cdr identity)
                                  [(prefix-in) (list (cadr operands))]
                                  [(combine-in) operands]
                                  [else (list (car operands))]))])
             (walk child (or scoped? transfer?) base))]
          [(not scoped?) (for-each walk parts)]))))
  (walk original)
  found)

;; Interpret only proven standard forms. Each name carries its explicit alias
;; and import source, so prefixes and selector compositions share one rule.
(define (import-plan source file sources target [alias #f])
  (define selectors '())
  (define exports (make-hash))
  (define old-name (if alias (substring (hash-ref sources file) (car alias) (cdr alias))
                       (symbol->string (Module-Binding-id target))))
  (define (selector! id entry)
    (when (ImportName-active? entry)
      (define range (source-range id file))
      (unless (and range (string-suffix? (symbol->string (syntax-e id)) old-name))
        (refuse "This import selector has no unambiguous source spelling."))
      (set! selectors (cons (cons (- (cdr range) (string-length old-name)) (cdr range)) selectors))))
  (define (walk spec base)
    (define module (resolved-import spec file base))
    (cond
      [module
       (define relevant? (equal? module (target-module target)))
       (define names
         (if relevant? (list (Module-Binding-id target))
             (hash-ref! exports module
               (lambda ()
                 (unless (module-declared? module #t) (refuse "Cannot inspect the module's exports."))
                 (define-values (variables syntax) (module->exports module))
                 (remove-duplicates (for*/list ([group (in-list (append variables syntax))]
                                               [entry (in-list (cdr group))]) (car entry)))))))
       (for/list ([name (in-list names)])
         (ImportName (symbol->string name) #f
                     (or (source-range spec file) (refuse "This import has no editable source location."))
                     (and relevant? (not alias)) relevant?))]
      [else
       (define parts (syntax->list spec))
       (define head (and (pair? parts) (car parts)))
       (define kind (and (identifier? head)
                         (for/or ([id (in-list (list #'only-in #'except-in #'rename-in #'prefix-in #'combine-in))])
                           (and (free-identifier=? head id) (syntax-e id)))))
       (unless kind (refuse "This custom import transformer cannot be renamed safely."))
       (interpret kind (cdr parts) base)]))
  (define (interpret kind operands base)
    (case kind
      [(prefix-in)
       (for/list ([entry (in-list (walk (cadr operands) base))])
         (struct-copy ImportName entry [name (string-append (symbol->string (syntax-e (car operands))) (ImportName-name entry))]))]
      [(combine-in) (append-map (lambda (spec) (walk spec base)) operands)]
      [else
       (define names (walk (car operands) base))
       (define selected (make-hash))
       (for ([selector (in-list (cdr operands))])
         (define pair (syntax->list selector))
         (define id (if pair (car pair) selector))
         (define name (symbol->string (syntax-e id)))
         (define matches (filter (lambda (entry) (equal? name (ImportName-name entry))) names))
         (when (and (ormap ImportName-active? matches)
                    (or (ormap (lambda (entry) (not (ImportName-relevant? entry))) matches)
                        (and alias (ormap (lambda (entry) (not (ImportName-active? entry))) matches))))
           (refuse "This import selector refers to more than one binding."))
         (for ([entry (in-list matches)]) (selector! id entry))
         (hash-set! selected name (if pair (cadr pair) #t)))
       (for/list ([entry (in-list names)]
                   #:when (if (eq? kind 'only-in) (hash-has-key? selected (ImportName-name entry))
                              (or (not (eq? kind 'except-in)) (not (hash-has-key? selected (ImportName-name entry))))))
         (define chosen (hash-ref selected (ImportName-name entry) #f))
         (if (syntax? chosen)
             (let ([range (source-range chosen file)])
               (when (and alias (equal? alias range)) (set! selectors (cons range selectors)))
               (struct-copy ImportName entry [name (symbol->string (syntax-e chosen))] [alias range]
                 [active? (and (ImportName-relevant? entry) alias (equal? alias range))]))
             entry))]))
  (in-snapshot file sources
    (lambda ()
      (define names
        (append-map (lambda (form) (interpret (car form) (cadr form) (caddr form))) (force (Source-forms source))))
      (ImportPlan selectors names))))

;; Import selectors name exports, which can differ from local definitions and
;; can select several phases at once. Query declared modules without running
;; their bodies, using the same immutable source loader as expansion.
(define (selector-status target sources)
  (define path (Module-Binding-filepath target))
  (in-snapshot path sources
    (lambda ()
      (define module `(submod (file ,(path->string path)) ,@(Module-Binding-submods target)))
      (unless (module-declared? module #t) (refuse "Cannot inspect the module's exports."))
      (define-values (variables syntax) (module->exports module 'defined-names))
      (define exports
        (for*/list ([group (in-list (append variables syntax))]
                    [entry (in-list (cdr group))]
                    #:when (equal? (car entry) (Module-Binding-id target)))
          (cons (car group) (cdr entry))))
      (and (member (list (Module-Binding-phase+space target) '() (Module-Binding-id target)) exports)
           (if (= (length exports) 1) 'local 'shared)))))

(define (renamed-text text ranges name)
  (for/fold ([text text]) ([range (in-list (reverse ranges))])
    (string-append (substring text 0 (car range)) name (substring text (cdr range)))))

;; Compare every source identifier's binding before and after the edit. This
;; detects both capture of a renamed use and capture of an unchanged use by the
;; new name, including unused binders that have no Check Syntax arrow.
(define (bindings source text ranges new-name target)
  (define doc (Source-doc source))
  (define (shift offset)
    (+ offset (for/sum ([range (in-list ranges)] #:when (<= (cdr range) offset))
                (- (string-length new-name) (- (cdr range) (car range))))))
  (for/list ([token (in-lexer-snapshot (build-lexer-snapshot text (Doc-uri doc)))]
             #:when (eq? (LexerEntry-type token) 'symbol))
    (define position (doc-abs-pos->pos doc (LexerEntry-start token)))
    (define module-bindings (source-bindings-at source position))
    (define local-definition (and (set-empty? module-bindings) (doc-definition-at doc position)))
    (list (shift (LexerEntry-start token)) (shift (LexerEntry-end token))
          (cond
            [(not (set-empty? module-bindings))
             (for/set ([binding (in-set module-bindings)])
               (if (equal? binding target)
                   (struct-copy Module-Binding binding [id (identifier-name new-name)])
                   binding))]
            [local-definition
             (define range (absolute-range doc local-definition))
             (cons (shift (car range)) (shift (cdr range)))]
            [else #f]))))

(define (workspace-rename sources path position new-name)
  (unless (hash-has-key? sources path)
    (refuse "Save this document inside the analysed workspace before renaming."))
  (define origin-source (analyse path sources))
  (define origin (Source-doc origin-source))
  (define pos (jsexpr->Pos position))
  (define occurrence (doc-occurrence-at origin pos))
  (define module-target (source-binding-at origin-source pos))
  (define origin-plan
    (and module-target (import-plan origin-source path sources module-target)))
  (define matched-imports
    (if (and occurrence origin-plan)
        (let ([range (absolute-range origin occurrence)])
          (matching-imports origin-source range (substring (hash-ref sources path) (car range) (cdr range)) origin-plan))
        '()))
  (define aliases (remove-duplicates (filter-map ImportName-alias matched-imports)))
  (when (> (length aliases) 1) (refuse "This name has more than one local import alias."))
  (define alias (or (and (pair? aliases) (car aliases))
                    (and occurrence (alias-at origin-source (absolute-range origin occurrence)))))
  (define target (and (not alias) module-target))
  (define definition (doc-definition-at origin pos))
  (unless (and occurrence (or target definition alias))
    (refuse "This location has no editable binding."))
  (when (and target (not (hash-has-key? sources (Module-Binding-filepath target))))
    (refuse "The definition is outside the analysed workspace."))
  (define source-range (absolute-range origin occurrence))
  (when (and alias (pair? matched-imports))
    (set! source-range (cons (- (cdr source-range) (- (cdr alias) (car alias))) (cdr source-range))))
  (when target
    (set! source-range
          (or (imported-range origin-source (hash-ref sources path) source-range
                              (symbol->string (Module-Binding-id target)) origin-plan) source-range)))
  (define old-name (substring (hash-ref sources path) (car source-range) (cdr source-range)))
  (unless (identifier-name old-name)
    (refuse "This generated or escaped identifier cannot be renamed safely."))
  (when (and target (not (equal? (identifier-name old-name) (Module-Binding-id target))))
    (refuse "This exported alias has no editable local binding."))
  (cond
    [(not new-name) (->jsexpr (Range (doc-abs-pos->pos origin (car source-range))
                                   (doc-abs-pos->pos origin (cdr source-range))))]
    [(equal? old-name new-name) (hasheq 'changes (hasheq))]
    [else
     (unless (identifier-name new-name) (refuse "Enter a single Racket identifier."))
     (define docs
       (for/hash ([(file text) (in-hash sources)])
         (values file (if (equal? file path) origin-source (analyse file sources)))))
     (define target-definitions
       (and target (Doc-Contribution-definitions
                    (Doc-contribution (Source-doc (hash-ref docs (Module-Binding-filepath target)))))))
     (when target
       (unless (hash-has-key? target-definitions target)
         (refuse "The binding has no unambiguous editable definition in this workspace.")))
     (define selector-kind (delay (selector-status target sources)))
     (define edits
       (for/hash ([(file source) (in-hash docs)])
         (define doc (Source-doc source))
         (define text (hash-ref sources file))
         (define plan
           (cond [target (if (equal? file path) origin-plan (import-plan source file sources target))]
                 [(and alias module-target (equal? file path)) (import-plan source file sources module-target alias)]
                 [else (ImportPlan '() '())]))
         (define candidates (ImportPlan-selectors plan))
         (define selectors
           (cond
             [(null? candidates) '()]
             [(not target) candidates]
             [else
              (case (force selector-kind)
                [(local) candidates]
                [(shared) (refuse "This import selector refers to more than one phase or binding space.")]
                [else '()])]))
         (define contribution (Doc-contribution doc))
         (define locations
           (cond
             [(or target (and alias module-target (equal? file path)))
              (define queried (or target module-target))
              (define declaration (and target (hash-ref (Doc-Contribution-definitions contribution) target #f)))
              (append (if declaration (list (Location-range declaration)) '())
                      (for/list ([(range bindings) (in-hash (Source-bindings source))]
                                  #:when (set-member? bindings queried))
                        (Range (doc-abs-pos->pos doc (car range)) (doc-abs-pos->pos doc (cdr range))))
                      (for*/list ([locations (in-hash-values (Doc-Contribution-references contribution))]
                                  [location (in-list locations)]
                                  #:when (set-member? (source-bindings-at source (Range-start (Location-range location))) queried))
                        (Location-range location)))]
             [(equal? file path) (doc-binding-ranges-at doc (if alias (doc-abs-pos->pos doc (car alias)) pos))]
             [else '()]))
         (define ranges
           (sort (remove-duplicates
                  (append selectors
                          (filter-map
                           (lambda (location)
                             (define range (absolute-range doc location))
                             (define matches (matching-imports source range (substring text (car range) (cdr range)) plan))
                             (and (not (and target (or (alias-at source range)
                                                       (ormap ImportName-alias matches)
                                                       (for/or ([entry (in-list (ImportPlan-names plan))])
                                                         (equal? range (ImportName-alias entry))))))
                                  (or (and alias module-target
                                           (for/or ([entry (in-list matches)]) (ImportName-active? entry))
                                           (cons (- (cdr range) (string-length old-name)) (cdr range)))
                                      (and (not target) (not module-target) range)
                                      (and (equal? (substring text (car range) (cdr range)) old-name) range)
                                      (and target (imported-range source text range old-name plan)))))
                           locations))) < #:key car))
         (for ([range (in-list ranges)])
           (unless (equal? (substring (hash-ref sources file) (car range) (cdr range)) old-name)
             (refuse "This binding has generated source spellings that cannot be renamed safely.")))
         (for ([left (in-list ranges)] [right (in-list (if (pair? ranges) (cdr ranges) '()))])
           (when (> (cdr left) (car right)) (refuse "The binding has overlapping source locations.")))
         (values file ranges)))
     (define proposed
       (for/hash ([(file text) (in-hash sources)])
         (values file (renamed-text text (hash-ref edits file) new-name))))
     (for ([(file source) (in-hash docs)])
       (define after (analyse file proposed))
       (unless (equal? (bindings source (hash-ref sources file) (hash-ref edits file) new-name target)
                       (bindings after (hash-ref proposed file) '() new-name #f))
         (refuse (format "Renaming would change another binding or requires unsupported import edits in ~a." file))))
     (hasheq 'changes
             (for/hasheq ([(file ranges) (in-hash edits)] #:unless (null? ranges))
               (define doc (Source-doc (hash-ref docs file)))
               (values (string->symbol (path->uri file))
                       (for/list ([range (in-list ranges)])
                         (->jsexpr (TextEdit #:range (Range (doc-abs-pos->pos doc (car range))
                                                         (doc-abs-pos->pos doc (cdr range)))
                                            #:newText new-name))))))]))
