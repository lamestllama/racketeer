#lang racket/base

;; Rename is a proposed edit over one immutable workspace snapshot. Expansion
;; validates the proposal in memory; neither source files nor editor buffers are
;; changed here. Binding queries come from the same analyser as the index.
(require racket/list
         racket/path
         syntax/modcode
         racket-langserver/common/interfaces
         racket-langserver/common/path-util
         racket-langserver/common/json-util
         racket-langserver/doclib/doc
         racket-langserver/doclib/lexer)

(provide workspace-rename)

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

(define (analyse path sources)
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
    (define doc (make-doc (path->uri path) (hash-ref sources path)))
    (unless (doc-expand! doc)
      (refuse (format "Cannot analyse ~a with the proposed names and current buffers." path)))
    doc))

(define (absolute-range doc range)
  (cons (doc-pos->abs-pos doc (Range-start range))
        (doc-pos->abs-pos doc (Range-end range))))

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
  (define origin (analyse path sources))
  (define pos (jsexpr->Pos position))
  (define occurrence (doc-occurrence-at origin pos))
  (define target (doc-module-binding-at origin pos))
  (define definition (doc-definition-at origin pos))
  (unless (and occurrence (or target definition))
    (refuse "This location has no editable binding."))
  (when (and target (not (hash-has-key? sources (Module-Binding-filepath target))))
    (refuse "The definition is outside the analysed workspace."))
  (define source-range (absolute-range origin occurrence))
  (define old-name (substring (hash-ref sources path) (car source-range) (cdr source-range)))
  (unless (identifier-name old-name)
    (refuse "This generated or escaped identifier cannot be renamed safely."))
  (cond
    [(not new-name) (->jsexpr occurrence)]
    [(equal? old-name new-name) (hasheq 'changes (hasheq))]
    [else
     (unless (identifier-name new-name) (refuse "Enter a single Racket identifier."))
     (define docs
       (for/hash ([(file text) (in-hash sources)])
         (values file (if (equal? file path) origin (analyse file sources)))))
     (when target
       (unless (hash-has-key? (Doc-Contribution-definitions
                               (Doc-contribution (hash-ref docs (Module-Binding-filepath target)))) target)
         (refuse "The binding has no unambiguous editable definition in this workspace.")))
     (define edits
       (for/hash ([(file doc) (in-hash docs)])
         (define contribution (Doc-contribution doc))
         (define locations
           (cond
             [target
              (define declaration (hash-ref (Doc-Contribution-definitions contribution) target #f))
              (append (if declaration (list (Location-range declaration)) '())
                      (map Location-range (hash-ref (Doc-Contribution-references contribution) target '())))]
             [(equal? file path) (doc-binding-ranges-at doc pos)]
             [else '()]))
         (define ranges (sort (remove-duplicates (map (lambda (r) (absolute-range doc r)) locations)) < #:key car))
         (for ([range (in-list ranges)])
           (unless (equal? (substring (hash-ref sources file) (car range) (cdr range)) old-name)
             (refuse "This binding uses an import alias, prefix, or generated spelling. Rename is not supported for it yet.")))
         (for ([left (in-list ranges)] [right (in-list (if (pair? ranges) (cdr ranges) '()))])
           (when (> (cdr left) (car right)) (refuse "The binding has overlapping source locations.")))
         (values file ranges)))
     (define proposed
       (for/hash ([(file text) (in-hash sources)])
         (values file (renamed-text text (hash-ref edits file) new-name))))
     (for ([(file before) (in-hash docs)])
       (define after (analyse file proposed))
       (unless (equal? (bindings before (hash-ref sources file) (hash-ref edits file) new-name target)
                       (bindings after (hash-ref proposed file) '() new-name #f))
         (refuse (format "Renaming would change another binding or requires unsupported import edits in ~a." file))))
     (hasheq 'changes
             (for/hasheq ([(file ranges) (in-hash edits)] #:unless (null? ranges))
               (define doc (hash-ref docs file))
               (values (string->symbol (path->uri file))
                       (for/list ([range (in-list ranges)])
                         (->jsexpr (TextEdit #:range (Range (doc-abs-pos->pos doc (car range))
                                                         (doc-abs-pos->pos doc (cdr range)))
                                            #:newText new-name))))))]))
