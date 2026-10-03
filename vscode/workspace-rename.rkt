#lang racket/base

;; Rename is a proposed edit over one immutable workspace snapshot. Expansion
;; validates the proposal in memory; neither source files nor editor buffers are
;; changed here. Binding queries come from the same analyser as the index.
(require racket/class
         racket/list
         racket/match
         racket/path
         racket/promise
         drracket/check-syntax
         syntax/modcode
         syntax/modresolve
         racket-langserver/common/interfaces
         racket-langserver/common/path-util
         racket-langserver/common/json-util
         racket-langserver/doclib/doc
         racket-langserver/doclib/doc-trace
         racket-langserver/doclib/check-syntax
         racket-langserver/doclib/internal-types
         racket-langserver/doclib/lexer)

(provide workspace-rename)

(struct Source (doc forms arrows imports) #:transparent)
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
  (define ordinary-load (current-load/use-compiled))
  (define ordinary-open (moddep-current-open-input-file))
  (define (load-snapshot file expected)
    (define full (simple-form-path file))
    (cond
      [(and expected (hash-has-key? sources full))
       (unless (and (pair? expected) (not (car expected)))
         (parameterize ([current-load-relative-directory (path-only full)]
                        [current-module-declare-source full])
           (get-module-code full #:sub-path '() #:rkt-try-ss? #f #:compile eval)))]
      [else (ordinary-load file expected)]))
  (parameterize ([current-namespace (make-base-namespace)]
                 [current-directory (path-only path)]
                 [current-load-relative-directory (path-only path)]
                 [current-load/use-compiled load-snapshot]
                 [moddep-current-open-input-file
                  (lambda (file)
                    (define text (hash-ref sources (simple-form-path file) #f))
                    (if text (open-input-string text file) (ordinary-open file)))])
    (proc)))

(define (analyse path sources)
  (in-snapshot path sources
    (lambda ()
      (define text (hash-ref sources path))
      (define doc (make-doc (path->uri path) text))
      (define buffer (doc-copy-text-buffer doc))
      (define lexer (build-lexer-state text (Doc-uri doc)))
      (define arrows (make-hasheqv))
      (define imports (make-hash))
      (define trace
        (new (class build-trace%
               (super-new)
               (define/override (syncheck:add-require-open-menu source start end filename)
                 (when (equal? source path)
                   (hash-update! imports (simple-form-path filename)
                                 (lambda (ranges) (cons (cons start end) ranges)) '()))
                 (super syncheck:add-require-open-menu source start end filename))
               (define/override (syncheck:add-arrow/name-dup/pxpy from left right px py
                                                                to start end qx qy actual? phase imported? dup?)
                 (when (and actual? (equal? from path) (equal? to path))
                   (hash-update! arrows end
                                 (lambda (at-end) (cons (Arrow (cons left right) (cons start end) imported?) at-end))
                                 '()))
                 (super syncheck:add-arrow/name-dup/pxpy from left right px py
                        to start end qx qy actual? phase imported? dup?)))
             [src path] [doc-text buffer] [lexer-state lexer]))
      (define expand? (Language-Policy-expand? (LexerState-language-policy lexer)))
      (define result (expand-source path (open-input-string text) trace #:expand? expand?))
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
      (Source doc (delay (standard-imports doc original contexts path)) arrows imports))))

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

;; A prefix can have the same spelling as the exported name. Only a binding
;; arrow reaching the end of the identifier can identify its unprefixed part.
(define (imported-range source text range name target)
  (or (for/or ([arrow (in-list (hash-ref (Source-arrows source) (cdr range) '()))]
                #:when (and (Arrow-imported? arrow) (contains-range? range (Arrow-to arrow))))
        (define use (Arrow-to arrow))
        (and (equal? (substring text (car use) (cdr use)) name) use))
      ;; Prefix composition and (file ...) imports can lose their subranges.
      ;; Recover them from standard prefix forms with proven binding identity.
      (for/or ([form (in-list (force (Source-forms source)))])
        (define file (uri->path (Doc-uri (Source-doc source))))
        (define (base-name spec)
          (cond
            [(same-module? spec file target) name]
            [else
             (match (syntax->list spec)
               [(list head prefix child)
                #:when (and (identifier? head) (free-identifier=? head #'prefix-in))
                (define base (base-name child))
                (and base (string-append (symbol->string (syntax-e prefix)) base))]
               [(list* (? identifier? head) child selectors)
                #:when (for/or ([id (in-list (list #'only-in #'except-in #'rename-in))])
                         (free-identifier=? head id))
                (define base (base-name child))
                (define selected
                  (and base
                       (findf (lambda (selector)
                                (define pair (syntax->list selector))
                                (equal? (syntax-e (if pair (car pair) selector)) (string->symbol base)))
                              selectors)))
                ;; Explicit aliases keep their chosen name, including aliases
                ;; whose spelling happens to equal the original export.
                (and base (if (free-identifier=? head #'only-in)
                              (and selected (identifier? selected)) (not selected)) base)]
               [_ #f])]))
        (match form
          [(list 'prefix-in prefix spec)
           (define base (base-name spec))
           (and base
                (equal? (substring text (car range) (cdr range))
                        (string-append (symbol->string (syntax-e prefix)) base))
                (cons (- (cdr range) (string-length name)) (cdr range)))]
          [_ #f]))))

(define (source-range stx file)
  (and (equal? (syntax-source stx) file) (syntax-position stx) (syntax-span stx)
       (cons (sub1 (syntax-position stx)) (+ (sub1 (syntax-position stx)) (syntax-span stx)))))

(define (direct-module? spec)
  (define datum (syntax->datum spec))
  (and (module-path? datum)
       (not (match datum [(list* 'submod (or "." "..") _) #t] [_ #f]))))

(define (same-module? spec file target)
  (and (direct-module? spec)
       (equal? (resolve-module-path (syntax->datum spec) file)
               (if (null? (Module-Binding-submods target)) (Module-Binding-filepath target)
                   `(submod ,(Module-Binding-filepath target) ,@(Module-Binding-submods target))))))

(define (expansion-contexts expanded file)
  (define contexts (make-hash))
  (define seen (make-hasheq))
  ;; The outer transformer's origin retains its expansion scopes. Transfer
  ;; those scopes to its original operands so nested require transformers can
  ;; be identified even when Check Syntax has no arrow for their keywords.
  (define (origin value)
    (cond
      [(identifier? value)
       (define range (source-range value file))
       (when range
         (hash-update! contexts range
                       (lambda (prior) (if (and (identifier? prior) (bound-identifier=? prior value))
                                           prior 'ambiguous)) value))]
      [(pair? value) (origin (car value)) (origin (cdr value))]))
  (define (origins value)
    (cond
      [(syntax? value)
       (unless (hash-ref seen value #f)
         (hash-set! seen value #t)
         (origin (syntax-property value 'origin))
         (origins (syntax-e value)))]
      [(pair? value) (origins (car value)) (origins (cdr value))]))
  (origins expanded)
  contexts)

;; Retain original import syntax only for an actual expansion of a standard
;; transformer. A binding alone can also occur in an unused syntax template.
(define (standard-imports doc original contexts file)
  (define found '())
  (define transformers
    (for/list ([id (in-list (list #'only-in #'except-in #'rename-in #'prefix-in))])
      (define binding (identifier-binding id))
      (cons (resolve-module-path-index (car binding) file) (cadr binding))))
  (define (walk stx [scoped? #f])
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
           (define transfer? (and context (equal? (Module-Binding-phase+space binding) 0)))
           (define operands
             (cdr (if transfer? (syntax->list ((make-syntax-delta-introducer context head 0) stx)) parts)))
           (set! found (cons (cons (cdr identity) operands) found))
           ;; Only a standard transformer's require-spec operand shares this
           ;; context. An arbitrary transformer may interpret its operands.
           (walk (if (eq? (cdr identity) 'prefix-in) (cadr operands) (car operands))
                 (or scoped? transfer?))]
          [(not scoped?) (for-each walk parts)]))))
  (walk original)
  found)

;; Selectors can disappear during expansion. Resolve them from the retained
;; standard forms. Refuse composed selectors over this module even when unused:
;; unchanged text could otherwise silently change which names they import.
(define (import-selectors source file text target)
  (define found '())
  (define (add! selector)
    (define parts (syntax->list selector))
    (define id (if (pair? parts) (car parts) selector))
    (define range (source-range id file))
    (when (and (identifier? id) range (<= 0 (car range) (cdr range) (string-length text))
               (equal? (syntax-e id) (Module-Binding-id target))
               (equal? (substring text (car range) (cdr range)) (symbol->string (Module-Binding-id target))))
      (set! found (cons range found))))
  (for ([form (in-list (force (Source-forms source)))] #:unless (eq? (car form) 'prefix-in))
    (define spec (cadr form))
    (define range (source-range spec file))
    (when (and (not (direct-module? spec))
               (for/or ([import (in-list (hash-ref (Source-imports source) (Module-Binding-filepath target) '()))])
                 (or (not range) (contains-range? range import))))
      (refuse "This composed or relative import selector cannot be renamed safely."))
    (when (same-module? spec file target) (for-each add! (cddr form))))
  found)

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
(define (bindings doc text ranges new-name target)
  (define (shift offset)
    (+ offset (for/sum ([range (in-list ranges)] #:when (<= (cdr range) offset))
                (- (string-length new-name) (- (cdr range) (car range))))))
  (for/list ([token (in-lexer-snapshot (build-lexer-snapshot text (Doc-uri doc)))]
             #:when (eq? (LexerEntry-type token) 'symbol))
    (define position (doc-abs-pos->pos doc (LexerEntry-start token)))
    (define module-binding (doc-module-binding-at doc position))
    (define local-definition (and (not module-binding) (doc-definition-at doc position)))
    (list (shift (LexerEntry-start token)) (shift (LexerEntry-end token))
          (cond
            [module-binding
             (if (equal? module-binding target)
                 (struct-copy Module-Binding module-binding [id (identifier-name new-name)])
                 module-binding)]
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
  (define alias (and occurrence (alias-at origin-source (absolute-range origin occurrence))))
  (define target (and (not alias) (doc-module-binding-at origin pos)))
  (define definition (doc-definition-at origin pos))
  (unless (and occurrence (or target definition alias))
    (refuse "This location has no editable binding."))
  (when (and target (not (hash-has-key? sources (Module-Binding-filepath target))))
    (refuse "The definition is outside the analysed workspace."))
  (define source-range (absolute-range origin occurrence))
  (when target
    (set! source-range
          (or (imported-range origin-source (hash-ref sources path) source-range
                              (symbol->string (Module-Binding-id target)) target) source-range)))
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
         (define candidates (if target (import-selectors source file text target) '()))
         (define selectors
           (cond
             [(null? candidates) '()]
             [else
              (case (force selector-kind)
                [(local) candidates]
                [(shared) (refuse "This import selector refers to more than one phase or binding space.")]
                [else '()])]))
         (define contribution (Doc-contribution doc))
         (define locations
           (cond
             [target
              (define declaration (hash-ref (Doc-Contribution-definitions contribution) target #f))
              (append (if declaration (list (Location-range declaration)) '())
                      (map Location-range (hash-ref (Doc-Contribution-references contribution) target '())))]
             [(equal? file path) (doc-binding-ranges-at doc (if alias (doc-abs-pos->pos doc (car alias)) pos))]
             [else '()]))
         (define ranges
           (sort (remove-duplicates
                  (append selectors
                          (filter-map
                           (lambda (location)
                             (define range (absolute-range doc location))
                             (and (not (and target (alias-at source range)))
                                  (or (and (not target) range)
                                      (and (equal? (substring text (car range) (cdr range)) old-name) range)
                                      (and target (imported-range source text range old-name target)))))
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
       (define before (Source-doc source))
       (define after (Source-doc (analyse file proposed)))
       (unless (equal? (bindings before (hash-ref sources file) (hash-ref edits file) new-name target)
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
