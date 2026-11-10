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
         "runtime/racketdap/tools/source-snapshot.rkt"
         syntax/modread
         syntax/modresolve
         syntax/modcollapse
         racket-langserver/common/interfaces
         racket-langserver/common/path-util
         racket-langserver/common/json-util
         racket-langserver/doclib/doc
         racket-langserver/doclib/textbuffer/text-port
         (only-in racket-langserver/doclib/language-adapter source-language-adapter
                  current-language-adapter-validator current-language-adapter-rename
                  current-language-adapter-bindings)
         racket-langserver/doclib/doc-trace
         racket-langserver/doclib/check-syntax
         (except-in racket-langserver/doclib/rename-validation rename-module-binding)
         (prefix-in base: (only-in racket-langserver/doclib/rename-validation rename-module-binding))
         (only-in racket-langserver/doclib/service/declaration current-retain-binding-facts?)
         (only-in racket-langserver/doclib/binding-facts identifier-module-binding)
         racket-langserver/doclib/expanded-core
         racket-langserver/doclib/internal-types
         racket-langserver/doclib/lexer
         (only-in racket-langserver/doclib/lexer/state lexer-state-apply-adapter!))

(provide workspace-rename current-analysis-observer)

;; Told each file before its analysis begins, for a worker that must be able to
;; say which file it was analysing when it was stopped.
(define current-analysis-observer (make-parameter void))

(struct Source (doc forms arrows bindings snapshot facts scan) #:transparent)
(struct Arrow (from to imported?) #:transparent)

(define (refuse message)
  (error 'rename message))

(define (in-snapshot path sources proc)
  (parameterize ([current-namespace (make-base-namespace)]
                 [current-directory (path-only path)]
                 [current-load-relative-directory (path-only path)])
    (call-with-source-snapshot sources proc)))

(define (rename-module-binding fact [provider? #f])
  (if provider? (hash-ref fact 'binding #f) (base:rename-module-binding fact)))

(define (analyse path sources [paths (make-hash)] [scan-provider 'source])
  ((current-analysis-observer) path)
  (in-snapshot path sources
    (lambda ()
      (define text (hash-ref sources path))
      (define doc (make-doc (path->uri path) text))
      (define buffer (doc-copy-text-buffer doc))
      (define lexer (build-lexer-state text (Doc-uri doc)))
      (define arrows (make-hasheqv))
      (define provider-names (make-hash))
      (define resolve-bindings (current-language-adapter-bindings))
      (define (recording-bindings adapter)
        (define provider (resolve-bindings adapter))
        (and provider
             (lambda (request)
               (define result (provider request))
               ;; Explicit provider names assert scoped occurrences at their
               ;; supplied ranges, even beside a different core binder.
               (when (hash? result)
                 (for ([name (in-list (hash-ref result 'names '()))])
                   (hash-set! provider-names (hash-remove name 'binding) #t)))
               result)))
      (define trace
        (new (class build-trace%
               (super-new)
               (define/override (add-binding-facts facts)
                 (define native? (and (LexerState-adapter lexer)
                                      ((current-language-adapter-rename) (LexerState-adapter lexer))))
                 (define local-ranges
                   (for/set ([binder (in-list (hash-ref facts 'binders))]
                             #:when (eq? (identifier-binding (hash-ref binder 'identifier) (hash-ref binder 'phase 0)) 'lexical))
                     (source-range (hash-ref binder 'identifier) path)))
                 (define module-ranges
                   (for/set ([binder (in-list (hash-ref facts 'binders))] #:when (hash-ref binder 'binding #f))
                     (source-range (hash-ref binder 'identifier) path)))
                 (super add-binding-facts
                        (if native?
                            (hash-set facts 'names
                              (filter (lambda (name)
                                        ;; A parsed binder's old transformer context
                                        ;; is not a use of that outer binding.
                                        (not (and (not (hash-ref provider-names (hash-remove name 'binding) #f))
                                                  (set-member? local-ranges (hash-ref name 'range))
                                                  (not (set-member? module-ranges (hash-ref name 'range)))
                                                  (hash-ref name 'binding #f))))
                                      (hash-ref facts 'names)))
                            facts)))
               (define/override (syncheck:add-arrow/name-dup/pxpy from left right px py
                                                                to start end qx qy actual? phase imported? dup?)
                 (when (and actual? (equal? from path) (equal? to path))
                   (hash-update! arrows end
                                 (lambda (at-end) (cons (Arrow (cons left right) (cons start end) imported?) at-end))
                                 '()))
                 (super syncheck:add-arrow/name-dup/pxpy from left right px py
                        to start end qx qy actual? phase imported? dup?)))
             [source (path->source path)] [doc-text buffer] [lexer-state lexer]
             [contribution-only? #t]))
      (define expand? (Language-Policy-expand? (LexerState-language-policy lexer)))
      (define native-port?
        (and (string-contains? text "\r\n")
             (let ([adapter (source-language-adapter (path->source path) text
                                                     (with-module-reading-parameterization
                                                       (lambda () (read-syntax path (open-input-text text)))))])
               (and adapter ((current-language-adapter-validator) adapter)
                    ((current-language-adapter-rename) adapter)))))
      (define result
        (parameterize ([current-language-adapter-bindings recording-bindings])
          (expand-source (path->source path) ((if native-port? open-input-text open-input-string) text) trace #:expand? expand?
                       #:contribution-only? #t
                       #:on-adapter (lambda (adapter)
                                      (when (and adapter ((current-language-adapter-rename) adapter))
                                        (lexer-state-apply-adapter! lexer adapter))))))
      ;; Not a fault in the file, so it is not reported as one below.
      (for ([problem (in-list (list (ExpandResult-pre-exn result) (ExpandResult-post-exn result)))])
        (when (exn:fail:out-of-memory? problem) (raise problem)))
      (unless (and (ExpandResult-pre-syntax result)
                   (or (not expand?) (ExpandResult-post-syntax result)))
        (refuse (format "Cannot analyse ~a with the proposed names and current buffers." path)))
      (parameterize ([current-retain-binding-facts? #t])
        (send trace walk-stx result))
      (send trace walk-log (ExpandResult-logs result))
      (doc-update-trace! doc trace (send trace get-contribution) (Doc-version doc))
      ;; Keep source and origin identifiers, not the whole expansion result
      ;; and the module namespaces it retains, while other files are analysed.
      (define original (ExpandResult-pre-syntax result))
      (define contexts (expansion-contexts (ExpandResult-post-syntax result) path))
      (define facts (send (send trace get-declaration) get-binding-facts))
      (define native? (doc-rename-provider doc))
      (define bindings (expansion-bindings doc (ExpandResult-post-syntax result) path))
      ;; Confirmed scoped names can differ from their authored component spelling.
      (for ([fact (in-list (hash-ref facts 'names))])
        (define binding (rename-module-binding fact native?))
        (when (and binding (eq? (hash-ref fact 'certainty 'confirmed) 'confirmed))
          (hash-update! bindings (hash-ref fact 'range) (lambda (old) (set-add old binding)) (set))))
      (define snapshot (rename-snapshot facts (path->source path) text paths))
      (when native?
        ;; Keep defining identities separate from nominal import spaces. Private
        ;; generated binders correspond through their scoped structural anchors.
        (define owners (make-hash))
        (for ([fact (in-list (append (hash-ref facts 'names) (hash-ref facts 'binders)
                                    (append-map (lambda (family) (hash-ref family 'members))
                                                (hash-ref facts 'families))))]
              #:when (hash-ref fact 'binding #f))
          (hash-set! owners (base:rename-module-binding fact) (hash-ref fact 'binding)))
        (define module-binders (make-hash))
        (define (path-id value)
          (hash-ref paths (if (pair? value) (cons (path-id (car value)) (path-id (cdr value))) value)))
        (for ([fact (in-list (hash-ref facts 'binders))] #:when (hash-ref fact 'binding #f))
          (define anchor (list (path-id (hash-ref fact 'anchor)) (hash-ref fact 'role)
                               (hash-ref fact 'phase 0) (hash-ref fact 'space #f)))
          (define entry (hash-ref (hash-ref snapshot 'binders) anchor))
          (when (and (pair? (car entry)) (eq? (caar entry) 'local))
            (hash-set! module-binders anchor (hash-ref fact 'binding))))
        (for ([(anchor entry) (in-hash (hash-ref snapshot 'binders))])
          (define binding (hash-ref owners (car entry) (car entry)))
          (when (and (Module-Binding? binding)
                     (equal? (Module-Binding-filepath binding) path)
                     (or (not (cadr entry)) (not (eq? (caddr entry) (Module-Binding-id binding)))))
            (hash-set! owners (car entry) (cons 'local anchor))
            (hash-set! module-binders anchor binding)))
        (define (project value)
          (cond [(Module-Binding? value) (hash-ref owners value value)]
                [(hash? value) (for/hash ([(key val) (in-hash value)]) (values key (project val)))]
                [(set? value) (for/set ([val (in-set value)]) (project val))]
                [(vector? value) (list->vector (map project (vector->list value)))]
                [(pair? value)
                 ;; The provider's scan compares the scoped public interface.
                 ;; Portal payloads themselves are quoted language data.
                 (if (and scan-provider (eq? (car value) 'portal)) '(portal)
                     (cons (project (car value)) (project (cdr value))))]
                [else value]))
        (set! snapshot (hash-set (project snapshot) 'module-binders module-binders)))
      (Source doc (delay (standard-imports doc original contexts path)) arrows
              bindings snapshot facts
              (let ([provider (if (eq? scan-provider 'source) native? scan-provider)])
                (and provider (scan-source provider doc (ExpandResult-post-syntax result) facts sources snapshot)))))))

;; A resolved module in the spelling bindings use: "../a.rkt" and the file it names
;; must compare as one module.
(define (normalized-module module)
  (match module
    [(? path?) (normalize-source-path module)]
    [`(submod ,(? path? path) ,submods ...) `(submod ,(normalize-source-path path) ,@submods)]
    [_ module]))
(define (resolved-index index file)
  (normalized-module (resolve-module-path-index index file)))

;; Source identifiers in the expansion retain their defining module and phase,
;; including references that Check Syntax cannot attach to relative imports.
;; One written name can carry several bindings, when a native declaration binds its
;; public name and a generated helper at the same component, so each range keeps them all.
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
             (define module (resolved-index (car binding) file))
             (define path (if (pair? module) (cadr module) module))
             (when (path? path)
               (define export-phase (list-ref binding 6))
               (define normalized
                 (Module-Binding path (if (pair? module) (cddr module) '())
                   (if (pair? export-phase) (cons (list-ref binding 4) (cdr export-phase)) (list-ref binding 4))
                   (cadr binding)))
               (hash-update! bindings range (lambda (old) (set-add old normalized)) (set)))))
         (case (core-form value phase)
           [(#%require) (void)]
           [(#%provide) (for-each (lambda (part) (walk-provide part phase)) (cdr (syntax->list value)))]
           [else (for ([part (in-list (code-parts value phase))]) (walk (car part) (cdr part)))]))]
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
  (define expanded
    (and occurrence (hash-ref (Source-bindings source) (absolute-range doc occurrence) #f)))
  (define declared (doc-module-bindings-at doc position))
  ;; Scoped expansion facts retain all confirmed identities at this range,
  ;; including generated spellings and the defining phase of shifted imports.
  ;; Check Syntax jumps can retain an older resolved import path.
  (or expanded (if (doc-rename-provider doc) (set) (list->set declared))))

(define (source-binding-at source position sources [native? #f])
  (define bindings (source-bindings-at source position))
  (cond
    [(set-empty? bindings) #f]
    [(= (set-count bindings) 1) (set-first bindings)]
    [else
     (define doc (Source-doc source))
     (define range (absolute-range doc (doc-occurrence-at doc position)))
     (define spelling (identifier-name (substring (doc-get-text doc) (car range) (cdr range))))
     (define canonical (filter (lambda (binding) (eq? spelling (Module-Binding-id binding))) (set->list bindings)))
     (unless (or native? (= (length canonical) 1))
       (refuse "This source identifier represents more than one binding."))
     (define target (if (pair? canonical) (car canonical) (set-first bindings)))
     (define file (Module-Binding-filepath target))
     (define defining-source
       (cond [(equal? file (source-file-path (Doc-source doc))) source]
             [(hash-has-key? sources file) (analyse file sources (make-hash) #f)]
             [else #f]))
     (define anchors
       (and defining-source
            (for/list ([(anchor entry) (in-hash (hash-ref (Source-snapshot defining-source) 'binders))]
                       #:when (set-member? bindings
                                           (hash-ref (hash-ref (Source-snapshot defining-source) 'module-binders (hash))
                                                     anchor (car entry))))
              (cons anchor entry))))
     (define family?
       (and native? defining-source
            (for/or ([family (in-list (hash-ref (Source-facts defining-source) 'families))])
              (and (hash-ref family 'complete? #f)
                   (subset? bindings (list->set (filter-map (lambda (member) (rename-module-binding member #t))
                                                           (hash-ref family 'members))))))))
     (unless (or family? (and anchors (= (length anchors) (set-count bindings))
                  (andmap (lambda (entry) (equal? (caddr entry) (caddar anchors))) anchors)
                  (let ([range (caddar anchors)])
                    (and range
                         (equal? spelling
                                 (identifier-name
                                  (substring (doc-get-text (Source-doc defining-source))
                                             (car range) (cdr range))))))))
       (refuse "This source identifier represents more than one binding."))
     target]))

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
    (and (null? (doc-module-bindings-at doc pos)) (doc-definition-at doc pos) from)))

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
  (define (resolved path) (normalized-module (resolve-module-path (collapse-module-path path base) file)))
  ;; A quoted name in a file's module is a primitive module, or else its own submodule.
  (define (quoted name submods)
    (cond
      [(not (module-declared? `(quote ,name) #f)) (resolved `(submod "." ,name ,@submods))]
      [(null? submods) `(quote ,name)]
      [else `(submod (quote ,name) ,@submods)]))
  (and (module-path? datum)
       (match datum
         [`(quote ,name) (quoted name '())]
         [`(submod (quote ,name) ,submods ...) (quoted name submods)]
         [_ (resolved datum)])))

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
  (define (origins value modules phase [root? #f])
    (cond
      [(syntax? value)
       (unless (hash-ref seen value #f)
         (hash-set! seen value #t)
         (origin (syntax-property value 'origin) (if (null? modules) file `(submod ,file ,@modules)))
         (define within
           (if (and (not root?) (memq (core-form value phase) '(module module*)))
               (append modules (list (syntax-e (cadr (syntax->list value)))))
               modules))
         (for ([part (in-list (code-parts value phase))]) (origins (car part) within (cdr part))))]
      [(pair? value) (origins (car value) modules phase) (origins (cdr value) modules phase)]))
  (origins expanded '() 0 #t)
  contexts)

;; Retain original import syntax only for an actual expansion of a standard
;; transformer. A binding alone can also occur in an unused syntax template.
(define (standard-imports doc original contexts file)
  (define found '())
  (define transformers
    (for/list ([id (in-list (list #'only-in #'except-in #'rename-in #'prefix-in #'combine-in))])
      (define binding (identifier-binding id))
      (cons (resolved-index (car binding) file) (cadr binding))))
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
                (and (list? binding) (cons (resolved-index (car binding) file) (cadr binding))))
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

;; Compare every source identifier's binding before and after the edit. This
;; detects both capture of a renamed use and capture of an unchanged use by the
;; new name, including unused binders that have no Check Syntax arrow.
(define (bindings source text ranges new-name correspondence shift)
  (define doc (Source-doc source))
  (define snapshot (Source-snapshot source))
  (define scoped-names
    (and (doc-rename-provider doc)
         (for/fold ([names (hash)]) ([entry (in-set (hash-ref snapshot 'names))])
           (hash-update names (car entry) (lambda (owners) (set-add owners (last entry))) (set)))))
  (define private-owners
    (for/hash ([(anchor binding) (in-hash (hash-ref snapshot 'module-binders (hash)))])
      (values binding (car (hash-ref (hash-ref snapshot 'binders) anchor)))))
  (rename-token-relations
   text (Doc-uri doc) ranges new-name correspondence
   (lambda (offset)
     (define position (doc-abs-pos->pos doc offset))
     (define module-bindings (source-bindings-at source position))
     (define occurrence (and scoped-names (doc-occurrence-at doc position)))
     (define scoped (and occurrence (hash-ref scoped-names (absolute-range doc occurrence) #f)))
     (define local-definition (and (not scoped-names) (set-empty? module-bindings) (doc-definition-at doc position)))
     (cond [(not (set-empty? module-bindings))
            (for/set ([binding (in-set module-bindings)]) (hash-ref private-owners binding binding))]
           [scoped scoped]
           [local-definition (absolute-range doc local-definition)]
           [else #f])) shift))

(define (scan-source provider doc expanded facts sources snapshot)
  (define result
    (provider (hasheq 'operation 'rename 'stage 'scan 'uri (Doc-uri doc) 'text (doc-get-text doc)
                      'expanded expanded 'pre #f 'target #f 'position #f 'new-name #f
                      'sources (for/hash ([(path text) (in-hash sources)]) (values (path->uri path) text))
                      'facts facts 'reader #f 'language #f 'submodules '() 'phase 0 'space #f
                      'cancelled? (lambda () #f) 'hooks (hasheq))))
  (define (record? value)
    (and (hash? value) (immutable? value) (andmap symbol? (hash-keys value))))
  (define (owner? value)
    (and (record? value) (identifier? (hash-ref value 'identifier #f))
         (or (not (hash-ref value 'phase 0)) (exact-integer? (hash-ref value 'phase 0)))
         (or (not (hash-ref value 'space #f)) (symbol? (hash-ref value 'space #f)))))
  (unless (and (record? result)
               (list? (hash-ref result 'names #f)) (andmap symbol? (hash-ref result 'names))
               (hash-has-key? result 'computed?) (boolean? (hash-ref result 'computed?))
               (list? (hash-ref result 'exports #f))
               (for/and ([entry (in-list (hash-ref result 'exports))])
                 (and (record? entry) (symbol? (hash-ref entry 'name #f))
                      (identifier? (hash-ref entry 'public #f)) (owner? (hash-ref entry 'interface #f))
                      (list? (hash-ref entry 'owners #f)) (pair? (hash-ref entry 'owners))
                      (andmap owner? (hash-ref entry 'owners)))))
    (refuse "Invalid rename scan."))
  (define file (source-file-path (Doc-source doc)))
  (define private-owners
    (for/hash ([(anchor binding) (in-hash (hash-ref snapshot 'module-binders (hash)))])
      (values binding (car (hash-ref (hash-ref snapshot 'binders) anchor)))))
  (define (owner entry)
    (define binding
      (or (identifier-module-binding (hash-ref entry 'identifier) (hash-ref entry 'phase 0) file (hash-ref entry 'space #f))
        (refuse "An interface owner cannot be resolved.")))
    (hash-ref private-owners binding binding))
  (hash-set result 'exports
            (for/list ([entry (in-list (hash-ref result 'exports))])
              (define public (hash-ref entry 'public))
              (define range (and (syntax-original? public) (source-range public file)))
              (hasheq 'name (hash-ref entry 'name)
                      'range (and range
                                  (equal? (symbol->string (hash-ref entry 'name))
                                          (substring (doc-get-text doc) (car range) (cdr range)))
                                  range)
                      'interface (owner (hash-ref entry 'interface))
                      'owners (list->set (map owner (hash-ref entry 'owners)))))))

(define (validate-exports before after ranges shift correspondence family)
  (unless after (refuse "The rename provider is no longer available."))
  (define remaining (hash-ref after 'exports))
  (for ([entry (in-list (hash-ref before 'exports))])
    (define interface (hash-ref entry 'interface))
    (define owners (hash-ref entry 'owners))
    (define range (hash-ref entry 'range))
    (define match
      (findf
       (lambda (next)
         (and (equal? (hash-ref correspondence interface interface) (hash-ref next 'interface))
              (equal? (for/set ([owner (in-set owners)]) (hash-ref correspondence owner owner))
                      (hash-ref next 'owners))
              (or (eq? (hash-ref entry 'name) (hash-ref next 'name))
                  (and range (for/or ([edit (in-list ranges)]) (contains-range? edit range))
                       (equal? (cons (shift (car range)) (shift (cdr range))) (hash-ref next 'range)))
                  (and family (not (set-empty? (set-intersect family owners)))))))
       remaining))
    (unless match (refuse "Renaming would change another public interface."))
    (set! remaining (remove match remaining)))
  (unless (null? remaining) (refuse "Renaming would add a public interface.")))

;; A native policy can refuse or add checked ranges. The proposal still goes
;; through the same binding correspondence and capture validation below.
(define (doc-rename-policy source pos stage new-name sources [workspace-facts #f])
  (define doc (Source-doc source))
  (define provider (doc-rename-provider doc))
  (and provider
       (let* ([occurrence (doc-occurrence-at doc pos)]
              [range (and occurrence
                          (cons (doc-pos->abs-pos doc (Range-start occurrence))
                                (doc-pos->abs-pos doc (Range-end occurrence))))]
              [facts (Source-facts source)]
              [result
               (provider
                (hasheq 'operation 'rename 'stage stage 'uri (Doc-uri doc) 'text (doc-get-text doc)
                        'position (doc-pos->abs-pos doc pos) 'new-name new-name 'sources sources
                        'target (hasheq 'range range 'names (filter (lambda (name) (equal? (hash-ref name 'range) range))
                                                                 (hash-ref facts 'names '()))
                                        'families (hash-ref (or workspace-facts facts) 'families '()))
                        'facts (or workspace-facts facts) 'pre #f 'expanded #f 'reader #f 'language #f 'submodules '()
                        'phase #f 'space #f 'cancelled? (lambda () #f) 'hooks (hasheq)))])
         (define seen (make-hasheq))
         (define (datum? value)
           (cond [(hash-has-key? seen value) (eq? (hash-ref seen value) #t)]
                 [else
                  (hash-set! seen value 'pending)
                  (define valid?
                    (cond [(pair? value) (and (datum? (car value)) (datum? (cdr value)))]
                          [(or (string? value) (bytes? value) (vector? value) (box? value) (hash? value))
                           (and (immutable? value)
                                (cond [(vector? value) (andmap datum? (vector->list value))]
                                      [(box? value) (datum? (unbox value))]
                                      [(hash? value) (for/and ([(key val) (in-hash value)]) (and (datum? key) (datum? val)))]
                                      [else #t]))]
                          [else (or (null? value) (boolean? value) (number? value) (char? value)
                                    (symbol? value) (keyword? value) (path? value) (regexp? value) (byte-regexp? value))]))
                  (hash-set! seen value valid?)
                  valid?]))
         (unless (and (hash? result) (immutable? result) (andmap symbol? (hash-keys result))
                      (hash-has-key? result 'valid?) (hash-has-key? result 'complete?)
                      (boolean? (hash-ref result 'valid?)) (boolean? (hash-ref result 'complete?))
                      (boolean? (hash-ref result 'by-name? #f))
                      (or (not (hash-ref result 'reason #f)) (string? (hash-ref result 'reason)))
                      (or (not (hash-ref result 'canonical #f)) (identifier? (hash-ref result 'canonical)))
                      (datum? (hash-ref result 'family #f))
                      (or (not (hash-ref result 'family #f))
                          (for/or ([family (in-list (hash-ref (or workspace-facts facts) 'families '()))])
                            (equal? (hash-ref result 'family) (hash-ref family 'key))))
                      (list? (hash-ref result 'edits '())))
           (error 'rename "Invalid native rename policy."))
         (define edits (hash-ref result 'edits '()))
         (for ([edit (in-list edits)])
           (unless (and (hash? edit) (immutable? edit) (andmap symbol? (hash-keys edit))
                        (string? (hash-ref edit 'uri #f)) (string? (hash-ref edit 'old-text #f))
                        (string? (hash-ref edit 'new-text #f)) (pair? (hash-ref edit 'range #f))
                        (exact-nonnegative-integer? (car (hash-ref edit 'range)))
                        (exact-nonnegative-integer? (cdr (hash-ref edit 'range))))
             (error 'rename "Invalid native rename edit.")))
         (define ends (make-hash))
         (for ([edit (in-list (sort edits < #:key (lambda (edit) (car (hash-ref edit 'range)))))])
           (define uri (hash-ref edit 'uri))
           (define range (hash-ref edit 'range))
           (define source (hash-ref sources uri #f))
           (unless (and source (< (car range) (cdr range)) (<= (cdr range) (string-length source))
                        (<= (hash-ref ends uri 0) (car range))
                        (equal? (hash-ref edit 'old-text) (substring source (car range) (cdr range)))
                        (equal? (hash-ref edit 'new-text) new-name))
             (error 'rename "Overlapping, unsupported or stale native rename edit."))
           (hash-set! ends uri (cdr range)))
         (unless (and (hash-ref result 'valid?) (hash-ref result 'complete?))
           (error 'rename "~a" (or (hash-ref result 'reason #f) "Incomplete native rename policy.")))
         result)))

(define (rename-policy-ranges policies uri old-name ranges [proven-ranges ranges])
  (sort
   (remove-duplicates
    (append ranges
            (for*/list ([policy (in-list policies)] #:when policy
                        [edit (in-list (hash-ref policy 'edits '()))]
                        #:when (equal? (hash-ref edit 'uri) uri))
              (define range (hash-ref edit 'range))
              (unless (and (member range proven-ranges)
                           (equal? (hash-ref edit 'old-text) old-name))
                (error 'rename "The native policy supplied an unsupported or stale edit."))
              range))) < #:key car))

(define (scoped-local-ranges source range spelling)
  (define names (hash-ref (Source-facts source) 'names))
  (define (confirmed? name) (eq? (hash-ref name 'certainty 'confirmed) 'confirmed))
  (define selected
    (filter (lambda (name) (and (confirmed? name) (equal? range (hash-ref name 'range)))) names))
  (and (pair? selected)
       (for/list ([name (in-list names)]
                  #:when (and (confirmed? name)
                              (equal? spelling
                                      (let ([r (hash-ref name 'range)])
                                        (substring (doc-get-text (Source-doc source)) (car r) (cdr r))))
                              (for/or ([target (in-list selected)])
                                (and (equal? (hash-ref name 'phase 0) (hash-ref target 'phase 0))
                                     (equal? (hash-ref name 'space #f) (hash-ref target 'space #f))
                                     (free-identifier=? (hash-ref name 'identifier) (hash-ref target 'identifier)
                                                        (hash-ref name 'phase 0))))))
         (hash-ref name 'range))))

(define (workspace-rename sources path position new-name)
  (unless (hash-has-key? sources path)
    (refuse "Save this document inside the analysed workspace before renaming."))
  (define paths (make-hash))
  (define origin-source (analyse path sources paths))
  (define origin (Source-doc origin-source))
  (define pos (jsexpr->Pos position))
  (define occurrence (doc-occurrence-at origin pos))
  (define uri-sources (for/hash ([(file text) (in-hash sources)]) (values (path->uri file) text)))
  (define prepare (doc-rename-policy origin-source pos 'prepare #f (hash (Doc-uri origin) (doc-get-text origin))))
  (define native? prepare)
  (define module-target (source-binding-at origin-source pos sources native?))
  (define origin-plan
    (and module-target (if native? (ImportPlan '() '()) (import-plan origin-source path sources module-target))))
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
  (unless (or prepare (identifier-name old-name))
    (refuse "This generated or escaped identifier cannot be renamed safely."))
  (when (and (not native?) target (not (equal? (identifier-name old-name) (Module-Binding-id target))))
    (refuse "This exported alias has no editable local binding."))
  (define docs
    (and new-name
         (for/hash ([(file text) (in-hash sources)])
           (values file (if (equal? file path) origin-source (analyse file sources paths (doc-rename-provider origin)))))))
  (define workspace-facts
    (and native? docs
         (for/fold ([facts (hash-set* (Source-facts origin-source) 'names '() 'families '())])
                   ([(file source) (in-hash docs)])
           (define local (Source-facts source))
           (hash-set* facts
                      'names (append (hash-ref facts 'names)
                                     (map (lambda (name) (hash-set name 'uri (path->uri file))) (hash-ref local 'names)))
                      'families (append (hash-ref facts 'families) (hash-ref local 'families))))))
  (define policy (and new-name (doc-rename-policy origin-source pos 'plan new-name uri-sources workspace-facts)))
  (define (check-by-name scan)
    (when (and scan policy (hash-ref policy 'by-name? #f)
               (or (hash-ref scan 'computed?)
                   (memq (string->symbol old-name) (hash-ref scan 'names))
                   (memq (string->symbol new-name) (hash-ref scan 'names))))
      (refuse "A run-time member lookup prevents proving this rename complete.")))
  (for ([source (in-hash-values (or docs (hash)))]) (check-by-name (Source-scan source)))
  (cond
    [(not new-name) (->jsexpr (Range (doc-abs-pos->pos origin (car source-range))
                                   (doc-abs-pos->pos origin (cdr source-range))))]
    [(equal? old-name new-name) (hasheq 'changes (hasheq))]
    [else
     (unless (or policy (identifier-name new-name)) (refuse "Enter a single Racket identifier."))
     (define target-definitions
       (and target (Doc-Contribution-definitions
                    (Doc-contribution (Source-doc (hash-ref docs (Module-Binding-filepath target)))))))
     (when target
       (unless (hash-has-key? target-definitions target)
         (refuse "The binding has no unambiguous editable definition in this workspace.")))
     (define target-facts (and target (Source-facts (hash-ref docs (Module-Binding-filepath target)))))
     (define selected-bindings
       (and target
            (if native?
                (let* ([source (hash-ref docs (Module-Binding-filepath target))]
                       [location (hash-ref target-definitions target)])
                  (source-bindings-at source (Range-start (Location-range location))))
                (set target))))
     (define target-family
       (if (and native? target)
           (for/fold ([owners selected-bindings]) ([family (in-list (hash-ref target-facts 'families))])
             (define members (list->set (filter-map (lambda (member) (rename-module-binding member #t))
                                                    (hash-ref family 'members))))
             (if (and (hash-ref family 'complete? #f)
                      (for/or ([member (in-list (hash-ref family 'members))])
                        (and (free-identifier=? (hash-ref family 'canonical) (hash-ref member 'identifier) (hash-ref member 'phase 0))
                             (set-member? selected-bindings (rename-module-binding member #t)))))
                 (set-union owners members) owners))
           (and target (set target))))
     (define editable-family
       (and target-family
            (set-union selected-bindings
             (for/set ([entry (in-list (append (hash-ref target-facts 'binders)
                                               (append-map (lambda (family) (hash-ref family 'members))
                                                           (hash-ref target-facts 'families))))]
                       #:when (and (set-member? target-family (rename-module-binding entry native?))
                                   (equal? (syntax-e (hash-ref entry 'identifier)) (string->symbol old-name))))
               (rename-module-binding entry native?)))))
     (define selector-kind (delay (selector-status target sources)))
     (define edits
       (for/hash ([(file source) (in-hash docs)])
         (define doc (Source-doc source))
         (define text (hash-ref sources file))
         (define plan
           (cond [(doc-rename-provider doc) (ImportPlan '() '())]
                 [target (if (equal? file path) origin-plan (import-plan source file sources target))]
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
                                  #:when (not (set-empty? (set-intersect bindings (or editable-family (set queried))))))
                        (Range (doc-abs-pos->pos doc (car range)) (doc-abs-pos->pos doc (cdr range))))
                      (for*/list ([locations (in-hash-values (Doc-Contribution-references contribution))]
                                  [location (in-list locations)]
                                  #:when (not (set-empty? (set-intersect (source-bindings-at source (Range-start (Location-range location)))
                                                                 (or editable-family (set queried))))))
                        (Location-range location)))]
             [(equal? file path)
              ;; Native component facts retain lexical owners and exact written
              ;; ranges even when a declaration callback kept a coarse anchor.
              ;; The proposal still passes the ordinary binding validation below.
              (define scoped (and native? (not alias) (scoped-local-ranges source source-range old-name)))
              (if scoped
                  (for/list ([r (in-list scoped)])
                    (Range (doc-abs-pos->pos doc (car r)) (doc-abs-pos->pos doc (cdr r))))
                  (doc-binding-ranges-at doc (if alias (doc-abs-pos->pos doc (car alias)) pos)))]
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
         (values file
                 (rename-policy-ranges
                  (list prepare policy) (path->uri file) old-name ranges
                  (append ranges
                          (if target-family
                              (for/list ([entry (in-set (hash-ref (Source-snapshot source) 'names))]
                                         #:when (set-member? target-family (last entry))) (car entry))
                              '()))))))
     (define shifts (for/hash ([(file ranges) (in-hash edits)]) (values file (rename-offset ranges new-name))))
     (define proposed
       (for/hash ([(file text) (in-hash sources)])
         (values file (renamed-text text (hash-ref edits file) new-name))))
     (define after-snapshots (make-hash))
     (define after-scans (make-hash))
     (define after-relations (make-hash))
     (for ([(file text) (in-hash proposed)])
       (define after (analyse file proposed paths (doc-rename-provider origin)))
       (check-by-name (Source-scan after))
       (hash-set! after-snapshots file (Source-snapshot after))
       (hash-set! after-scans file (Source-scan after))
       (hash-set! after-relations file (bindings after text '() new-name (hash) values)))
     (define correspondence (make-hash))
     (for ([(file source) (in-hash docs)])
       (define mapped
         (rename-correspondence (Source-snapshot source) (hash-ref after-snapshots file)
                                (hash-ref edits file) new-name (hash-ref shifts file)))
       (when target-family
         (define before (Source-snapshot source))
         (define after (hash-ref after-snapshots file))
         (for ([(anchor binding) (in-hash (hash-ref before 'module-binders (hash)))]
               #:when (set-member? target-family binding))
           (define next (hash-ref (hash-ref after 'module-binders (hash)) anchor #f))
           (unless (and next (equal? (struct-copy Module-Binding binding [id (Module-Binding-id next)]) next)
                        (not (hash-has-key? mapped binding)) (not (member next (hash-values mapped))))
             (refuse "The generated binding correspondence is ambiguous."))
           (hash-set! mapped binding next)))
       (for ([(old new) (in-hash mapped)])
         (when (and (hash-has-key? correspondence old) (not (equal? (hash-ref correspondence old) new)))
           (refuse "The binding correspondence is ambiguous."))
         (hash-set! correspondence old new)))
     (for ([(file source) (in-hash docs)])
       (when (Source-scan source)
         (validate-exports (Source-scan source) (hash-ref after-scans file)
                           (hash-ref edits file) (hash-ref shifts file) correspondence
                           (and target-family
                                (set-union target-family
                                           (for/set ([(anchor binding) (in-hash (hash-ref (Source-snapshot source) 'module-binders (hash)))]
                                                     #:when (set-member? target-family binding))
                                             (car (hash-ref (hash-ref (Source-snapshot source) 'binders) anchor)))))))
       (validate-rename-proposal
        (Source-snapshot source) (hash-ref after-snapshots file) (hash-ref edits file) new-name correspondence
        (bindings source (hash-ref sources file) (hash-ref edits file) new-name correspondence (hash-ref shifts file))
        (hash-ref after-relations file) (hash-ref shifts file)))
     (hasheq 'changes
             (for/hasheq ([(file ranges) (in-hash edits)] #:unless (null? ranges))
               (define doc (Source-doc (hash-ref docs file)))
               (values (string->symbol (path->uri file))
                       (for/list ([range (in-list ranges)])
                         (->jsexpr (TextEdit #:range (Range (doc-abs-pos->pos doc (car range))
                                                         (doc-abs-pos->pos doc (cdr range)))
                                            #:newText new-name))))))]))
