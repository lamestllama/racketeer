#lang racket/base
(require drracket/check-syntax
         racket/class
         racket/contract
         racket/logging
         racket/match
         syntax/modread
         racket/path
         racket/port
         "editor.rkt"
         "textbuffer/text-port.rkt"
         "doc-trace.rkt"
         "language-adapter.rkt"
         (only-in "lexer/state.rkt" LexerState LexerState-snapshot LexerState-base-policy lexer-state-apply-adapter!)
         "lazy-cache.rkt"
         (only-in "lexer.rkt"
                  LexerState?
                  LexerState-adapter
                  LexerState-language-policy
                  Language-Policy-expand?)
         "../common/source.rkt"
         "../common/path-util.rkt"
         "internal-types.rkt"
         "binding-facts.rkt"
         "bindings-provider.rkt")

;; Virtual URI paths are a best-effort local dependency context, not file
;; identities. Relative parents are allowed; the document need not exist.
(define (source-analysis-directory source)
  (define file-path (source-file-path source))
  (cond
    [file-path (path-only file-path)]
    [else
     (with-handlers ([exn:fail? (lambda (_) #f)])
       (define parent (path-only (uri->path (source-uri source))))
       (and parent (directory-exists? parent) (path->complete-path parent)))]))

(module+ test
  (require rackunit racket/file)

  (test-case "virtual analysis directories must exist and may be relative"
    (define root (make-temporary-file "virtual-context~a" 'directory))
    (dynamic-wind
      void
      (lambda ()
        (parameterize ([current-directory root])
          (make-directory "deps space")
          (call-with-output-file "regular-file" void)
          (check-equal?
            (source-analysis-directory
              (uri->source "custom:deps%20space/missing.rkt?rev=one#cell"))
            (path->directory-path (build-path root "deps space")))
          (for ([uri (in-list '("custom:absent/main.rkt"
                                "custom:regular-file/main.rkt"
                                "untitled:main.rkt"
                                "custom:"))])
            (check-false (source-analysis-directory (uri->source uri))))))
      (lambda () (delete-directory/files root)))))

(define (relative-module-path? module)
  (match module
    [(? path-string?) (relative-path? module)]
    [(list 'file (? path-string? file)) (relative-path? file)]
    [(list* 'submod (and parent (not (or "." ".."))) _) (relative-module-path? parent)]
    [_ #f]))

;; The module name resolver for a document without an analysis directory.
;; `resolve` resolves a relative module path against the module that requires
;; it. The document has no file to resolve against, so `resolve` would use the
;; server's working directory. This resolver refuses such an import instead and
;; otherwise defers to `resolve`. Modules loaded from files are unaffected.
;; Older Racket versions pass no syntax for the require, so the refusal then
;; names only the document.
(define (directoryless-module-name-resolver resolve document)
  (case-lambda
    [(name namespace) (resolve name namespace)]
    [(module relative-to stx load?)
     (define base
       (and relative-to
            (let ([name (resolved-module-path-name relative-to)])
              (if (pair? name) (car name) name))))
     (when (and (relative-module-path? module)
                (not (path? base))
                (not (current-load-relative-directory)))
       (raise-syntax-error
         #f
         "Relative imports need a save location. Save this document to import files relative to it."
         (or stx (datum->syntax #f module (vector document #f #f #f #f)))))
     (resolve module relative-to stx load?)]))

;; TODO: cache the namespace with some strategy
(define (expand-source source in collector #:expand? [expand? #t]
                       #:on-adapter [on-adapter void]
                       #:text [document-text #f]
                       #:contribution-only? [contribution-only? #f]
                       #:bindings-provider [bindings-provider #f])
  (define src-dir (source-analysis-directory source))
  (define ns (make-base-namespace))
  (define text (and (or expand? (current-language-adapter-resolver))
                    (or document-text (port->string (peeking-input-port in)))))
  (define-values (add-syntax done)
    (make-traversal ns src-dir))
  (port-count-lines! in)

  (parameterize ([current-load-relative-directory src-dir]
                 [current-module-name-resolver
                  (if src-dir
                      (current-module-name-resolver)
                      (directoryless-module-name-resolver (current-module-name-resolver)
                                                          (source-syntax-source source)))]
                 [current-namespace ns]
                 [current-annotations collector])
    (define stx
      (with-handlers ([exn:fail? (λ (exn) exn)])
        (define pre
          (with-handlers ([exn:fail? values])
            (with-module-reading-parameterization
              (λ () (read-syntax (source-syntax-source source) in)))))
        (define adapter (and (current-language-adapter-resolver)
                             (source-language-adapter source text pre)))
        (on-adapter adapter)
        (when adapter
          (define override (hash-ref (hash-ref adapter 'editor) 'expand? 'policy))
          (unless (eq? override 'policy) (set! expand? override))
          (unless bindings-provider
            (set! bindings-provider ((current-language-adapter-bindings) adapter))))
        (if (and adapter (syntax? pre))
            (syntax-property pre 'racketeer:language-profile adapter) pre)))

    (define expand-logs '())
    (define (expand-input)
      (with-handlers ([exn:fail? (λ (exn) exn)])
        (parameterize ([current-output-port (open-output-nowhere)])
          (if (and expand? (syntax? stx))
              (expand stx)
              #f))))
    (define expanded-stx
      (if contribution-only?
          (expand-input)
          (with-intercepted-logging
            (λ (log) (set! expand-logs (cons log expand-logs)))
            expand-input
            'info)))

    (when (syntax? expanded-stx)
      (add-syntax expanded-stx)
      (done)
      (define facts (collect-binding-facts source expanded-stx text stx
                                           #:contribution-only? contribution-only?))
      (define accepted-facts
        (if bindings-provider
            (augment-binding-facts bindings-provider source text stx expanded-stx facts)
            facts))
      (when (object-method-arity-includes? collector 'add-binding-facts 1)
        (send collector add-binding-facts accepted-facts)))

    ;; Interceptor conses in O(1); reverse restores emission order so overlapping
    ;; Typed Racket provider records apply as sent.
    (ExpandResult stx expanded-stx (reverse expand-logs))))

;; Struct to hold the result of check-syntax.
(struct/contract CSResult
  ([trace (is-a?/c build-trace%)]
   [text string?]
   [succeed? boolean?])
  #:transparent)

(define (check-syntax source doc-text existing-state #:contribution-only? [contribution-only? #f])
  (define text (send doc-text get-text))
  (define active-policy (LexerState-base-policy existing-state))
  (define lexer-state
    (LexerState (LexerState-snapshot existing-state) active-policy active-policy #f #f (make-lazy-cache)))
  (define expand? (Language-Policy-expand? active-policy))
  (define new-trace
    (new build-trace%
      [source source]
      [doc-text doc-text]
      [lexer-state lexer-state]
      [contribution-only? contribution-only?]))

  (define in (open-input-text text))
  (define er (expand-source source in new-trace #:expand? expand?
                            #:on-adapter (lambda (adapter) (lexer-state-apply-adapter! lexer-state adapter))
                            #:text text
                            #:contribution-only? contribution-only?))

  ;; Resource failures must reach the indexer's worker controller even when
  ;; diagnostic construction is omitted. Full document analysis is unchanged.
  (when contribution-only?
    (for ([problem (in-list (list (ExpandResult-pre-exn er) (ExpandResult-post-exn er)))]
          #:when (exn:fail:out-of-memory? problem))
      (raise problem)))

  (send new-trace walk-stx er)
  (send new-trace walk-log (ExpandResult-logs er))
  (define adapter (LexerState-adapter lexer-state))
  ;; Disabling expansion cannot certify a complete binding graph.
  (define binding-analysis?
    (not (and adapter (eq? (hash-ref (hash-ref adapter 'editor) 'expand? 'policy) #f))))
  (CSResult new-trace text
            (and binding-analysis?
                 (if (Language-Policy-expand? (LexerState-language-policy lexer-state))
                     (ExpandResult-all-succeed? er)
                     (and (ExpandResult-pre-syntax er) #t)))))

(provide
  (struct-out CSResult)
  (contract-out
    [expand-source (->* (Source? input-port? (is-a?/c syncheck-annotations<%>))
                        (#:expand? boolean? #:on-adapter (-> (or/c hash? #f) any/c)
                         #:text (or/c string? #f) #:contribution-only? boolean?
                         #:bindings-provider (or/c #f (-> hash? hash?)))
                        ExpandResult?)]
    [check-syntax (->* (Source? (is-a?/c lsp-editor%) LexerState?)
                       (#:contribution-only? boolean?) CSResult?)]))
