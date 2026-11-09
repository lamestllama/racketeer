#lang racket/base

;; This module provides a library for representing a document. It is designed
;; to be easy to use and single-threaded, containing only document-related logic
;; functions. For use in a multi-threaded LSP environment, it should be wrapped
;; by a structure that provides thread safety, such as `SafeDoc`.

(require "../common/interfaces.rkt"
         (only-in "../common/json-util.rkt" Nothing)
         "editor.rkt"
         "../common/source.rkt"
         "../common/source-snapshot.rkt"
         "lazy-cache.rkt"
         "doc-trace.rkt"
         (only-in "autocomplete.rkt" binding-completions)
         "formatting.rkt"
         (only-in "formatter/fmt.rkt" empty-fmt-settings)
         "internal-types.rkt"
         "rename-validation.rkt"
         (only-in "service/declaration.rkt" current-retain-binding-facts?)
         "lexer.rkt"
         (only-in "lexer/state.rkt"
                  lexer-state-body-forest)
         (only-in "lexer/token-tree.rkt"
                  Token-Leaf? Token-Leaf-span
                  Token-List? Token-List-children
                  Token-Prefix-Tree?
                  Token-Forest-nodes
                  token-node-children
                  token-node-start
                  token-node-end
                  non-skippable-node?
                  token-leaf-type?)
         "doc-lang.rkt"
         "language-adapter.rkt"
         (only-in "lexer/state.rkt" LexerState-editor-facts)
         "inlay-hint-source.rkt"
         racket/match
         racket/contract
         racket/class
         racket/set
         racket/list
         racket/string
         racket/lazy-require
         data/interval-map
         "check-syntax.rkt"
         "hover.rkt"
         "service/hover/types.rkt"
         "external/resyntax.rkt"
         racket/format)

;; Documentation is optional for clients that only analyse bindings.
(lazy-require ["docs-helpers.rkt"
               (get-docs-for-tag id-to-tag make-proper-url-for-online-documentation)]
              ["documentation-parser.rkt" (extract-documentation-for-selected-element)])

(struct/contract Doc
  ([source Source?]
   [text (is-a?/c lsp-editor%)]
   [trace (is-a?/c build-trace%)]
   [contribution (or/c #f Doc-Contribution?)]
   [version exact-nonnegative-integer?]
   [trace-version (or/c false/c exact-nonnegative-integer?)]
   [resyntax-results (listof Resyntax-Result?)]
   [lexer-state (lazy-cache-of LexerState?)])
  #:mutable)

(define (make-Doc #:source source
                  #:text text
                  #:trace trace
                  #:contribution [contribution #f]
                  #:version version
                  #:trace-version [trace-version #f]
                  #:resyntax-results [resyntax-results (list)]
                  #:lexer-state [lexer-state (make-lazy-cache)])
  (Doc source
       text
       trace
       contribution
       version
       trace-version
       resyntax-results
       lexer-state))

(define (Doc-uri doc)
  (source-uri (Doc-source doc)))

(define/contract (make-doc uri text [version 0])
  (->* (string? string?)
       (exact-nonnegative-integer?)
       Doc?)
  (make-source-doc (uri->source uri) text version))

(define/contract (make-source-doc source text [version 0])
  (->* (Source? string?)
       (exact-nonnegative-integer?)
       Doc?)
  (define doc-text (new lsp-editor%))
  (send doc-text insert text 0)
  (define lexer-state (build-lexer-state text (source-uri source)))
  ;; the init trace should not be #f
  (define doc-trace
    (new build-trace%
      [source source]
      [doc-text doc-text]
      [lexer-state lexer-state]))
  (make-Doc #:source source
            #:text doc-text
            #:trace doc-trace
            #:version version))

(define (invalidate-resyntax-results! doc)
  (set-Doc-resyntax-results! doc (list)))

(define (invalidate-lexer-state! doc)
  (lazy-cache-invalidate! (Doc-lexer-state doc)))

(define/contract (doc-get-resyntax-results doc)
  (-> Doc? (listof Resyntax-Result?))
  (Doc-resyntax-results doc))

(define/contract (doc-update-resyntax-result! doc results)
  (-> Doc? (listof Resyntax-Result?) void?)
  (set-Doc-resyntax-results! doc results))

(define/contract (resyntax-result->diag doc res)
  (-> Doc? Resyntax-Result? Diagnostic?)
  (define range
    (Range #:start (doc-abs-pos->pos doc (Resyntax-Result-start res))
           #:end (doc-abs-pos->pos doc (Resyntax-Result-end res))))
  (Diagnostic #:range range
              #:severity DiagnosticSeverity-Information
              #:source "Resyntax"
              #:message (format "[~a] ~a" (Resyntax-Result-rule-name res) (Resyntax-Result-message res))))

(define/contract (resyntax-result->code-action doc res)
  (-> Doc? Resyntax-Result? CodeAction?)
  (define diag (resyntax-result->diag doc res))
  (define doc-uri (Doc-uri doc))
  (define range (Diagnostic-range diag))
  (CodeAction
    #:title (format "Apply rule [~a]" (Resyntax-Result-rule-name res))
    #:kind "quickfix"
    #:diagnostics (list diag)
    #:isPreferred #f
    #:edit (WorkspaceEdit
             #:changes
             (hasheq (string->symbol doc-uri)
                     (list (TextEdit #:range range
                                     #:newText (Resyntax-Result-new-text res)))))))

(define/contract (doc-resyntax doc)
  (-> Doc? (listof Resyntax-Result?))
  (run-resyntax (send (Doc-text doc) get-text) (Doc-uri doc)))

(define/contract (doc-resyntax! doc)
  (-> Doc? void?)
  (define results (doc-resyntax doc))
  (doc-update-resyntax-result! doc results))

(define/contract (doc-resyntax-available?)
  (-> boolean?)
  (resyntax-available?))

(define/contract (doc-update-version! doc new-ver)
  (-> Doc? exact-nonnegative-integer? void?)
  (set-Doc-version! doc new-ver))

(define/contract (doc-update-uri! doc new-uri)
  (-> Doc? string? void?)
  (set-Doc-source! doc (uri->source new-uri)))

(define/contract (doc-reset! doc new-text)
  (-> Doc? string? void?)
  (define doc-text (Doc-text doc))
  (define doc-trace (Doc-trace doc))

  (invalidate-resyntax-results! doc)
  (invalidate-lexer-state! doc)
  (send doc-text erase)
  (send doc-trace reset)
  (send doc-text insert new-text 0))

(define (text-edit-start doc edit)
  (doc-pos->abs-pos doc (Range-start (TextEdit-range edit))))

(define (text-edit-end doc edit)
  (doc-pos->abs-pos doc (Range-end (TextEdit-range edit))))

(define (sort-text-edits-descending doc edits)
  (sort edits
        (lambda (a b)
          (define a-start (text-edit-start doc a))
          (define b-start (text-edit-start doc b))
          (if (= a-start b-start)
              (> (text-edit-end doc a) (text-edit-end doc b))
              (> a-start b-start)))))

(define (doc-apply-absolute-edit! doc start end text)
  (define doc-text (Doc-text doc))
  (define doc-trace (Doc-trace doc))
  (define old-len (- end start))
  (define new-len (string-length text))

  ;; try reuse old information as the check-syntax can fail
  ;; for updated code.
  (send doc-trace text-replaced start end)
  (cond [(> new-len old-len) (send doc-trace expand end (+ start new-len))]
        [(< new-len old-len) (send doc-trace contract (+ start new-len) end)])
  (send doc-text replace text start end))

(define (doc-check-non-overlapping-edits! doc edits-descending-by-start)
  (for ([later-start-edit (in-list edits-descending-by-start)]
        [earlier-start-edit (in-list (rest edits-descending-by-start))])
    (define later-start (text-edit-start doc later-start-edit))
    (define earlier-start (text-edit-start doc earlier-start-edit))
    (define earlier-end (text-edit-end doc earlier-start-edit))
    (when (> earlier-end later-start)
      (error 'doc-apply-edits!
             "overlapping edits: ~a..~a, next starts at ~a"
             earlier-start
             earlier-end
             earlier-start))))

(define/contract (doc-apply-edit! doc range text)
  (-> Doc? Range? string? void?)
  (invalidate-resyntax-results! doc)
  (invalidate-lexer-state! doc)
  (define start (doc-pos->abs-pos doc (Range-start range)))
  (define end (doc-pos->abs-pos doc (Range-end range)))
  (doc-apply-absolute-edit! doc start end text))

(define/contract (doc-apply-edits! doc edits)
  (-> Doc? (listof TextEdit?) void?)
  (unless (empty? edits)
    (invalidate-resyntax-results! doc)
    (invalidate-lexer-state! doc)
    ;; Apply from the end of the document so earlier edits do not shift
    ;; the positions of later edits.
    (define edits-descending-by-start
      (sort-text-edits-descending doc edits))
    (doc-check-non-overlapping-edits! doc edits-descending-by-start)
    (for ([edit (in-list edits-descending-by-start)])
      (doc-apply-absolute-edit! doc
                                (text-edit-start doc edit)
                                (text-edit-end doc edit)
                                (TextEdit-newText edit)))))

(define/contract (doc-expand source doc-text lexer-state #:contribution-only? [contribution-only? #f])
  (->* (Source? (is-a?/c lsp-editor%) LexerState?) (#:contribution-only? boolean?) CSResult?)
  (check-syntax source doc-text lexer-state #:contribution-only? contribution-only?))

(define (doc-update-language-policy! doc new-trace)
  (set-Doc-lexer-state! doc (make-lazy-cache))
  (call-with-lazy-cache! (Doc-lexer-state doc) (lambda () (send new-trace get-lexer-state))))

(define/contract (doc-update-trace! doc new-trace new-contribution new-version)
  (-> Doc?
      (is-a?/c build-trace%)
      (or/c #f Doc-Contribution?)
      exact-nonnegative-integer?
      void?)
  (doc-update-language-policy! doc new-trace)
  (set-Doc-trace! doc new-trace)
  (set-Doc-contribution! doc new-contribution)
  (set-Doc-trace-version! doc new-version))

;; Release a trace before transferring it to retained storage. Old SafeDoc
;; holders must never mutate the trace subsequently installed in a new buffer.
(define/contract (doc-detach-analysis! doc)
  (-> Doc? void?)
  (set-Doc-trace! doc
                  (new build-trace%
                    [source (Doc-source doc)]
                    [doc-text (Doc-text doc)]
                    [lexer-state (doc-lexer-state doc)]))
  (set-Doc-contribution! doc #f)
  (set-Doc-trace-version! doc #f)
  (invalidate-resyntax-results! doc))

(define/contract (doc-trace-latest? doc)
  (-> Doc? boolean?)
  (and (equal? (Doc-version doc) (Doc-trace-version doc))
       (send (Doc-trace doc) adapter-current?)))

;; Extract while the worker exclusively owns an unedited, completed Doc.
;; Shared queries retain ranges, never the mutable declaration service.
(define/contract (doc-definition-ranges doc)
  (-> Doc? (hash/c Module-Binding? Range? #:immutable #t))
  (for/hash ([(binding location) (in-hash (if (Doc-contribution doc)
                                              (Doc-Contribution-definitions (Doc-contribution doc))
                                              (hash)))])
    (values binding (Location-range location))))

(define/contract (doc-expand! doc #:contribution-only? [contribution-only? #f])
  (->* (Doc?) (#:contribution-only? boolean?) boolean?)
  (define result (doc-check-syntax doc #:contribution-only? contribution-only?))
  (define new-trace (CSResult-trace result))
  (cond [(and (CSResult-succeed? result) (send new-trace adapter-current?))
         (define new-contribution (send new-trace get-contribution))
         (doc-update-trace! doc
                            new-trace
                            new-contribution
                            (Doc-version doc))
         #t]
        [else
         (define adapter (send new-trace get-language-adapter))
         (when (and adapter ((current-language-adapter-declarations) adapter))
           (doc-update-language-policy! doc new-trace))
         #f]))

(define/contract (doc-check-syntax doc #:contribution-only? [contribution-only? #f])
  (->* (Doc?) (#:contribution-only? boolean?) CSResult?)
  (doc-expand (Doc-source doc) (Doc-text doc) (doc-lexer-state doc)
              #:contribution-only? contribution-only?))

(define/contract (doc-pos->abs-pos doc pos)
  (-> Doc? Pos? exact-nonnegative-integer?)
  (send (Doc-text doc) lsp-position->pos (Pos-line pos) (Pos-char pos)))

(define/contract (doc-abs-pos->pos doc pos)
  (-> Doc? exact-nonnegative-integer? Pos?)
  (match-define (list line char) (send (Doc-text doc) pos->line/char pos))
  (Pos line char))

(define/contract (doc-line-start-abs-pos doc line)
  (-> Doc? exact-nonnegative-integer? exact-nonnegative-integer?)
  (send (Doc-text doc) line-start-pos line))

(define/contract (doc-line-end-abs-pos doc line)
  (-> Doc? exact-nonnegative-integer? exact-nonnegative-integer?)
  (send (Doc-text doc) line-end-pos line))

(define/contract (doc-end-abs-pos doc)
  (-> Doc? exact-nonnegative-integer?)
  (send (Doc-text doc) end-pos))

(define/contract (doc-get-text doc)
  (-> Doc? string?)
  (send (Doc-text doc) get-text))

(define/contract (doc-diagnostics doc)
  (-> Doc? (listof Diagnostic?))
  (append (set->list (send (Doc-trace doc) get-warn-diags))
          (for/list ([res (in-list (doc-get-resyntax-results doc))])
            (resyntax-result->diag doc res))))

(define/contract (doc-copy-text-buffer doc)
  (-> Doc? (is-a?/c lsp-editor%))
  (send (Doc-text doc) copy))

(define (interval-map-iterate-least/end>?/fallback intervals end)
  (let loop ([iter (interval-map-iterate-first intervals)])
    (cond
      [(not iter) #f]
      [else
       (match-define (cons _ interval-end)
         (interval-map-iterate-key intervals iter))
       (if (> interval-end end)
           iter
           (loop (interval-map-iterate-next intervals iter)))])))

(define maybe-interval-map-iterate-least/end>?
  (dynamic-require 'data/interval-map
                   'interval-map-iterate-least/end>?
                   (lambda () interval-map-iterate-least/end>?/fallback)))

(define (interval-map-overlap-values intervals start end)
  (let loop ([iter (maybe-interval-map-iterate-least/end>? intervals start)]
             [values (list)])
    (cond
      [(not iter) (reverse values)]
      [else
       (match-define (cons interval-start _)
         (interval-map-iterate-key intervals iter))
       (if (>= interval-start end)
           (reverse values)
           (loop (interval-map-iterate-next intervals iter)
                 (cons (interval-map-iterate-value intervals iter) values)))])))

;; Return the absolute position of the opening delimiter of the innermost form
;; that contains `pos`, or #f when `pos` is outside any parsed form.
(define/contract (doc-find-containing-paren doc pos)
  (-> Doc? exact-nonnegative-integer? (or/c exact-nonnegative-integer? #f))
  (lexer-state-containing-open-paren (doc-lexer-state doc) pos))

;; Cache lexer-derived state lazily. Query paths may build a cache miss while
;; the caller already holds whatever lock stabilizes the document state.
(define (doc-build-lexer-state doc)
  (build-lexer-state (send (Doc-text doc) get-text) (Doc-uri doc)))

(define (doc-lexer-state doc)
  (call-with-lazy-cache!
    (Doc-lexer-state doc)
    (lambda ()
      (doc-build-lexer-state doc))))

(define (doc-lexer-snapshot doc)
  (LexerState-snapshot (doc-lexer-state doc)))

(define (doc-language-policy doc)
  (LexerState-language-policy (doc-lexer-state doc)))

(define (doc-language-body-mode doc)
  (Language-Policy-body-mode (doc-language-policy doc)))

(define (doc-body-forest doc)
  (lexer-state-body-forest (doc-lexer-state doc)))

;; formatting ;;

(define (doc-src-dir doc)
  (define file-path (source-file-path (Doc-source doc)))
  (and file-path
       (let-values ([(base _name _must-be-dir?)
                     (split-path (path->complete-path file-path))])
         base)))

(define (formatting-range->lines doc-text fmt-range)
  (define last-line (send doc-text at-line (send doc-text end-pos)))
  (define requested-start-line (Pos-line (Range-start fmt-range)))
  (define requested-end-line (Pos-line (Range-end fmt-range)))
  (define start-line (min requested-start-line last-line))
  ;; PR #92 established that formatting ranges use inclusive end-line semantics,
  ;; even though the LSP range end itself is exclusive.
  (values start-line (max start-line (min requested-end-line last-line))))

(define (doc-sexp-language? doc)
  (eq? 'sexp (doc-language-body-mode doc)))

(define (doc-on-type-formatting-range doc pos ch)
  (define ch-pos (max 0 (sub1 (doc-pos->abs-pos doc pos))))
  (define current-line (Pos-line pos))
  (define current-line-start-pos (doc-line-start-abs-pos doc current-line))
  (define current-line-end-pos (doc-line-end-abs-pos doc current-line))

  (define (current-line-range)
    (Range (doc-abs-pos->pos doc current-line-start-pos)
           (doc-abs-pos->pos doc current-line-end-pos)))

  (define (containing-form-range)
    (define raw-pos (max 0 (sub1 ch-pos)))
    (define token (doc-token-at doc raw-pos))
    (define query-pos
      (if (and token (eq? 'close-paren (LexerEntry-type token)))
          (add1 raw-pos)
          raw-pos))
    (define maybe-paren-pos (doc-find-containing-paren doc query-pos))
    (define start-pos (if maybe-paren-pos maybe-paren-pos 0))
    (Range (doc-abs-pos->pos doc start-pos)
           (doc-abs-pos->pos doc current-line-end-pos)))

  (match ch
    [(or ")" "]") (containing-form-range)]
    [_ (current-line-range)]))

;; Shared path for all formatting requests
(define/contract (doc-format-edits doc fmt-range
                                   #:formatting-options opts
                                   #:backend [backend 'fixw]
                                   #:fmt-settings [fmt-settings empty-fmt-settings]
                                   #:on-type? [on-type? #f])
  (->* (Doc? Range? #:formatting-options FormattingOptions?)
       (#:backend symbol?
        #:fmt-settings Fmt-Settings?
        #:on-type? boolean?)
       (listof TextEdit?))
  (define doc-text (Doc-text doc))
  (define-values (start-line end-line)
    (formatting-range->lines doc-text fmt-range))
  (formatting doc-text
              start-line
              end-line
              #:formatting-options opts
              #:backend backend
              #:fmt-settings fmt-settings
              #:lexer-state (doc-lexer-state doc)
              #:src-dir (doc-src-dir doc)
              #:interactive? on-type?))

(define/contract (doc-on-type-format-edits doc pos ch
                                           #:formatting-options opts
                                           #:backend [backend 'fixw])
  (->* (Doc? Pos? string? #:formatting-options FormattingOptions?)
       (#:backend symbol?)
       (listof TextEdit?))
  (cond
    [(doc-sexp-language? doc)
     (doc-format-edits doc
                       (doc-on-type-formatting-range doc pos ch)
                       #:backend backend
                       #:on-type? #t
                       #:formatting-options opts)]
    [else '()]))

;; Return semantic tokens whose spans intersect [pos-start, pos-end), merging
;; trace tokens with current lexer-derived sexp-comment tokens.
(define/contract (doc-range-tokens doc range)
  (-> Doc? Range? (listof SemanticToken?))
  (define pos-start (clamped-abs-pos doc (Range-start range)))
  (define pos-end (clamped-abs-pos doc (Range-end range)))
  (split-semantic-tokens-by-line
    doc
    (filter (λ (token)
              (char-range-intersect?
                (SemanticToken-start token)
                (SemanticToken-end token)
                pos-start pos-end))
            (doc-semantic-tokens doc))))

(define (doc-sexp-comment-semantic-tokens doc)
  (for/list ([span (in-list (lexer-state-sexp-comment-spans (doc-lexer-state doc)))])
    (SemanticToken (CharRange-start span) (CharRange-end span) SemanticTokenType-comment '())))

(define (doc-declaration-provider doc)
  (define adapter (LexerState-adapter (doc-lexer-state doc)))
  (and adapter ((current-language-adapter-declarations) adapter)))

(define (doc-native-declarations doc)
  (define state (doc-lexer-state doc))
  (define adapter (LexerState-adapter state))
  (and adapter ((current-language-adapter-validator) adapter)
       (hash-ref (or (LexerState-editor-facts state) (hasheq)) 'declarations #f)))

(define (declaration-tree-list declarations)
  (append-map (lambda (d) (cons d (declaration-tree-list (hash-ref d 'children '())))) declarations))

(define (doc-native-declaration-at doc pos declarations)
  (define entries (declaration-tree-list declarations))
  (define definitions
    (if (doc-trace-latest? doc)
        (send (send (Doc-trace doc) get-declaration) definition-ranges-at pos) '()))
  (define candidates
    (filter (lambda (d)
              (define selection (hash-ref d 'selection))
              (or (<= (car selection) pos (sub1 (cdr selection)))
                  (for/or ([range (in-list definitions)])
                    (<= (CharRange-start range) (car selection) (cdr selection) (CharRange-end range))))) entries))
  (and (= (length candidates) 1) (car candidates)))

(define (native-symbol-kind kind)
  (case kind
    [(function macro) SymbolKind-Function] [(class) SymbolKind-Class]
    [(struct) SymbolKind-Struct] [(field) SymbolKind-Field] [(method) SymbolKind-Method]
    [(namespace) SymbolKind-Namespace] [(module) SymbolKind-Module]
    [(operator) SymbolKind-Operator] [else SymbolKind-Variable]))

(define (native-semantic-kind kind)
  (case kind
    [(function) SemanticTokenType-function] [(macro) SemanticTokenType-macro]
    [(class struct) SemanticTokenType-class] [(field) SemanticTokenType-property]
    [(method) SemanticTokenType-method] [(namespace module) SemanticTokenType-namespace]
    [(operator) SemanticTokenType-operator] [else SemanticTokenType-variable]))

(define (doc-native-kind-tokens doc)
  (define declarations (doc-native-declarations doc))
  (define service (send (Doc-trace doc) get-declaration))
  (define kinds (make-hash))
  (define definitions (make-hash))
  (for ([d (in-list (declaration-tree-list (or declarations '())))])
    (define range (hash-ref d 'selection))
    (hash-set! definitions range #t)
    (define uses (if (doc-trace-latest? doc) (send service uses-at (car range)) '()))
    (for ([r (in-list (cons (CharRange (car range) (cdr range)) uses))])
      (define key (cons (CharRange-start r) (CharRange-end r)))
      (hash-update! kinds key (lambda (xs) (cons (hash-ref d 'kind) xs)) '())))
  (sort
   (for/list ([(r ks) (in-hash kinds)])
     (SemanticToken (car r) (cdr r)
                    (native-semantic-kind (if (andmap (lambda (k) (eq? k (car ks))) ks) (car ks) 'variable))
                    (if (hash-ref definitions r #f) (list SemanticTokenModifier-definition) '())))
   < #:key SemanticToken-start))

(define (doc-semantic-tokens doc)
  (define trace-tokens
    (sort (send (Doc-trace doc) get-semantic-tokens) < #:key SemanticToken-start))
  (define sexp-comment-tokens
    (sort (doc-sexp-comment-semantic-tokens doc) < #:key SemanticToken-start))
  (define binding-tokens (sort (doc-binding-kind-tokens doc trace-tokens) < #:key SemanticToken-start))
  (merge-semantic-tokens
   (merge-semantic-tokens (merge-semantic-tokens trace-tokens binding-tokens) (doc-native-kind-tokens doc))
   sexp-comment-tokens))

(define (merge-semantic-tokens tokens high-priority-tokens [merged '()])
  (define (continue-merge tokens merged)
    (cond [(empty? tokens)
           (reverse merged)]
          [else
           (continue-merge (rest tokens) (cons (car tokens) merged))]))

  (define (merge-non-empty-stream tokens high-priority-tokens merged)
    (define ht (car high-priority-tokens))
    (define t (car tokens))
    (define ht-start (SemanticToken-start ht))
    (define ht-end (SemanticToken-end ht))
    (define t-start (SemanticToken-start t))
    (define t-end (SemanticToken-end t))
    (cond [(<= t-end ht-start)
           (merge-semantic-tokens (cdr tokens) high-priority-tokens (cons t merged))]
          [(<= ht-end t-start)
           (merge-semantic-tokens tokens (cdr high-priority-tokens) (cons ht merged))]
          [else
           (merge-semantic-tokens (cdr tokens) high-priority-tokens merged)]))

  (cond [(empty? high-priority-tokens)
         (continue-merge tokens merged)]
        [(empty? tokens)
         (continue-merge high-priority-tokens merged)]
        [else
         (merge-non-empty-stream tokens high-priority-tokens merged)]))

(define (split-semantic-tokens-by-line doc tokens)
  (for*/list ([token (in-list tokens)]
              [tstart (in-value (SemanticToken-start token))]
              [tend (in-value (SemanticToken-end token))]
              [type (in-value (SemanticToken-type token))]
              [modifiers (in-value (SemanticToken-modifiers token))]
              [start-line (in-value (Pos-line (doc-abs-pos->pos doc tstart)))]
              [end-line (in-value (Pos-line (doc-abs-pos->pos doc (sub1 tend))))]
              [line (in-range start-line (add1 end-line))]
              [start (in-value (max tstart (doc-line-start-abs-pos doc line)))]
              [end (in-value (min tend (doc-line-end-abs-pos doc line)))])
    (SemanticToken start end type modifiers)))

(define/contract (doc-token-at doc pos)
  (-> Doc? exact-nonnegative-integer? (or/c LexerEntry? #f))
  (lexer-snapshot-token-at (doc-lexer-snapshot doc) pos))

(define/contract (doc-token-prefix-at doc pos)
  (-> Doc? exact-nonnegative-integer? string?)
  (define lexer-snapshot (doc-lexer-snapshot doc))
  (define token
    (lexer-snapshot-token-at lexer-snapshot pos))
  (cond
    [(not token) ""]
    [else
     (define token-start (LexerEntry-start token))
     (substring (LexerEntry-text token)
                0
                (add1 (- pos token-start)))]))

(define (abs-range->range doc start end)
  (Range (doc-abs-pos->pos doc start) (doc-abs-pos->pos doc end)))

;; Build hover cards: read from the hover and Typed Racket services and the
;; docs map, build a `Hover-Card`, then render. Lookup stays here so
;; `hover.rkt` stays testable without expansion.
;;
;; Performance: hot path is interval-map lookup plus limited reads from the
;; live buffer. No re-lex, expand, or cross-file load. Do not wait for
;; `doc-trace-latest?`; shifted source detail and retained types may be wrong
;; or incomplete while a trace is old.
;; Caps live in `max-hover-source-*` here and the comment caps in
;; `service/hover/detail.rkt`; keep Scribble `doc-hover` in sync.

(define (hover-tag->signature tag)
  ;; Prefer bluebox signatures over HTML for the definition fence. They indent
  ;; better. When this returns #f, `hover-documentation-text` may still take a
  ;; signature from HTML docs via #:include-signature? #t.
  (match-define (list signatures args-description)
    (if tag
        (get-docs-for-tag tag)
        (list #f #f)))
  (and (pair? signatures)
       (~a (string-join signatures "\n")
           (if args-description
               (~a "\n" args-description)
               ""))))

(define (hover-documentation-text link signature)
  ;; Skip the HTML signature when a bluebox signature already fills the
  ;; definition slot. Otherwise `extract-documentation` puts the same signature
  ;; in the docs body (see #:include-signature? in documentation-parser.rkt).
  (if link
      (or (extract-documentation-for-selected-element
            link #:include-signature? (not signature))
          "")
      ""))

(define max-hover-source-lines 10)
(define max-hover-source-characters 1000)

;; Apply `max-hover-source-lines` and `max-hover-source-characters`.
;; Return the retained text and whether the excerpt omitted source.
;; `truncated-after?` is true when detail ranges end before `source-end`, even
;; if the buffer read itself is shorter.
(define (bound-hover-source text #:truncated-after? [truncated-after? #f])
  (define newline-positions
    (regexp-match-positions* #px"\n" text))
  (define source-line-end
    (if (>= (length newline-positions) max-hover-source-lines)
        (car (list-ref newline-positions (sub1 max-hover-source-lines)))
        (string-length text)))
  (define source-character-end
    (min source-line-end max-hover-source-characters))
  (define retained-text
    (substring text 0 source-character-end))
  (define truncated?
    (or truncated-after?
        (< source-character-end (string-length text))))
  (values retained-text truncated?))

;; Ranges begin at a form/comment token, not at its physical line start.
;; Restore its column before measuring the shared indent. Tabs count as one
;; whitespace character. Dedenting is display-only and also applies to
;; continuation lines inside multiline literals.
(define (hover-source-lines doc start text)
  ;; Characters, not LSP columns: the column becomes leading spaces.
  (define doc-text (Doc-text doc))
  (define column (- start (send doc-text line-start-pos (send doc-text at-line start))))
  (string-split (string-append (make-string column #\space) text)
                "\n" #:trim? #f))

(define (hover-line-indentation line)
  (string-length (car (regexp-match #px"^[ \t]*" line))))

(define (hover-common-indentation lines)
  (define indentations
    (for/list ([line (in-list lines)]
               ;; Ignore blank lines so their whitespace does not constrain the shared indent.
               #:unless (regexp-match? #px"^[ \t\r]*$" line))
      (hover-line-indentation line)))
  (if (null? indentations) 0 (apply min indentations)))

(define (dedent-hover-line line indentation)
  ;; Short blank lines can have less whitespace than the shared indent.
  (substring line (min indentation (hover-line-indentation line))))

(define (hover-comment-line-in-bounds? line doc-end)
  (define line-start (Hover-Comment-Line-start line))
  (define line-end (Hover-Comment-Line-end line))
  (and (< line-start line-end)
       (<= line-end doc-end)))

(define (hover-comment-lines-in-bounds? comment-lines doc-end)
  (for/and ([line (in-list comment-lines)])
    (hover-comment-line-in-bounds? line doc-end)))

(define (hover-comment-line->lines doc line)
  (define line-start (Hover-Comment-Line-start line))
  (define line-end (Hover-Comment-Line-end line))
  (define line-text (send (Doc-text doc) get-text line-start line-end))
  (hover-source-lines doc line-start line-text))

(define (hover-detail-ranges-valid? detail doc-end)
  (define source-start (Hover-Detail-source-start detail))
  (define display-start (Hover-Detail-display-start detail))
  (define display-end (Hover-Detail-display-end detail))
  (define source-end (Hover-Detail-source-end detail))
  (and (<= source-start display-start)
       (< display-start display-end)
       (<= display-end source-end)
       (<= source-end doc-end)))

(define (hover-detail-truncated-after? detail read-end)
  (define display-end (Hover-Detail-display-end detail))
  (define source-end (Hover-Detail-source-end detail))
  (or (< read-end display-end)
      (< display-end source-end)))

(define (hover-detail->code-lines doc detail)
  (define display-start (Hover-Detail-display-start detail))
  (define display-end (Hover-Detail-display-end detail))
  (define read-end (min display-end
                        (+ display-start max-hover-source-characters)))
  (define source-text (send (Doc-text doc) get-text display-start read-end))
  (define-values (retained-text truncated?)
    (bound-hover-source
      source-text
      #:truncated-after? (hover-detail-truncated-after? detail read-end)))
  (values (hover-source-lines doc display-start retained-text) truncated?))

(define (hover-detail->summary doc detail)
  (define doc-end (doc-end-abs-pos doc))
  (and (hover-detail-ranges-valid? detail doc-end)
       (let ()
         (define-values (code-lines code-truncated?)
           (hover-detail->code-lines doc detail))
         (define stored-comment-lines (Hover-Detail-comment-lines detail))
         (define comment-lines
           (if (hover-comment-lines-in-bounds? stored-comment-lines doc-end)
               stored-comment-lines
               '()))
         (define comment-line-groups
           (for/list ([line (in-list comment-lines)])
             (hover-comment-line->lines doc line)))
         ;; Measure retained source only. Generated markers must not set the minimum.
         (define indentation
           (hover-common-indentation (append (append* comment-line-groups) code-lines)))
         (Hover-Code-Summary
           (string-join
             (append
               (for/list ([line (in-list comment-lines)]
                          [lines (in-list comment-line-groups)])
                 (string-append
                   (string-join
                     (for/list ([comment-line (in-list lines)])
                       (dedent-hover-line comment-line indentation))
                     "\n")
                   (if (Hover-Comment-Line-truncated? line) "..." "")))
               (if (and (pair? comment-lines) (Hover-Detail-comments-truncated? detail))
                   (list "...")
                   '())
               (for/list ([line (in-list code-lines)])
                 (dedent-hover-line line indentation))
               ;; A truncated code excerpt ends with its own indented marker.
               ;; Do not add a leading marker or invent closing delimiters.
               (if code-truncated? (list "  ...") '()))
             "\n")
           (Hover-Detail-fence-language detail)))))

;; Find same-file detail through the resolved binding. Keep the use span
;; even when no stored detail exists yet, so annotation-range fallback works.
(define (hover-detail-via-declaration hover-service declaration-service pos)
  (define occurrence-range (send declaration-service occurrence-at pos))
  (define definition-range (send declaration-service definition-at pos))
  (cond
    [definition-range
     (define-values (_definition-start _definition-end detail)
       (send hover-service source-detail-at (CharRange-start definition-range)))
     (values (CharRange-start occurrence-range)
             (CharRange-end occurrence-range)
             detail)]
    [else
     (values #f #f #f)]))

;; Notes from analysis facts that are not part of a binding's hover card:
;; syntax-template binding predictions and relative tail positions. Returns
;; Markdown text and its range, or #f #f. Facts from an older expansion are suppressed until it is replaced.
(define/contract (doc-hover-notes doc pos)
  (-> Doc? Pos? (values (or/c string? #f) (or/c Range? #f)))
  (define doc-trace (Doc-trace doc))
  (define pos* (doc-pos->abs-pos doc pos))
  (define-values (prediction-start prediction-end prediction-kind)
    (if (doc-trace-latest? doc)
        (send (send doc-trace get-hover) predicted-binding-at pos*)
        (values #f #f #f)))
  (define prediction-text
    (and prediction-kind
         (string-append
          "**Predicted binding**\n\n"
          (if (eq? prediction-kind 'mixed)
              "This source location has confirmed bindings and syntax-template predictions. "
              "Binding information for this syntax-template occurrence is predicted. ")
          "Expansion can give the template a different binding.")))
  (define-values (tail-start tail-end tail-parents tail-children)
    (if (doc-trace-latest? doc)
        (send (send doc-trace get-tails) at pos*)
        (values #f #f '() '())))
  (define (tail-locations positions)
    (define shown (take positions (min 8 (length positions))))
    (string-append
     (string-join
      (for/list ([position (in-list shown)])
        (define point (doc-abs-pos->pos doc position))
        (format "line ~a, column ~a" (add1 (Pos-line point)) (add1 (Pos-char point))))
      "; ")
     (if (> (length positions) 8) (format "; and ~a more" (- (length positions) 8)) "")))
  (define tail-text
    (and tail-start
         (string-join
          (filter values
                  (list "**Tail position**"
                        (and (pair? tail-parents)
                             (string-append "In tail position relative to the expression at "
                                            (tail-locations tail-parents) "."))
                        (and (pair? tail-children)
                             (string-append "Expressions in tail position relative to this one: "
                                            (tail-locations tail-children) "."))))
          "\n\n")))
  (define notes (filter values (list prediction-text tail-text)))
  (if (pair? notes)
      (values (string-join notes "\n\n")
              (abs-range->range doc (or prediction-start tail-start) (or prediction-end tail-end)))
      (values #f #f)))

;; Join analysis notes with a hover card. Notes open a hover on their own.
(define/contract (hover-with-notes card range notes notes-range)
  (-> Hover-Card? (or/c Range? #f) (or/c string? #f) (or/c Range? #f) (or/c Hover? #f))
  (and (or notes (hover-card-opens? card))
       (Hover #:contents (string-join (filter non-empty-string? (list (or notes "") (render-hover-card card)))
                                      "\n\n")
              #:range (or range notes-range))))

(define/contract (doc-hover-data doc pos)
  (-> Doc? Pos? (values Hover-Card? (or/c Range? #f)))
  (define doc-trace (Doc-trace doc))
  (define hover-service (send doc-trace get-hover))
  (define declaration-service (send doc-trace get-declaration))
  (define typed-racket-service
    (send doc-trace get-typed-racket))
  (define pos* (doc-pos->abs-pos doc pos))
  (define-values (start end annotation)
    (send hover-service annotation-at pos*))
  (define-values (type-start type-end type-text)
    (send typed-racket-service inferred-type-at pos*))
  ;; While a trace refreshes, show current buffer text from shifted ranges.
  ;; The binding link or retained type may be old or wrong.
  (define-values (detail-start detail-end detail)
    (send hover-service source-detail-at pos*))
  (define-values (use-start use-end resolved-detail)
    (if detail
        (values detail-start detail-end detail)
        (hover-detail-via-declaration hover-service declaration-service pos*)))
  (match-define (list link tag)
    (interval-map-ref (send doc-trace get-docs) pos* (list #f #f)))
  (define native
    (doc-native-declaration-at doc pos* (or (doc-native-declarations doc) '())))
  (define source-summary
    (and (not link)
         (or (and native
                  (let* ([signatures (hash-ref native 'signatures '())]
                         [range (hash-ref native 'range)]
                         [text (if (pair? signatures) (hash-ref (car signatures) 'label)
                                   (substring (doc-get-text doc) (car range) (cdr range)))])
                    (define-values (bounded _) (bound-hover-source text))
                    (Hover-Code-Summary bounded
                      (if (eq? (Language-Policy-policy-language (doc-language-policy doc)) 'rhombus)
                          "rhombus" "racket"))))
             (and resolved-detail (hover-detail->summary doc resolved-detail)))))
  (define declared-annotations (and native (hash-ref native 'annotations '())))
  (define signature (hover-tag->signature tag))
  (define card
    (build-hover-card #:type-text (or type-text (and (pair? declared-annotations) (string-join declared-annotations "\n")))
                      #:type-stale? (not (doc-trace-latest? doc))
                      #:annotation annotation
                      #:link (and link (make-proper-url-for-online-documentation link))
                      #:signature signature
                      #:source-summary source-summary
                      #:documentation-text (hover-documentation-text link signature)))
  (define occurrence (send declaration-service occurrence-at pos*))
  (define native-range
    (and native (or (send declaration-service occurrence-at pos*)
                    (let ([r (hash-ref native 'selection)]) (CharRange (car r) (cdr r))))))
  (define range-start (or (and native-range (CharRange-start native-range)) type-start start use-start
                          (and occurrence (CharRange-start occurrence))))
  (define range-end (or (and native-range (CharRange-end native-range)) type-end end use-end
                        (and occurrence (CharRange-end occurrence))))
  (values card (and range-start (abs-range->range doc range-start range-end))))

(define/contract (doc-hover doc pos)
  (-> Doc? Pos? (or/c Hover? #f))
  (define-values (card range) (doc-hover-data doc pos))
  (define-values (notes notes-range) (doc-hover-notes doc pos))
  (hover-with-notes card range notes notes-range))

;; Extract bounded declaration summaries while the worker owns the completed
;; Doc. Freeze text; response threads never consult its mutable services/buffer.
(define/contract (doc-hover-summaries doc)
  (-> Doc? (hash/c Module-Binding? Hover-Code-Summary? #:immutable #t))
  (define service (send (Doc-trace doc) get-hover))
  (for/fold ([summaries (hash)])
            ([(binding location) (in-hash (if (Doc-contribution doc)
                                              (Doc-Contribution-definitions (Doc-contribution doc))
                                              (hash)))])
    (define-values (_start _end detail)
      (send service source-detail-at
            (doc-pos->abs-pos doc (Range-start (Location-range location)))))
    (define summary (and detail (hover-detail->summary doc detail)))
    (if summary
        (hash-set summaries binding
                  (Hover-Code-Summary
                    (string->immutable-string (Hover-Code-Summary-text summary))
                    (string->immutable-string (Hover-Code-Summary-fence-language summary))))
        summaries)))

;; Some clients spell a viewport end as a line past the last one. The range is
;; only a filter bound here, so clamp instead of failing the request.
(define (clamped-abs-pos doc pos)
  (define document-end (doc-end-abs-pos doc))
  (define end-pos (doc-abs-pos->pos doc document-end))
  (cond
    [(or (> (Pos-line pos) (Pos-line end-pos))
         (and (= (Pos-line pos) (Pos-line end-pos))
              (> (Pos-char pos) (Pos-char end-pos))))
     document-end]
    [else (doc-pos->abs-pos doc pos)]))

;; The hints the trace read for this document, in protocol form. What a
;; language publishes hints for was decided when they were read.
(define/contract (doc-inlay-hints doc range)
  (-> Doc? Range? (listof InlayHint?))
  (define req-start (clamped-abs-pos doc (Range-start range)))
  (define req-end (clamped-abs-pos doc (Range-end range)))
  (define anchors
    (send (send (Doc-trace doc) get-inlay-hints)
          hints-in-range
          req-start
          req-end))
  (for/list ([anchor (in-list anchors)])
    (InlayHint #:position (doc-abs-pos->pos doc (Inlay-Hint-Anchor-pos anchor))
               #:label (Inlay-Hint-Anchor-label anchor)
               #:kind (Inlay-Hint-Anchor-kind anchor)
               #:tooltip (Inlay-Hint-Anchor-tooltip anchor))))

(define/contract (doc-code-action doc range)
  (-> Doc? Range? (listof CodeAction?))
  (define doc-trace (Doc-trace doc))
  (define req-start (doc-pos->abs-pos doc (Range-start range)))
  (define req-end (doc-pos->abs-pos doc (Range-end range)))
  (define trace-actions
    (interval-map-overlap-values (send doc-trace get-quickfixs)
                                 req-start
                                 req-end))

  (define resyntax-actions
    (for/list ([res (in-list (doc-get-resyntax-results doc))]
               #:when (char-range-intersect?
                        req-start
                        req-end
                        (Resyntax-Result-start res)
                        (Resyntax-Result-end res)))
      (resyntax-result->code-action doc res)))

  (append trace-actions resyntax-actions))

(define (doc-signature-form-head-pos doc query-pos)
  (define maybe-head (lexer-state-form-head-at (doc-lexer-state doc) query-pos))
  (and maybe-head (LexerTokenSpan-start maybe-head)))

(define (doc-signature-tag doc-trace snapshot callee-pos)
  (define maybe-docs-entry
    (interval-map-ref (send doc-trace get-docs) callee-pos #f))
  (cond
    [maybe-docs-entry (last maybe-docs-entry)]
    [else
     (define maybe-symbol (lexer-snapshot-symbol-at snapshot callee-pos))
     (and maybe-symbol
          (id-to-tag (LexerEntry-text maybe-symbol) doc-trace))]))

(define (tag->signature-help tag)
  (match-define (list signatures docs) (get-docs-for-tag tag))
  (and signatures
       (SignatureHelp
         #:activeSignature (Nothing)
         #:activeParameter (Nothing)
         #:signatures
         (for/list ([signature (in-list signatures)])
           (SignatureInformation
             #:label signature
             #:parameters (Nothing)
             #:documentation (or docs ""))))))

(define (doc-native-signature-help doc pos)
  (define adapter (LexerState-adapter (doc-lexer-state doc)))
  (define provider (and adapter ((current-language-adapter-validator) adapter)
                        ((current-language-adapter-calls) adapter)))
  (define call
    (and provider
         (provider
          (hasheq 'operation 'call 'uri (Doc-uri doc) 'text (doc-get-text doc) 'position pos
                  'pre #f 'expanded #f 'reader #f 'language #f 'submodules '()
                  'phase #f 'space #f 'selection #f 'cancelled? (lambda () #f)
                  'facts (or (LexerState-editor-facts (doc-lexer-state doc)) (hasheq))
                  'hooks (hasheq 'declaration-at
                                 (lambda (p) (doc-native-declaration-at doc p (or (doc-native-declarations doc) '()))))))))
  (and call (pair? (hash-ref call 'signatures '()))
       (SignatureHelp
        #:signatures
        (for/list ([signature (in-list (hash-ref call 'signatures))])
          (SignatureInformation
           #:label (hash-ref signature 'label)
           #:documentation (or (hash-ref signature 'documentation #f) "")
           #:parameters
           (for/list ([parameter (in-list (hash-ref signature 'parameters '()))])
             (ParameterInformation #:label (hash-ref parameter 'label)
                                   #:documentation (or (hash-ref parameter 'documentation #f) "")))))
        #:activeSignature (hash-ref call 'active-signature 0)
        #:activeParameter (hash-ref call 'active-parameter (hash-ref call 'argument)))))

(define/contract (doc-signature-help doc pos)
  (-> Doc? Pos? (or/c SignatureHelp? #f))
  (define pos* (doc-pos->abs-pos doc pos))
  (or (doc-native-signature-help doc pos*)
      (let* ([doc-trace (Doc-trace doc)]
             [callee-pos (doc-signature-form-head-pos doc pos*)]
             [tag (and callee-pos
                       (doc-signature-tag doc-trace (doc-lexer-snapshot doc) callee-pos))])
        (and tag (tag->signature-help tag)))))

;; Position queries convert service-owned absolute CharRanges at the document
;; boundary. Private declaration ids never leave declaration%.
(define/contract (doc-occurrence-at doc pos)
  (-> Doc? Pos? (or/c Range? #f))
  (define pos* (doc-pos->abs-pos doc pos))
  (define range
    (send (send (Doc-trace doc) get-declaration) occurrence-at pos*))
  (and range
       (abs-range->range doc (CharRange-start range) (CharRange-end range))))

(define/contract (doc-definition-at doc pos)
  (-> Doc? Pos? (or/c Range? #f))
  (define ranges (doc-definition-ranges-at doc pos))
  (and (= (length ranges) 1) (car ranges)))

(define/contract (doc-definition-ranges-at doc pos)
  (-> Doc? Pos? (listof Range?))
  (define pos* (doc-pos->abs-pos doc pos))
  (for/list ([range (in-list (send (send (Doc-trace doc) get-declaration) definition-ranges-at pos*))])
    (abs-range->range doc (CharRange-start range) (CharRange-end range))))

(define/contract (doc-uses-at doc pos)
  (-> Doc? Pos? (listof Range?))
  (define pos* (doc-pos->abs-pos doc pos))
  (for/list ([range (in-list (send (send (Doc-trace doc) get-declaration) uses-at pos*))])
    (abs-range->range doc (CharRange-start range) (CharRange-end range))))

;; Same-document ranges of the binding at pos: definition first when it
;; exists, then uses. Imported bindings have no definition range here.
(define/contract (doc-binding-ranges-at doc pos)
  (-> Doc? Pos? (listof Range?))
  (remove-duplicates
    (append (doc-definition-ranges-at doc pos) (doc-uses-at doc pos))))

(define/contract (doc-module-bindings-at doc pos)
  (-> Doc? Pos? (listof Module-Binding?))
  (define pos* (doc-pos->abs-pos doc pos))
  (send (send (Doc-trace doc) get-declaration) module-bindings-at pos*))

(define/contract (doc-module-binding-at doc pos)
  (-> Doc? Pos? (or/c Module-Binding? #f))
  (define bindings (doc-module-bindings-at doc pos))
  (and (= (length bindings) 1) (car bindings)))

(define (doc-completion-online-prefix token left-fragment cursor-pos)
  ;; Only two token classes currently produce a useful module-path prefix in
  ;; end-to-end completion behavior: `symbol` for ordinary path text such as
  ;; `racket/base`, and `string` for quoted module paths such as
  ;; `"racket/base"`.
  ;;
  ;; Other lexer classes either represent structural syntax or do not improve
  ;; the prefix we can hand to the module-name completion backend, so we treat
  ;; them the same as "no prefix".
  (define (completion-prefix-token? token)
    (memq (LexerEntry-type token)
          '(string symbol)))

  (cond
    [(not token) left-fragment]
    [(not (completion-prefix-token? token)) ""]
    [(eq? (LexerEntry-type token) 'string)
     (define token-start (LexerEntry-start token))
     (define token-end (LexerEntry-end token))
     (cond
       [(or (= (sub1 cursor-pos) token-start)
            (= (sub1 cursor-pos) (sub1 token-end)))
        ""]
       [else
        (substring left-fragment 1)])]
    [else left-fragment]))

;; Completion: returns a CompletionList.
(define/contract (doc-completion doc pos)
  (-> Doc? Pos? CompletionList?)
  (let/ec return
    (define doc-trace (Doc-trace doc))
    (define cursor-pos (doc-pos->abs-pos doc pos))
    (define state (doc-lexer-state doc))
    (define adapter (LexerState-adapter state))
    (define provider (and adapter ((current-language-adapter-validator) adapter)
                          ((current-language-adapter-completion) adapter)))
    (define native
      (and provider (hash-has-key? (or (LexerState-editor-facts state) (hasheq)) 'completion)
           (provider
            (hasheq 'operation 'completion 'uri (Doc-uri doc) 'text (doc-get-text doc) 'position cursor-pos
                    'pre #f 'expanded #f 'reader #f 'language #f 'submodules '()
                    'phase #f 'space #f 'selection #f 'cancelled? (lambda () #f)
                    'facts (or (LexerState-editor-facts state) (hasheq)) 'hooks (hasheq)))))
    (when native
      (define r (hash-ref native 'range))
      (define range (Range (doc-abs-pos->pos doc (car r)) (doc-abs-pos->pos doc (cdr r))))
      (return
       (CompletionList #:isIncomplete (hash-ref native 'incomplete?)
                       #:items (for/list ([item (in-list (hash-ref native 'items))])
                                 (CompletionItem #:label (hash-ref item 'label)
                                                 #:textEdit (TextEdit #:range range
                                                                      #:newText (hash-ref item 'insert-text (hash-ref item 'label))))))))
    (define lexer-snapshot (doc-lexer-snapshot doc))
    (define token
      (and (positive? cursor-pos)
           (lexer-snapshot-token-at lexer-snapshot (sub1 cursor-pos))))
    (define left-fragment
      (if (zero? cursor-pos)
          ""
          (doc-token-prefix-at doc (sub1 cursor-pos))))

    (define online-prefix
      (doc-completion-online-prefix token left-fragment cursor-pos))
    (define completions
      (append (doc-binding-completions doc cursor-pos (send doc-trace get-completions))
              (send doc-trace get-online-completions online-prefix)))
    (define result
      (for/list ([completion (in-list completions)])
        (CompletionItem #:label (symbol->string completion) #:textEdit (Nothing))))
    (CompletionList #:isIncomplete #t
                    #:items result)))

;; Document-local capture returns a local location or a module binding, and
;; combines both kinds for shared occurrences. LSP composition resolves module
;; bindings on the shared analysis route, after this document's lock is released.
(define/contract (doc-definition doc uri pos)
  (-> Doc? string? Pos? (or/c Location? Module-Binding? (listof (or/c Location? Module-Binding?)) #f))
  (define definition-range (doc-definition-at doc pos))
  (cond
    [(send (send (Doc-trace doc) get-declaration) component-definition-at (doc-pos->abs-pos doc pos))
     (Location #:uri uri #:range definition-range)]
    [(> (send (send (Doc-trace doc) get-declaration) binding-count-at (doc-pos->abs-pos doc pos)) 1)
     (append (for/list ([range (in-list (doc-definition-ranges-at doc pos))])
               (Location #:uri uri #:range range))
             (if (source-file-path (Doc-source doc)) (doc-module-bindings-at doc pos) '()))]
    [definition-range
     (Location #:uri uri
               #:range definition-range)]
    [(not (source-file-path (Doc-source doc))) #f]
    [else
     (define bindings (doc-module-bindings-at doc pos))
     (cond [(null? bindings) #f]
           [(null? (cdr bindings)) (car bindings)]
           [else bindings])]))

;; References: live locations and every module identity at this occurrence.
;; A single identity retains the scalar representation used by existing callers.
(define/contract (doc-references doc uri pos include-decl?)
  (-> Doc? string? Pos? boolean? (or/c Document-Reference-Result? #f))
  (define occurrence-range (doc-occurrence-at doc pos))
  (cond
    [occurrence-range
     (define absolute (doc-pos->abs-pos doc pos))
     (define decls (send (Doc-trace doc) get-declaration))
     (define ranges
       (for/list ([range (in-list (send decls reference-ranges-at absolute include-decl?))])
         (abs-range->range doc (CharRange-start range) (CharRange-end range))))
     (define local-locations
       (for/list ([range (in-list ranges)])
         (Location #:uri uri #:range range)))
     (Document-Reference-Result
       (Reference-Source (source-id (Doc-source doc)) local-locations)
       (and (source-file-path (Doc-source doc))
            (let ([bindings (send decls reference-module-bindings-at absolute)])
              (cond [(null? bindings) #f]
                    [(null? (cdr bindings)) (car bindings)]
                    [else bindings]))))]
    [else #f]))

;; Document Highlight: returns binding highlights or an empty list.
(define/contract (doc-highlights doc pos)
  (-> Doc? Pos? (listof DocumentHighlight?))
  (define occurrence-range (doc-occurrence-at doc pos))
  (cond
    [occurrence-range
     (for/list ([range (in-list (doc-binding-ranges-at doc pos))])
       (DocumentHighlight #:range range))]
    [else '()]))

(define (doc-rename-ranges doc pos)
  (define decls (send (Doc-trace doc) get-declaration))
  (define absolute (doc-pos->abs-pos doc pos))
  (define occurrence (doc-occurrence-at doc pos))
  (define definition (doc-definition-at doc pos))
  (define components (send decls component-edit-ranges-at absolute))
  (and (doc-trace-latest? doc) occurrence
       (or components (and definition
                           (not (send decls coarse-definition-at? absolute))
                           (not (send decls component-definition-at absolute))))
       (let* ([text (doc-get-text doc)]
              [start (doc-pos->abs-pos doc (Range-start occurrence))]
              [end (doc-pos->abs-pos doc (Range-end occurrence))]
              [spelling (substring text start end)]
              [ranges (if components
                          (map (lambda (range) (cons (CharRange-start range) (CharRange-end range))) components)
                          (map (lambda (range) (cons (doc-pos->abs-pos doc (Range-start range))
                                                    (doc-pos->abs-pos doc (Range-end range))))
                               (remove-duplicates
                                (append (doc-binding-ranges-at doc pos)
                                        (doc-binding-ranges-at doc (Range-start definition))))))])
         (and (identifier-name spelling)
              (pair? ranges)
              (andmap (lambda (range) (equal? (substring text (car range) (cdr range)) spelling)) ranges)
              (sort (remove-duplicates ranges) < #:key car)))))

(define (doc-rename-relations doc ranges name correspondence shift)
  (rename-token-relations
   (doc-get-text doc) (Doc-uri doc) ranges name correspondence
   (lambda (offset)
     (define pos (doc-abs-pos->pos doc offset))
     (define bindings (doc-module-bindings-at doc pos))
     (define definition (and (null? bindings) (doc-definition-at doc pos)))
     (cond [(pair? bindings) (list->set bindings)]
           [definition (cons (doc-pos->abs-pos doc (Range-start definition))
                             (doc-pos->abs-pos doc (Range-end definition)))]
           [else #f])) shift))

;; The live document supplies edit ranges; immutable expansions validate them.
;; A failed proposal returns no edits, including for virtual source URIs.
(define/contract (doc-rename doc uri pos new-name)
  (-> Doc? string? Pos? string? (or/c WorkspaceEdit? #f))
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (define ranges (and (identifier-name new-name) (doc-rename-ranges doc pos)))
    (and ranges
         (if (equal? (substring (doc-get-text doc) (caar ranges) (cdar ranges)) new-name)
             (WorkspaceEdit #:changes (hasheq))
         (let* ([text (doc-get-text doc)]
                [shift (rename-offset ranges new-name)]
                [before (make-doc (Doc-uri doc) text)]
                [after (make-doc (Doc-uri doc) (renamed-text text ranges new-name))])
           (define (expand-snapshot document)
             (define file (source-file-path (Doc-source document)))
             (call-with-source-snapshot (if file (hash file (doc-get-text document)) (hash))
               (lambda ()
                 (parameterize ([current-retain-binding-facts? #t])
                   (doc-expand! document #:contribution-only? #t)))))
           (and (expand-snapshot before)
                (expand-snapshot after)
                (let* ([paths (make-hash)]
                       [old (rename-snapshot (send (send (Doc-trace before) get-declaration) get-binding-facts)
                                             (Doc-source before) (doc-get-text before) paths)]
                       [new (rename-snapshot (send (send (Doc-trace after) get-declaration) get-binding-facts)
                                             (Doc-source after) (doc-get-text after) paths)]
                       [correspondence (rename-correspondence old new ranges new-name shift)])
                  (validate-rename-proposal old new ranges new-name correspondence
                                            (doc-rename-relations before ranges new-name correspondence shift)
                                            (doc-rename-relations after '() new-name (hash) values) shift)
                  (WorkspaceEdit
                   #:changes (hasheq (string->symbol uri)
                                     (for/list ([range (in-list ranges)])
                                       (TextEdit #:range (abs-range->range doc (car range) (cdr range))
                                                 #:newText new-name)))))))))))

(define/contract (doc-prepare-rename doc pos)
  (-> Doc? Pos? (or/c Range? #f))
  (and (doc-rename-ranges doc pos) (doc-occurrence-at doc pos)))

;; Document Symbols: returns a list of SymbolInformation.
(define/contract (doc-symbols doc uri)
  (-> Doc? string? (listof SymbolInformation?))

  (define (symbol-information-lexer-entry? entry)
    (memq (LexerEntry-type entry)
          '(constant string symbol)))

  (define (lexer-entry->symbol-kind entry)
    (match (LexerEntry-type entry)
      ['constant SymbolKind-Constant]
      ['string SymbolKind-String]
      ['symbol SymbolKind-Variable]))

  (for/list ([entry (in-lexer-snapshot (doc-lexer-snapshot doc))]
             #:when (symbol-information-lexer-entry? entry))
    (define range (abs-range->range doc (LexerEntry-start entry) (LexerEntry-end entry)))
    (SymbolInformation
      #:name (LexerEntry-text entry)
      #:kind (lexer-entry->symbol-kind entry)
      #:location (Location #:uri uri
                           #:range range))))

;; Hierarchical Document Symbols: returns a tree of DocumentSymbol.
;;
;; The tree is built by recursing over the lexer's token forest, which already
;; encodes paren nesting. Definition-like forms (define, struct, module+, ...)
;; become symbols whose `range` spans the whole form and whose `selectionRange`
;; covers the defined name; any other form is transparent and passes nested
;; definitions up to the enclosing symbol. The forest tolerates incomplete code
;; (forms left open mid-edit still parse to the end of the document), so the
;; symbol tree stays stable during editing.

;; Maps the head symbol of a form to how its SymbolKind is chosen. 'fn-or-var
;; picks Function when the defined name uses the function shorthand
;; (define (f x) ...) and Variable otherwise.
(define *definition-form-kinds*
  (hash "define" 'fn-or-var
        "define/contract" 'fn-or-var
        "define/public" 'fn-or-var
        "define/private" 'fn-or-var
        "define/override" 'fn-or-var
        "define/augment" 'fn-or-var
        "define-values" SymbolKind-Variable
        "define-syntax" 'fn-or-var
        "define-syntax-rule" SymbolKind-Function
        "define-syntaxes" SymbolKind-Variable
        "define-match-expander" SymbolKind-Function
        "define-struct" SymbolKind-Struct
        "struct" SymbolKind-Struct
        "module" SymbolKind-Module
        "module+" SymbolKind-Module
        "module*" SymbolKind-Module))

;; Container forms become a symbol named after their own head so that
;; scrolling inside a long body keeps a sticky header even though the form
;; defines no name itself.
(define *container-form-kinds*
  (hash "provide" SymbolKind-Namespace
        "require" SymbolKind-Namespace
        "class" SymbolKind-Class
        "class*" SymbolKind-Class
        "match" SymbolKind-Object
        "match*" SymbolKind-Object
        "cond" SymbolKind-Object
        "for" SymbolKind-Object
        "for/list" SymbolKind-Object
        "for/vector" SymbolKind-Object
        "for/hash" SymbolKind-Object
        "for/hasheq" SymbolKind-Object
        "for/hasheqv" SymbolKind-Object
        "for/hashalw" SymbolKind-Object
        "for/and" SymbolKind-Object
        "for/or" SymbolKind-Object
        "for/sum" SymbolKind-Object
        "for/product" SymbolKind-Object
        "for/lists" SymbolKind-Object
        "for/first" SymbolKind-Object
        "for/last" SymbolKind-Object
        "for/fold" SymbolKind-Object
        "for/foldr" SymbolKind-Object))

;; Class member forms: every name they declare becomes a Field symbol, either
;; a bare name as in (field z) or a binding group as in (field [y 0]).
(define *field-form-heads*
  (set "field" "init-field" "init"))

(define/contract (doc-symbols-hierarchical doc)
  (-> Doc? (listof DocumentSymbol?))
  ;; Paren tracking means nothing in non-sexp languages (e.g. Rhombus,
  ;; Scribble): form extents are set by blocks or markup rather than parens,
  ;; so any symbol the walker produced would have a bogus range. Report no
  ;; symbols without native declaration facts. Unknown languages keep the sexp
  ;; treatment, matching the lexer fallback used elsewhere.
  (define native (doc-native-declarations doc))
  (define (symbol d)
    (define extent (hash-ref d 'range))
    (define selection (hash-ref d 'selection))
    (DocumentSymbol #:name (hash-ref d 'name) #:kind (native-symbol-kind (hash-ref d 'kind))
                    #:range (abs-range->range doc (car extent) (cdr extent))
                    #:selectionRange (abs-range->range doc (car selection) (cdr selection))
                    #:children (map symbol (hash-ref d 'children '()))))
  (cond [native (map symbol native)]
        [(eq? (doc-language-body-mode doc) 'non-sexp) '()]
        [else (doc-symbols-hierarchical/sexp doc)]))

;; Walk the lexer's token forest. Each `(...)` form is a Token-List whose head
;; is its first meaningful child. A definition form becomes a symbol named after
;; the bound name, a container form a symbol named after its own head, and a
;; field form one Field symbol per declared name. Any other form is transparent:
;; it contributes its nested definitions to the enclosing scope. The forest
;; already tracks paren nesting and tolerates unclosed mid-edit forms, so this
;; reuses that structure instead of re-deriving it from the flat token stream.
(define (doc-symbols-hierarchical/sexp doc [on-binding void])
  (define text (LexerSnapshot-text (doc-lexer-snapshot doc)))
  (define service (send (Doc-trace doc) get-declaration))
  (define confirmed-ranges
    (for/hash ([binding (in-list (send service get-source-bindings))])
      (values (hash-ref binding 'range) #t)))
  (define in-transformer? (make-parameter #f))
  (define bindings-by-extent (make-hash))
  (for ([binding (in-list (send service get-source-bindings))]
        #:when (and (hash-ref binding 'declaration? #f) (hash-ref binding 'extent #f)))
    (hash-update! bindings-by-extent (hash-ref binding 'extent)
                  (lambda (bindings) (cons binding bindings)) '()))
  (define (span-text span)
    (substring text (LexerTokenSpan-start span) (LexerTokenSpan-end span)))

  (define (symbol-leaf? node)
    (and (Token-Leaf? node)
         (token-leaf-type? node 'symbol)))

  (define (meaningful nodes)
    (filter non-skippable-node? nodes))

  ;; The first symbol leaf in pre-order across `nodes`, descending into lists
  ;; and prefix forms. This is the bound name of a definition, e.g. `f` in
  ;; `(define (f x) ...)` or `a` in `(define-values (a b) ...)`.
  (define (first-symbol-span nodes)
    (for/or ([node (in-list (meaningful nodes))])
      (cond
        [(symbol-leaf? node) (Token-Leaf-span node)]
        [else (first-symbol-span (token-node-children node))])))

  (define (node->document-symbol node name-span kind children)
    (DocumentSymbol
      #:name (span-text name-span)
      #:kind kind
      #:range (abs-range->range doc
                                (token-node-start node)
                                (token-node-end node))
      #:selectionRange (abs-range->range doc
                                         (LexerTokenSpan-start name-span)
                                         (LexerTokenSpan-end name-span))
      #:children children))

  (define (definition-symbol-kind head function?)
    (match (hash-ref *definition-form-kinds* head)
      ['fn-or-var (if function? SymbolKind-Function SymbolKind-Variable)]
      [kind kind]))

  (define (collect-symbols nodes)
    (append-map (lambda (node)
                  ;; Symbols contributed by `node` to its enclosing scope.
                  (cond
                    [(Token-List? node) (list-symbols node)]
                    ;; A quoted/prefixed datum is transparent to symbol collection.
                    [(Token-Prefix-Tree? node) (collect-symbols (token-node-children node))]
                    [else '()]))
                (meaningful nodes)))

  (define (list-symbols node)
    (define forms (meaningful (Token-List-children node)))
    (define head-node (and (pair? forms) (car forms)))
    (define head (and head-node
                      (symbol-leaf? head-node)
                      (span-text (Token-Leaf-span head-node))))
    (define args (if (pair? forms) (cdr forms) '()))
    (cond
      [(and head (set-member? *field-form-heads* head)
            ;; A field form like `(field z)`, `(field [y 0])`, or a mix declares one Field
            ;; per argument: a bare name covers just the name, a binding group covers the
            ;; whole `[name v]`.
            (filter-map
              (lambda (node)
                (define name-span
                  (cond
                    [(symbol-leaf? node) (Token-Leaf-span node)]
                    [(Token-List? node) (first-symbol-span (Token-List-children node))]
                    [else #f]))
                (and name-span
                     (node->document-symbol node name-span SymbolKind-Field '())))
              args))]
      ;; A container form is its own name, so scrolling its body keeps a sticky
      ;; header even though the form binds no name itself.
      [(and head (hash-has-key? *container-form-kinds* head))
       (list (node->document-symbol node
                                    (Token-Leaf-span head-node)
                                    (hash-ref *container-form-kinds* head)
                                    (collect-symbols args)))]
      [(and head (hash-has-key? *definition-form-kinds* head))
       (define name-span (first-symbol-span args))
       (cond
         [(and name-span (in-transformer?)
               (not (hash-has-key? confirmed-ranges
                                   (cons (LexerTokenSpan-start name-span) (LexerTokenSpan-end name-span)))))
          (collect-symbols args)]
         [name-span
          ;; The function shorthand `(define (f x) ...)` puts the name inside a
          ;; nested list, so the first argument is a list rather than a symbol.
          (define function? (and (pair? args) (not (symbol-leaf? (car args)))))
          (list (node->document-symbol node
                                       name-span
                                       (definition-symbol-kind head function?)
                                       ;; The first argument is the name header;
                                       ;; nested definitions live in the body.
                                       (parameterize ([in-transformer?
                                                       (or (in-transformer?)
                                                           (member head '("define-syntax" "define-syntaxes" "define-syntax-rule")))])
                                         (collect-symbols (cdr args)))))]
         ;; A definition head with no name yet (mid-edit) is transparent.
         [else (collect-symbols args)])]
      [else
       (define bindings
         (hash-ref bindings-by-extent (cons (token-node-start node) (token-node-end node)) '()))
       (define children (collect-symbols args))
       (if (null? bindings) children
           (for/list ([group (in-list (group-by (lambda (binding) (hash-ref binding 'range))
                                                 (sort bindings < #:key (lambda (binding) (car (hash-ref binding 'range))))))])
             (for-each on-binding group)
             (define range (hash-ref (car group) 'range))
             (DocumentSymbol
              #:name (substring text (car range) (cdr range))
              #:kind (if (andmap (lambda (binding) (eq? (hash-ref binding 'kind) 'function)) group)
                         SymbolKind-Function SymbolKind-Variable)
              #:range (abs-range->range doc (token-node-start node) (token-node-end node))
              #:selectionRange (abs-range->range doc (car range) (cdr range))
              #:children children)))]))

  (collect-symbols (Token-Forest-nodes (doc-body-forest doc))))

;; The structural walker selects only additional declarations. Its existing
;; entries remain authoritative for structures, fields and incomplete forms.
(define (doc-binding-declarations doc)
  (define bindings '())
  (unless (eq? (doc-language-body-mode doc) 'non-sexp)
    (doc-symbols-hierarchical/sexp doc (lambda (binding) (set! bindings (cons binding bindings)))))
  bindings)

(define (doc-binding-completions doc pos legacy)
  (define service (send (Doc-trace doc) get-declaration))
  (binding-completions (send service get-binding-facts) (doc-binding-declarations doc)
                       (send service get-source-bindings) pos legacy))

(define (doc-binding-kind-tokens doc legacy)
  (define declarations (doc-binding-declarations doc))
  (cond
    [(null? declarations) '()]
    [else
     (define identities
       (for/hasheqv ([binding (in-list declarations)])
         (values (hash-ref binding 'identity) #t)))
     (define facts (send (send (Doc-trace doc) get-declaration) get-binding-facts))
     (define tokens (make-hash))
     (define definitions (make-hash))
     (for ([name (in-list (hash-ref facts 'names '()))]
           #:when (eq? (hash-ref name 'certainty 'confirmed) 'confirmed))
       (define kind (and (hash-has-key? identities (hash-ref name 'identity))
                         (hash-ref name 'kind #f)))
       (when kind
         (define range (hash-ref name 'range))
         (define previous (hash-ref tokens range #f))
         (when (eq? (hash-ref name 'role) 'definition) (hash-set! definitions range #t))
         ;; Several identities can share a spelling; only agreement proves a kind.
         (hash-set! tokens range (if (and previous (not (eq? previous kind))) 'variable kind))))
     (define old-tokens
       (for/hash ([token (in-list legacy)])
         (values (cons (SemanticToken-start token) (SemanticToken-end token)) token)))
     (for/list ([(range kind) (in-hash tokens)])
       (define old (hash-ref old-tokens range #f))
       (define modifiers (if old (SemanticToken-modifiers old) '()))
       (SemanticToken (car range) (cdr range)
                      (if (eq? kind 'function) SemanticTokenType-function SemanticTokenType-variable)
                      (if (and (hash-ref definitions range #f)
                               (not (memq SemanticTokenModifier-definition modifiers)))
                          (cons SemanticTokenModifier-definition modifiers) modifiers)))]))

(provide Doc?
         Doc-version
         Doc-uri
         Doc-source
         Doc-contribution
         (struct-out Doc-Contribution)
         make-doc
         make-source-doc
         doc-apply-edit!
         doc-apply-edits!
         doc-reset!
         doc-update-version!
         doc-update-uri!
         doc-pos->abs-pos
         doc-end-abs-pos
         doc-get-text
         doc-diagnostics
         doc-copy-text-buffer
         doc-abs-pos->pos
         doc-line-start-abs-pos
         doc-line-end-abs-pos
         doc-find-containing-paren
         doc-format-edits
         doc-on-type-format-edits
         doc-range-tokens
         doc-token-at
         doc-token-prefix-at
         doc-language-policy
         doc-lexer-state
         doc-body-forest
         doc-expand
         doc-detach-analysis!
         doc-update-trace!
         doc-update-language-policy!
         doc-trace-latest?
         doc-expand!
         doc-check-syntax
         doc-definition-ranges
         doc-resyntax
         doc-resyntax!
         doc-resyntax-available?
         doc-get-resyntax-results
         doc-update-resyntax-result!
         resyntax-result->diag
         resyntax-result->code-action
         doc-hover
         doc-hover-data
         doc-hover-notes
         hover-with-notes
         doc-hover-summaries
         doc-inlay-hints
         doc-code-action
         doc-signature-help
         doc-occurrence-at
         doc-definition-at
         doc-definition-ranges-at
         doc-uses-at
         doc-binding-ranges-at
         doc-module-bindings-at
         doc-module-binding-at
         (struct-out Module-Binding)
         (struct-out Reference-Source)
         (struct-out Document-Reference-Result)
         doc-completion
         doc-definition
         doc-references
         doc-highlights
         doc-rename
         doc-prepare-rename
         doc-symbols
         doc-declaration-provider
         doc-symbols-hierarchical)
