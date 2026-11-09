#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/file racket/list racket/set racket/string racket/runtime-path racket/path
         "../vscode/workspace-rename.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/common/path-util.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/rename-validation.rkt"
         (only-in "../vendor/collects/racket-langserver/doclib/service/declaration.rkt" current-retain-binding-facts?)
         "../vendor/collects/racket-langserver/doclib/editor.rkt"
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/common/json-util.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/language-adapter.rkt")

(define-runtime-path launcher "../vscode/language-adapters.rkt")
(define launcher-hooks #f)
(define (with-rhombus proc)
  (when (getenv "RACKETDAP_TEST_RHOMBUS")
    (unless launcher-hooks
      (dynamic-require launcher #f)
      (set! launcher-hooks (list (current-language-adapter-resolver)
                                 (current-language-adapter-validator)
                                 (current-language-adapter-bindings)
                                 (current-language-adapter-rename))))
    (parameterize ([current-language-adapter-resolver (car launcher-hooks)]
                   [current-language-adapter-validator (cadr launcher-hooks)]
                   [current-language-adapter-bindings (caddr launcher-hooks)]
                   [current-language-adapter-rename (cadddr launcher-hooks)])
      (proc))))

(define (macro-source suffix)
  (string-append
   "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
   "(define-syntax (define-pair stx)\n (syntax-case stx () [(_ name)\n"
   (format "  (with-syntax ([helper (format-id #'name \"~a~a\" #'name #:source #'name)])\n" "~a" suffix)
   "   #'(begin (define helper 1) (define name (lambda (x) (+ helper x)))))]))\n"
   "(define-pair square)\n(provide square)\n(square 2)\n"))
(define model (macro-source "-helper"))
(define alias-source "#lang racket/base\n(require (for-syntax racket/base))\n(define-syntax (forward stx)\n (syntax-case stx () [(_ name)\n  (with-syntax ([target (if (eq? (syntax-e #'name) 'square) #'car #'cdr)])\n   #'(define-syntax name (make-rename-transformer #'target)))]))\n(forward square)\n(square '(1 2))\n")
(define consumer "#lang racket/base\n(require \"model.rkt\")\n(square 3)\n")
(define (offset text needle [part needle])
  (+ (caar (regexp-match-positions (regexp (regexp-quote needle)) text))
     (- (string-length needle) (string-length part))))
(define (position doc text needle [part needle])
  (doc-abs-pos->pos doc (offset text needle part)))
(define (json-pos pos) (hasheq 'line (Pos-line pos) 'character (Pos-char pos)))
(define (document text [uri "untitled:rename-binders"])
  (define doc (make-doc uri text))
  (check-true (doc-expand! doc))
  doc)
(define (apply-edits doc edits)
  (for/fold ([text (doc-get-text doc)])
            ([edit (in-list (sort edits > #:key (lambda (edit) (doc-pos->abs-pos doc (Range-start (TextEdit-range edit))))))])
    (define range (TextEdit-range edit))
    (string-append (substring text 0 (doc-pos->abs-pos doc (Range-start range)))
                   (TextEdit-newText edit)
                   (substring text (doc-pos->abs-pos doc (Range-end range))))))
(define (local-success text [needle "define-pair square)"] [part "square)"])
  (define doc (document text))
  (define pos (position doc text needle part))
  (check-not-false (doc-prepare-rename doc pos))
  (define edit (doc-rename doc (Doc-uri doc) pos "area"))
  (check-not-false edit)
  (when edit
    (check-equal? (apply-edits doc (hash-ref (WorkspaceEdit-changes edit) (string->symbol (Doc-uri doc))))
                  (string-replace text "square" "area")))
  doc)
(define (with-workspace proc [text model] [use consumer] #:suffix [suffix ".rkt"])
  (define root (make-temporary-file "rename-binders~a" 'directory))
  (dynamic-wind void
    (lambda ()
      (define file (build-path root (string-append "model" suffix)))
      (define client (build-path root (string-append "client" suffix)))
      (display-to-file text file)
      (display-to-file use client)
      (proc file client (hash file text client use)))
    (lambda () (delete-directory/files root))))
(define (workspace-success file sources needle [part needle] [name "area"])
  (define text (hash-ref sources file))
  (define doc (make-doc (path->uri file) text))
  (define result (workspace-rename sources file (json-pos (position doc text needle part)) name))
  (for ([(path text) (in-hash sources)])
    (define source-doc (make-doc (path->uri path) text))
    (define edits (hash-ref (hash-ref result 'changes) (string->symbol (path->uri path)) '()))
    (check-equal? (apply-edits source-doc (map jsexpr->TextEdit edits))
                  (string-replace text "square" name))
    (check-equal? (file->string path) text)))

(define (refused-on-both-routes text)
  (define doc (document text))
  (define pos (position doc text "define-pair square)" "square)"))
  (define local-refused? (not (doc-rename doc (Doc-uri doc) pos "area")))
  (define workspace-refused?
    (with-workspace
     (lambda (file client sources)
       (define refused?
         (with-handlers ([exn:fail? (lambda (exn) (regexp-match? #rx"another binding" (exn-message exn)))])
           (workspace-rename sources file (json-pos pos) "area")
           #f))
       (for ([(path original) (in-hash sources)]) (check-equal? (file->string path) original))
       refused?)
     text "#lang racket/base\n(require \"model.rkt\")\n"))
  (check-equal? (doc-get-text doc) text)
  (check-equal? (list local-refused? workspace-refused?) '(#t #t)))

(define (structure-local form field-column)
  (define root (make-temporary-file "rename-structure~a" 'directory))
  (define file (build-path root "point.rkt"))
  (define text (format "#lang racket/base\n(~a point (x))\n(define (read square) (point-x square))\n" form))
  (dynamic-wind void
    (lambda ()
      (for ([file-backed? '(#f #t)])
        (when file-backed? (display-to-file text file #:exists 'truncate))
        (define doc (document text (if file-backed? (path->uri file) "untitled:structure")))
        (define (rename! pos name)
          (check-not-false (doc-prepare-rename doc pos))
          (define edit (doc-rename doc (Doc-uri doc) pos name))
          (check-not-false edit)
          (doc-apply-edits! doc (hash-ref (WorkspaceEdit-changes edit) (string->symbol (Doc-uri doc))))
          (check-true (doc-expand! doc)))
        (check-not-false (string-contains? (Hover-contents (doc-hover doc (Pos 1 (- field-column 7))))
                                          (format "(~a point (x))" form)))
        (check-equal? (doc-definition-at doc (Pos 2 29))
                      (Range (Pos 1 field-column) (Pos 1 (add1 field-column))))
        (rename! (Pos 2 14) "value")
        (rename! (Pos 1 field-column) "ordinate")
        (check-equal? (doc-definition-at doc (position doc (doc-get-text doc) "point-ordinate" "ordinate"))
                      (Range (Pos 1 field-column) (Pos 1 (+ field-column 8))))
        (rename! (Pos 1 (- field-column 7)) "dot")
        (check-equal? (doc-get-text doc)
                      (string-replace (string-replace (string-replace text "square" "value") "x" "ordinate") "point" "dot"))
        (check-not-false (string-contains? (Hover-contents (doc-hover doc (Pos 1 (- field-column 7))))
                                          (format "(~a dot (ordinate))" form)))
        (check-equal? (doc-definition-at doc (position doc (doc-get-text doc) "dot-ordinate" "ordinate"))
                      (Range (Pos 1 (- field-column 2)) (Pos 1 (+ field-column 6))))
        (when file-backed? (check-equal? (file->string file) text))))
    (lambda () (delete-directory/files root))))

(define (with-native-rename proc)
  (with-rhombus
   (lambda ()
     (define stages '())
     (define select (current-language-adapter-rename))
     (parameterize ([current-language-adapter-rename
                     (lambda (adapter)
                       (define provider (select adapter))
                       (and provider
                            (lambda (request)
                              (set! stages (cons (hash-ref request 'stage) stages))
                              (check-true (immutable? (hash-ref request 'sources)))
                              (define answer (provider request))
                              (when (and (not (eq? (hash-ref request 'stage) 'scan)) answer
                                         (not (and (hash-ref answer 'valid?) (hash-ref answer 'complete?))))
                                (check-true (and (string? (hash-ref answer 'reason #f))
                                                 (positive? (string-length (hash-ref answer 'reason))))))
                              answer)))])
       (proc))
     (check-not-false (memq 'prepare stages))
     (check-not-false (memq 'plan stages)))))

(define rhombus-function
  "#lang rhombus\nexport: square\nfun square(x): x * x\nsquare(2)\n")
(define rhombus-open "#lang rhombus\nimport: \"model.rhm\" open\nsquare(3)\n")
(define (rhombus-document-refusal text needle old name [uri "untitled:rhombus-rename"])
  (define doc (document text uri))
  (define pos (position doc text needle old))
  (check-exn #rx"Save the file in the workspace first" (lambda () (doc-prepare-rename doc pos)))
  (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc uri pos name)))
  (check-equal? (doc-get-text doc) text))
(define (rhombus-workspace text use needle old name [client? #f] [expected #f])
  (with-workspace
   (lambda (file client sources)
     (define selected (if client? client file))
     (define original (hash-ref sources selected))
     (define doc (make-doc (path->uri selected) original))
     (define pos (json-pos (position doc original needle old)))
     (check-not-false (workspace-rename sources selected pos #f))
     (define result (workspace-rename sources selected pos name))
     (for ([(path source) (in-hash sources)])
       (define edits (hash-ref (hash-ref result 'changes) (string->symbol (path->uri path)) '()))
       (check-equal? (apply-edits (make-doc (path->uri path) source) (map jsexpr->TextEdit edits))
                     (if expected (if (equal? path file) (car expected) (cadr expected))
                         (string-replace source old name)))
       (check-equal? (file->string path) source)))
   text use #:suffix ".rhm"))

(define (rhombus-refusal text use needle old name)
  (with-workspace
   (lambda (file client sources)
     (define doc (make-doc (path->uri file) text))
     (check-true (parameterize ([current-retain-binding-facts? #t])
                   (doc-expand! doc #:contribution-only? #t)))
     (check-exn exn:fail?
                (lambda () (workspace-rename sources file (json-pos (position doc text needle old)) name)))
     (for ([(path original) (in-hash sources)]) (check-equal? (file->string path) original)))
   text use #:suffix ".rhm"))

(module+ test
  (test-case "export permutations preserve scoped leaves on both routes"
    (define reordered
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base))\n"
       "(define left 1)\n(define right 2)\n"
       "(define-syntax (def stx) (syntax-case stx () [(_ name a b)\n"
       " (with-syntax ([(x y) (if (eq? (syntax-e #'name) 'square) #'(a b) #'(b a))])\n"
       "  #'(begin (define name 3) (provide name x y)))]))\n"
       "(def square left right)\nsquare\n"))
    (define bulk
      (string-append
       "#lang racket/base\n(provide (all-defined-out))\n(define square 3)\n"
       (apply string-append (for/list ([i (in-range 10)]) (format "(define x~a ~a)\n" i i)))
       "square\n"))
    (define outcomes
      (for/list ([text (in-list (list reordered bulk
                                     (string-replace reordered "(provide name x y)" "(provide name (protect-out x y))")
                                     (string-replace
                                      (string-replace reordered "(with-syntax ([(x y)"
                                                      "(with-syntax ([fixed (datum->syntax #f (string->symbol \"square\"))] [(x y)")
                                      "(provide name x y)" "(provide name (rename-out [name fixed]) x y)")))]
                 [needle '("def square" "define square" "def square" "def square")])
        (define expected
          (string-replace (string-replace text (string-append "(" needle)
                                          (string-replace (string-append "(" needle) "square" "area"))
                          "\nsquare\n" "\narea\n"))
        (define doc (document text))
        (define pos (position doc text needle "square"))
        (define edit (doc-rename doc (Doc-uri doc) pos "area"))
        (define local
          (and edit
               (let ([edits (hash-ref (WorkspaceEdit-changes edit) (string->symbol (Doc-uri doc)))])
                 (list (length edits) (apply-edits doc edits) (equal? (doc-get-text doc) text)))))
        (define workspace
          (with-handlers ([exn:fail? (lambda (_) #f)])
            (with-workspace
             (lambda (file client sources)
               (define result (workspace-rename sources file (json-pos pos) "area"))
               (define edits (hash-ref (hash-ref result 'changes) (string->symbol (path->uri file))))
               (list (length edits) (apply-edits (make-doc (path->uri file) text) (map jsexpr->TextEdit edits))
                     (for/and ([(path original) (in-hash sources)]) (equal? (file->string path) original))))
             text "#lang racket/base\n(require \"model.rkt\")\n")))
        (printf "~a exports: local ~a; workspace ~a\n" needle (and local #t) (and workspace #t))
        (list local workspace (list 2 expected #t))))
    (for ([outcome (in-list outcomes)])
      (check-equal? (take outcome 2) (make-list 2 (caddr outcome))))
    ;; Moving protection between owners changes the public interface.
    (define changed (string-replace reordered "(provide name x y)" "(provide name (protect-out x) y)"))
    (define doc (document changed))
    (define pos (position doc changed "def square" "square"))
    (check-false (doc-rename doc (Doc-uri doc) pos "area"))
    (with-workspace
     (lambda (file client sources)
       (check-exn #rx"another binding" (lambda () (workspace-rename sources file (json-pos pos) "area")))
       (for ([(path original) (in-hash sources)]) (check-equal? (file->string path) original)))
     changed "#lang racket/base\n(require \"model.rkt\")\n"))
  (test-case "many edited ranges scale at two sizes in real expansions"
    (define source (path->source (build-path (find-system-path 'temp-dir) "edited-ranges.rkt")))
    (define (snapshot text paths)
      (define editor (new lsp-editor%))
      (send editor insert text 0)
      (define trace (new build-trace% [source source] [doc-text editor]
                         [lexer-state (build-lexer-state text (source-uri source))] [contribution-only? #t]))
      (define result (expand-source source (open-input-string text) trace #:contribution-only? #t))
      (check-true (ExpandResult-all-succeed? result))
      (parameterize ([current-retain-binding-facts? #t]) (send trace walk-stx result))
      (rename-snapshot (send (send trace get-declaration) get-binding-facts) source text paths))
    (define (measure thunk)
      (apply min (for/list ([sample (in-range 3)])
                   (collect-garbage)
                   (define start (- (current-inexact-monotonic-milliseconds) (current-gc-milliseconds)))
                   (thunk)
                   (- (current-inexact-monotonic-milliseconds) (current-gc-milliseconds) start))))
    (define (cost size)
      (define text
        (string-append "#lang racket/base\n(define square 1)\n"
                       (apply string-append (for/list ([i (in-range size)]) (format "(define x~a square)\n" i)))))
      (define ranges (regexp-match-positions* #rx"square" text))
      (define next-text (string-replace text "square" "area"))
      (define paths (make-hash))
      (define before (snapshot text paths))
      (define after (snapshot next-text paths))
      (define text-time (measure (lambda () (check-equal? (renamed-text text ranges "area") next-text))))
      (define validation-time
        (measure
         (lambda ()
           (define correspondence (rename-correspondence before after ranges "area"))
           (check-equal? (hash-count correspondence) (hash-count (hash-ref before 'binders)))
           (validate-rename-proposal before after ranges "area" correspondence '() '())
           (check-equal?
            (rename-token-relations text (source-uri source) ranges "area" correspondence (lambda (_) (car ranges)))
            (rename-token-relations next-text (source-uri source) '() "area" (hash)
                                    (lambda (_) (cons (caar ranges) (+ (caar ranges) 4))))))))
      (list text-time validation-time))
    (define small (cost 2000))
    (define large (cost 8000))
    (printf "Edited ranges: 2000 text/validation ~a ms; 8000 ~a ms\n" small large)
    (for ([a (in-list small)] [b (in-list large)])
      (check-true (< b (* 8 a)) (format "2000: ~a ms; 8000: ~a ms" a b)))
    ;; A token immediately after an edit starts at that edit's shifted end.
    (check-equal? (rename-token-relations "square x" "untitled:ends" '((0 . 6)) "area" (hash) (lambda (_) '(0 . 6)))
                  '((0 4 (0 . 4)) (5 6 (0 . 4))))
    (check-equal? (renamed-text "squarex" '((0 . 6) (6 . 7)) "area") "areaarea"))
  (test-case "an interned private internal export stays fixed locally and refuses an unmatched workspace use"
    (define text
      #<<SOURCE
#lang racket/base
(require (for-syntax racket/base racket/syntax))
(define-syntax (define-pair stx)
  (syntax-case stx () [(_ name)
    (with-syntax ([helper (format-id #'name "~a-helper" #'name)])
      #'(begin (define name 1) (define helper 2)
               (provide (rename-out [helper stable]))))]))
(define-pair square)
(provide square)
square
SOURCE
      )
    (define doc (document text))
    (define pos (position doc text "define-pair square)" "square)"))
    (check-not-false (doc-prepare-rename doc pos))
    (define edit (doc-rename doc (Doc-uri doc) pos "area"))
    (check-not-false edit)
    (when edit
      (define edits (hash-ref (WorkspaceEdit-changes edit) (string->symbol (Doc-uri doc))))
      (check-equal? (sort edits < #:key (lambda (edit) (doc-pos->abs-pos doc (Range-start (TextEdit-range edit)))))
                    (for/list ([range (in-list (regexp-match-positions* #rx"square" text))])
                      (TextEdit (Range (doc-abs-pos->pos doc (car range))
                                       (doc-abs-pos->pos doc (cdr range))) "area")))
      (check-equal? (apply-edits doc edits) (string-replace text "square" "area")))
    (with-workspace
     (lambda (file client sources)
       (check-exn #rx"another binding"
                  (lambda () (workspace-rename sources file (json-pos pos) "area")))
       (for ([(path original) (in-hash sources)])
         (check-equal? (file->string path) original)))
     text "#lang racket/base\n(require \"model.rkt\")\nstable\n")
    (with-workspace
     (lambda (file client sources)
       (check-equal? (dynamic-require file 'stable) 2)
       (define changed (build-path (path-only file) "changed.rkt"))
       (display-to-file (string-replace text "square" "area") changed)
       (check-equal? (dynamic-require changed 'stable) 2))
     text "#lang racket/base\n"))
  (test-case "shared structural paths scale at two sizes in real expansions"
    (define source (path->source (build-path (find-system-path 'temp-dir) "anchors.rkt")))
    (define (facts text)
      (define editor (new lsp-editor%))
      (send editor insert text 0)
      (define trace (new build-trace% [source source] [doc-text editor]
                         [lexer-state (build-lexer-state text (source-uri source))] [contribution-only? #t]))
      (define result (expand-source source (open-input-string text) trace #:contribution-only? #t))
      (parameterize ([current-retain-binding-facts? #t])
        (send trace walk-stx result))
      (send (send trace get-declaration) get-binding-facts))
    (define (cost size)
      (define text
        (string-append "#lang racket/base\n(define square 1)\n"
                       (apply string-append (for/list ([i (in-range size)]) (format "(define x~a 1)\n" i)))))
      (define ranges (regexp-match-positions* #rx"square" text))
      (define next-text (renamed-text text ranges "area"))
      (define before (facts text))
      (define after (facts next-text))
      (apply min
             (for/list ([sample (in-range 3)])
               (collect-garbage)
               (define start (- (current-inexact-monotonic-milliseconds) (current-gc-milliseconds)))
               (define paths (make-hash))
               (define old (rename-snapshot before source text paths))
               (define new (rename-snapshot after source next-text paths))
               (define correspondence (rename-correspondence old new ranges "area"))
               (check-equal? (hash-count correspondence) (hash-count (hash-ref old 'binders)))
               (validate-rename-proposal old new ranges "area" correspondence '() '())
               (- (current-inexact-monotonic-milliseconds) (current-gc-milliseconds) start))))
    (define small (cost 1000))
    (define large (cost 4000))
    (printf "Structural paths: 1000 ~a ms; 4000 ~a ms\n" small large)
    (check-true (< large (* 8 small)) (format "1000: ~a ms; 4000: ~a ms" small large)))
  (test-case "a shared declaration grants no external export permission on either route"
    (refused-on-both-routes
     #<<SOURCE
#lang racket/base
(require (for-syntax racket/base))
(define-syntax (define-pair stx)
  (syntax-case stx () [(_ name)
    (with-syntax ([helper (datum->syntax #'name
                            (if (eq? (syntax-e #'name) 'square) 'first 'rest))])
      #'(begin (define-values (name helper) (values 1 2))
               (provide helper)))]))
(define-pair square)
(provide square)
square
SOURCE
     ))
  (test-case "a generated require keeps its submodule path on both routes"
    (refused-on-both-routes
     (string-append
      "#lang racket/base\n(require (for-syntax racket/base))\n"
      "(module square racket/base (displayln 'first))\n(module area racket/base (displayln 'rest))\n"
      "(define-syntax (define-pair stx) (syntax-case stx () [(_ name)\n"
      " (with-syntax ([imported (datum->syntax #'name (syntax-e #'name))])\n"
      "  #'(begin (require (submod \".\" imported)) (define name 1)))]))\n"
      "(define-pair square)\n(provide square)\nsquare\n")))
  (test-case "a component preserves a separate uninterned owner and its export on both routes"
    (define text
      #<<SOURCE
#lang racket/base
(require (for-syntax racket/base))
(define-syntax (define-pair stx)
  (syntax-case stx () [(_ name)
    (with-syntax ([helper ((make-syntax-introducer) (datum->syntax #'name (syntax-e #'name) stx))]
                  [other (datum->syntax #'name (string->uninterned-symbol (symbol->string (syntax-e #'name))) stx)]
                  [out (datum->syntax #'name (syntax-e #'name))])
      (syntax-property
       #'(begin (define name 1) (define helper 2) (define other 'other)
                (provide (rename-out [other stable])))
       'sub-range-binders
       (vector #'helper 0 (string-length (symbol->string (syntax-e #'name))) #'name 0
               (string-length (symbol->string (syntax-e #'name))))))]))
(define-pair square)
square
SOURCE
      )
    (define (separate-owner text)
      (define source (path->source (build-path (find-system-path 'temp-dir) "separate-owner.rkt")))
      (define editor (new lsp-editor%))
      (send editor insert text 0)
      (define trace (new build-trace% [source source] [doc-text editor]
                         [lexer-state (build-lexer-state text (source-uri source))] [contribution-only? #t]))
      (define expanded (expand-source source (open-input-string text) trace #:contribution-only? #t))
      (check-true (ExpandResult-all-succeed? expanded))
      (parameterize ([current-retain-binding-facts? #t]) (send trace walk-stx expanded))
      (define facts (send (send trace get-declaration) get-binding-facts))
      (define exports
        (append-map (lambda (entry) (if (eq? (caaddr entry) '#%provide) (cadr (caddr entry)) '()))
                    (hash-ref facts 'structure)))
      (check-equal? (length exports) 1)
      (define spec (syntax->list (car exports)))
      (check-equal? (map syntax-e (list (car spec) (caddr spec))) '(rename stable))
      (define owner
        (findf (lambda (binder)
                 (free-identifier=? (hash-ref binder 'identifier) (cadr spec)))
               (hash-ref facts 'binders)))
      (check-not-false owner)
      (check-false (symbol-interned? (syntax-e (hash-ref owner 'identifier))))
      (hash-ref owner 'anchor))
    (define owner (separate-owner text))
    (define (check-edits doc edits)
      (check-equal? (sort edits < #:key (lambda (edit) (doc-pos->abs-pos doc (Range-start (TextEdit-range edit)))))
                    (for/list ([range (in-list (regexp-match-positions* #rx"square" text))])
                      (TextEdit (Range (doc-abs-pos->pos doc (car range))
                                       (doc-abs-pos->pos doc (cdr range))) "area")))
      (define changed (apply-edits doc edits))
      (check-equal? changed (string-replace text "square" "area"))
      (check-equal? (separate-owner changed) owner))
    (define doc (document text))
    (define pos (position doc text "define-pair square)" "square)"))
    (define edit (doc-rename doc (Doc-uri doc) pos "area"))
    (when edit
      (check-equal? (hash-keys (WorkspaceEdit-changes edit)) (list (string->symbol (Doc-uri doc))))
      (check-edits doc (hash-ref (WorkspaceEdit-changes edit) (string->symbol (Doc-uri doc)))))
    (check-equal? (doc-get-text doc) text)
    (with-workspace
     (lambda (file client sources)
       (define result
         (with-handlers ([exn:fail? (lambda (exn)
                                     (check-regexp-match #rx"another binding" (exn-message exn))
                                     #f)])
           (workspace-rename sources file (json-pos pos) "area")))
       (when result
         (define changes (hash-ref result 'changes))
         (check-equal? (hash-keys changes) (list (string->symbol (path->uri file))))
         (check-edits (make-doc (path->uri file) text)
                      (map jsexpr->TextEdit (hash-ref changes (string->symbol (path->uri file))))))
       (for ([(path original) (in-hash sources)])
         (check-equal? (file->string path) original)))
     text "#lang racket/base\n(require \"model.rkt\")\nstable\n"))
  (test-case "a fresh private internal export keeps its fixed external name on both routes"
    (define text
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base))\n"
       "(define-syntax (define-pair stx) (syntax-case stx () [(_ name)\n"
       " (with-syntax ([helper (datum->syntax #'name (gensym 'helper))])\n"
       "  #'(begin (define name 1) (define helper 2) (provide (rename-out [helper stable]))))]))\n"
       "(define-pair square)\n(provide square)\nsquare\n"))
    (local-success text)
    (with-workspace
     (lambda (file client sources) (workspace-success file sources "define-pair square)" "square)"))
     text "#lang racket/base\n(require \"model.rkt\")\n")
    (with-workspace
     (lambda (file client sources)
       (check-equal? (dynamic-require file 'stable) 2)
       (define changed (build-path (path-only file) "changed.rkt"))
       (display-to-file (string-replace text "square" "area") changed)
       (check-equal? (dynamic-require changed 'stable) 2))
     text "#lang racket/base\n"))
  (test-case "unselected located uninterned binders scale at two sizes"
    (define file (build-path (find-system-path 'temp-dir) "constructors.rkt"))
    (define (snapshot size spelling)
      (hash 'file file 'components '() 'families '()
            'binders
            (for/hash ([i (in-range size)])
              (define id (if (zero? i) spelling (string->uninterned-symbol (format "p~a" i))))
              (values (list (list 0 'definition i) 'define-values 0 #f)
                      (list (if (zero? i) (Module-Binding file '() 0 id) (list 'local i))
                            (if (zero? i) (cons 0 (string-length (symbol->string spelling)))
                                (let ([shift (if (eq? spelling 'square) 0 -2)])
                                  (cons (+ 10 i shift) (+ 11 i shift)))) id)))))
    (define (cost size)
      (define before (snapshot size 'square))
      (define after (snapshot size 'area))
      (apply min
             (for/list ([sample (in-range 3)])
               (collect-garbage)
               (define start (- (current-inexact-milliseconds) (current-gc-milliseconds)))
               (for ([repeat (in-range 3)])
                 (check-equal? (hash-count (rename-correspondence before after '((0 . 6)) "area")) size))
               (- (current-inexact-milliseconds) (current-gc-milliseconds) start))))
    (define small (cost 1000))
    (define large (cost 4000))
    (printf "Uninterned binders: 1000 ~a ms; 4000 ~a ms\n" small large)
    (check-true (< large (* 8 small)) (format "1000: ~a ms; 4000: ~a ms" small large)))
  (test-case "unchanged owners keep exact external spellings on both routes"
    (define text
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base))\n"
       "(define-syntax (define-pair stx) (syntax-case stx () [(_ name)\n"
       " (with-syntax ([out (datum->syntax #'name (syntax-e #'name))])\n"
       "  #'(begin (define name 1) (define helper 2) (provide (rename-out [helper out]))))]))\n"
       "(define-pair square)\nsquare\n"))
    (refused-on-both-routes text)
    (refused-on-both-routes
     (string-replace text "(with-syntax ([out"
                     "(with-syntax ([helper (datum->syntax #'name (string->symbol (format \"~a-helper\" (syntax-e #'name))))] [out"))
    (define fixed (string-replace text "(syntax-e #'name)" "(string->symbol \"square\")"))
    (define expected (string-replace fixed "(define-pair square)\nsquare" "(define-pair area)\narea"))
    (define doc (document fixed))
    (define pos (position doc fixed "define-pair square)" "square)"))
    (define edit (doc-rename doc (Doc-uri doc) pos "area"))
    (check-not-false edit)
    (when edit
      (check-equal? (apply-edits doc (hash-ref (WorkspaceEdit-changes edit) (string->symbol (Doc-uri doc)))) expected))
    (check-equal? (doc-get-text doc) fixed)
    (with-workspace
     (lambda (file client sources)
       (define result (workspace-rename sources file (json-pos pos) "area"))
       (for ([(path original) (in-hash sources)])
         (define source-doc (make-doc (path->uri path) original))
         (define edits (hash-ref (hash-ref result 'changes) (string->symbol (path->uri path)) '()))
         (check-equal? (apply-edits source-doc (map jsexpr->TextEdit edits)) (if (equal? path file) expected original))
         (check-equal? (file->string path) original)))
     fixed "#lang racket/base\n(require \"model.rkt\")\nsquare\n"))
  (test-case "an unaccounted require change refuses without edits on both routes"
    (refused-on-both-routes
     (string-append
      "#lang racket/base\n(require (for-syntax racket/base))\n"
      "(define-syntax (define-pair stx) (syntax-case stx () [(_ name)\n"
      " (with-syntax ([imported (datum->syntax #'name\n"
      "   (if (eq? (syntax-e #'name) 'square) 'first 'rest))])\n"
      "  #'(begin (require (only-in racket/list imported)) (define name 1)))]))\n"
      "(define-pair square)\n(provide square)\nsquare\n")))
  (test-case "a changed separate export refuses without edits on both routes"
    (define text
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base))\n"
       "(define-syntax (define-pair stx)\n"
       " (syntax-case stx () [(_ name)\n"
       "  (with-syntax ([out (datum->syntax #'name\n"
       "    (if (equal? (symbol->string (syntax-e #'name)) \"square\") 'external-before 'external-after))])\n"
       "   #'(begin (define (name x) (+ x 1)) (provide (rename-out [name out]))))]))\n"
       "(define-pair square)\n(square 2)\n"))
    (define doc (document text))
    (define pos (position doc text "define-pair square)" "square)"))
    (define local-refused? (not (doc-rename doc (Doc-uri doc) pos "area")))
    (define workspace-refused?
      (with-workspace
       (lambda (file client sources)
         (define refused?
           (with-handlers ([exn:fail? (lambda (exn) (regexp-match? #rx"another binding" (exn-message exn)))])
             (workspace-rename sources file (json-pos pos) "area")
             #f))
         (for ([(path original) (in-hash sources)])
           (check-equal? (file->string path) original))
         refused?)
       text "#lang racket/base\n(require \"model.rkt\")\n"))
    (check-equal? (doc-get-text doc) text)
    (check-equal? (list local-refused? workspace-refused?) '(#t #t)))
  (test-case "an unrelated private gensym preserves scoped joins during rename"
    (define text
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base))\n"
       "(define-syntax (define-hidden stx)\n"
       "  (with-syntax ([secret (datum->syntax stx (gensym 'storage))])\n"
       "    #'(begin (define secret 1) (+ secret secret))))\n"
       "(define-hidden)\n(define-hidden)\n"
       "(define (square x) (* x x))\n(provide square)\n(square 3)\n"))
    (local-success text "(square x)" "square x)")
    (with-workspace
     (lambda (file client sources) (workspace-success file sources "(square x)" "square x)"))
     text))
  (test-case "generated family correspondence scales with the number of binders"
    (define file (build-path (find-system-path 'temp-dir) "family.rkt"))
    (define (snapshot size prefix)
      (define binders
        (for/hash ([i (in-range size)])
              (define spelling (string->symbol (if (zero? i) prefix (format "~a~a" prefix i))))
              (values (list (list i 'definition 0) 'define-values 0 #f)
                      (list (Module-Binding file '() 0 spelling)
                            (and (zero? i) (cons 0 (string-length prefix))) spelling))))
      (hash 'file file 'components '() 'binders binders
            'families (list (list 'generated #t (for/set ([entry (in-hash-values binders)]) (car entry))))))
    (define (cost size)
      (define before (snapshot size "square"))
      (define after (snapshot size "area"))
      (apply min
             (for/list ([sample (in-range 3)])
               (collect-garbage)
               (define start (current-process-milliseconds))
               (for ([repeat (in-range 3)])
                 (check-equal? (hash-count (rename-correspondence before after '((0 . 6)) "area")) size))
               (- (current-process-milliseconds) start))))
    (define small (cost 1000))
    (define large (cost 4000))
    (check-true (< large (* 8 small)) (format "1000 binders: ~a ms; 4000 binders: ~a ms" small large)))
  (test-case "a generated helper family renames from its declaration across files"
    (with-workspace (lambda (file client sources) (workspace-success file sources "define-pair square)" "square)"))))
  (test-case "a generated helper family renames from an importing use"
    (with-workspace (lambda (file client sources) (workspace-success client sources "(square" "square"))))
  (test-case "a numeric generated helper corresponds by binder from its declaration"
    (with-workspace (lambda (file client sources) (workspace-success file sources "define-pair square)" "square)"))
                    (macro-source ".1")))
  (test-case "a numeric generated helper corresponds by binder from a direct call"
    (with-workspace (lambda (file client sources) (workspace-success file sources "(square" "square"))
                    (macro-source ".1")))

  (test-case "struct keeps local family rename, structure hover and exact field anchors"
    (local-success model)
    (structure-local 'struct 15))
  (test-case "define-struct keeps local family rename, structure hover and exact field anchors"
    (local-success model)
    (structure-local 'define-struct 22))

  (test-case "unrelated identities at a shared range refuse without edits"
    (local-success model)
    (define text (string-replace model "(format-id #'name \"~a-helper\" #'name #:source #'name)" "(datum->syntax #'name 'unrelated #'name)"))
    (define doc (document text))
    (define pos (position doc text "define-pair square)" "square)"))
    (check-false (doc-rename doc (Doc-uri doc) pos "area"))
    (with-workspace
     (lambda (file client sources)
       (check-exn exn:fail? (lambda () (workspace-rename sources file (json-pos pos) "area")))) text))
  (test-case "capture of renamed and unchanged uses refuses without edits"
    (local-success model)
    (for ([use (list "(let ([area 4]) (square area))" "(define area 4)\n(square area)")])
      (with-workspace
       (lambda (file client sources)
         (check-exn exn:fail? (lambda () (workspace-rename sources file (hasheq 'line 6 'character 14) "area"))))
       model (string-append "#lang racket/base\n(require \"model.rkt\")\n" use "\n")))
    ;; A generated use must keep its binder even without an authored spelling.
    (define switching
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
       "(define-syntax (define-pair stx)\n (syntax-case stx () [(_ name)\n"
       "  (with-syntax ([helper (format-id #'name \"~a-helper\" #'name #:source #'name)]\n"
       "                [other (format-id #'name \"~a-other\" #'name #:source #'name)])\n"
       "   (with-syntax ([chosen (if (eq? (syntax-e #'name) 'square) #'helper #'other)])\n"
       "    #'(begin (define helper 1) (define other 2)\n"
       "             (define name (lambda (x) (+ chosen x))))))]))\n"
       "(define-pair square)\n(provide square)\n(square 2)\n"))
    (define unlocated
      (string-replace
       (string-replace switching " #:source #'name" "")
       "#'(begin (define helper 1) (define other 2)\n             (define name (lambda (x) (+ chosen x))))"
       "#'(define-values (name helper other)\n       (values (lambda (x) (+ chosen x)) 1 2))"))
    (with-workspace
     (lambda (file client sources) (workspace-success file sources "define-pair square)" "square)"))
     (string-replace unlocated "(if (eq? (syntax-e #'name) 'square) #'helper #'other)" "#'helper"))
    (for ([program (in-list (list switching unlocated))])
      (with-workspace
       (lambda (file client sources)
         (define doc (make-doc (path->uri file) program))
         (check-exn #rx"another binding"
                    (lambda () (workspace-rename sources file
                                 (json-pos (position doc program "define-pair square)" "square)")) "area"))))
       program)))
  (test-case "a family rename preserves an import alias and alias ownership"
    (with-workspace
     (lambda (file client sources) (workspace-success file sources "define-pair square)" "square)"))
     model "#lang racket/base\n(require (rename-in \"model.rkt\" [square sq]))\n(sq 3)\n"))

  (test-case "untitled macro rename validates tokens and keeps the document immutable"
    (define doc (local-success model))
    (local-success (string-replace alias-source "(if (eq? (syntax-e #'name) 'square) #'car #'cdr)" "#'car")
                   "forward square)" "square)")
    (local-success (string-replace model "(define-pair square)\n(provide square)\n(square 2)"
                                  "(let () (define-pair square) (square 2))"))
    (define pos (position doc model "(square" "square"))
    (for ([name '("" "42" "new name" "x ;comment" "#;ignored x")])
      (check-false (doc-rename doc (Doc-uri doc) pos name)))
    (check-equal? (doc-get-text doc) model))
  (test-case "untitled macro rename rejects capture in either direction"
    (local-success model)
    (define alias (document alias-source))
    (check-false (doc-rename alias (Doc-uri alias)
                            (position alias alias-source "forward square)" "square)") "area"))
    (for ([text (list (string-replace model "(square 2)" "(let ([area 4]) (square area))")
                     (string-append model "(define area 4)\narea\n")
                     (string-replace model "(define-pair square)\n(provide square)\n(square 2)"
                                     "(let ([area 4]) (define-pair square) (square 2) area)"))])
      (define doc (document text))
      (check-false (doc-rename doc (Doc-uri doc) (position doc text "define-pair square)" "square)") "area"))))
  (test-case "untitled and unsaved documents refuse an incomplete family"
    (local-success model)
    (define text (string-append model "square-helper\n"))
    (for ([uri '("untitled:incomplete" "file:///tmp/rename-binders-unsaved.rkt")])
      (define doc (document text uri))
      (check-false (doc-rename doc uri (position doc text "define-pair square)" "square)") "area"))))

  (test-case "Rhombus function rename from its declaration"
    (with-rhombus
     (lambda ()
      (with-workspace
       (lambda (file client sources) (workspace-success file sources "fun square" "square"))
       "#lang rhombus\nexport: square\nfun square(x): x * x\nsquare(2)\n"
       "#lang rhombus\nimport: \"model.rkt\" open\nsquare(3)\n"))))
  (test-case "Rhombus function rename from a direct call"
    (with-rhombus
     (lambda ()
      (with-workspace
       (lambda (file client sources) (workspace-success file sources "\nsquare" "square"))
       "#lang rhombus\nexport: square\nfun square(x): x * x\nsquare(2)\n"
       "#lang rhombus\nimport: \"model.rkt\" open\nsquare(3)\n"))))
  (test-case "Rhombus function rename from an importing file"
    (with-rhombus
     (lambda ()
      (with-workspace
       (lambda (file client sources) (workspace-success client sources "\nsquare" "square"))
       "#lang rhombus\nexport: square\nfun square(x): x * x\nsquare(2)\n"
       "#lang rhombus\nimport: \"model.rkt\" open\nsquare(3)\n"))))
  (test-case "Rhombus constants use native policy from declaration and use"
    (with-native-rename
     (lambda ()
       (define text "#lang rhombus\nexport: square\ndef square = 9\nsquare\n")
       (for ([needle '("def square" "\nsquare")])
         (rhombus-workspace text rhombus-open needle "square" "area")))))
  (test-case "Rhombus functions use native policy on both routes"
    (with-native-rename
     (lambda ()
       (rhombus-workspace rhombus-function rhombus-open "fun square" "square" "area")
       (rhombus-document-refusal rhombus-function "\nsquare" "square" "area")
       (rhombus-workspace rhombus-function "#lang rhombus\n" "\nsquare" "square" "area" #f
                            (list (string-replace rhombus-function "square" "area") "#lang rhombus\n")))))
  (test-case "Rhombus class families preserve fields and all binding spaces"
    (with-native-rename
     (lambda ()
       (define text "#lang rhombus\nclass Point(x, y)\ndef p :: Point = Point(1, 2)\np.x + Point.y(p)\n")
       (for ([needle '("class Point" "= Point")])
         (rhombus-document-refusal text needle "Point" "Position")
         (rhombus-workspace text "#lang rhombus\n" needle "Point" "Position" #f
                            (list (string-replace text "Point" "Position") "#lang rhombus\n")))
       (define model "#lang rhombus\nexport: Point\nclass Point(x, y)\n")
       (define use "#lang rhombus\nimport: \"model.rhm\" open\ndef p :: Point = Point(1, 2)\np.x + Point.y(p)\n")
       (rhombus-workspace model use "class Point" "Point" "Position")
       (rhombus-workspace model use "= Point" "Point" "Position" #t)
       (rhombus-document-refusal text "Point(x" "x" "ordinate")
       (rhombus-workspace text "#lang rhombus\n" "Point(x" "x" "ordinate" #f
                            (list (string-replace text "x" "ordinate") "#lang rhombus\n")))))
  (test-case "Rhombus operators retain their native token class"
    (with-native-rename
     (lambda ()
       (define text "#lang rhombus\noperator (a <+> b): a + b\n1 <+> 2\n")
       (define doc (document text))
       (define pos (position doc text "a <+>" "<+>"))
       (define provider (doc-rename-provider doc))
       (define seen #f)
       (parameterize ([current-language-adapter-rename
                       (lambda (_)
                         (lambda (request)
                           (define answer (provider request))
                           (when (eq? (hash-ref request 'stage) 'plan)
                             (set! seen answer))
                           answer))])
         (rhombus-refusal text "#lang rhombus\n" "a <+>" "<+>" "combine"))
       (check-not-false seen)
       (check-false (hash-ref seen 'valid?))
       (check-regexp-match #rx"same token class" (hash-ref seen 'reason))
       (rhombus-document-refusal text "a <+>" "<+>" "<*>")
       (rhombus-workspace text "#lang rhombus\n" "a <+>" "<+>" "<*>" #f
                            (list (string-replace text "<+>" "<*>") "#lang rhombus\n"))
       (rhombus-document-refusal text "a <+>" "<+>" "combine")
       (rhombus-document-refusal rhombus-function "fun square" "square" "<+>")
       (rhombus-refusal rhombus-function rhombus-open "fun square" "square" "<+>"))))
  (test-case "Rhombus reserved and malformed names refuse without edits"
    (with-native-rename
     (lambda ()
       (rhombus-document-refusal rhombus-function "fun square" "square" "area")
       (rhombus-workspace rhombus-function "#lang rhombus\n" "fun square" "square" "area" #f
                            (list (string-replace rhombus-function "square" "area") "#lang rhombus\n"))
       (for ([name '("if" "fun" "class" "~key" "new name" "x; y" "" "42")])
         (rhombus-document-refusal rhombus-function "fun square" "square" name)
         (rhombus-refusal rhombus-function rhombus-open "fun square" "square" name))
       (define select (current-language-adapter-rename))
       (for ([stage '(prepare plan)])
         (parameterize ([current-language-adapter-rename
                         (lambda (adapter)
                           (define provider (select adapter))
                           (and provider
                                (lambda (request)
                                  (if (eq? (hash-ref request 'stage) stage)
                                      (hasheq 'valid? #t 'complete? #f 'reason "Incomplete family.")
                                      (provider request)))))])
           (rhombus-refusal rhombus-function rhombus-open "fun square" "square" "area")))
       (define quoted (string-append rhombus-function "'square'\n"))
       (parameterize ([current-language-adapter-rename
                       (lambda (adapter)
                         (define provider (select adapter))
                         (and provider
                              (lambda (request)
                                (define answer (provider request))
                                (if (eq? (hash-ref request 'stage) 'plan)
                                    (hash-set answer 'edits
                                              (list (hasheq 'uri (hash-ref request 'uri)
                                                            'range (cons (- (string-length quoted) 8) (- (string-length quoted) 2))
                                                            'old-text "square" 'new-text "area"))) answer))))])
         (rhombus-refusal quoted rhombus-open "fun square" "square" "area")))))
  (test-case "Rhombus dotted members rename their exact last component across files"
    (with-native-rename
     (lambda ()
       (rhombus-workspace rhombus-function
                          "#lang rhombus\nimport: \"model.rhm\" as m\nm.square(3)\n"
                          "m.square" "square" "area" #t))))
  (test-case "Rhombus import alias rename leaves the exported member alone"
    (with-native-rename
     (lambda ()
       (define use "#lang rhombus\nimport: \"model.rhm\" as m\nm.square(3)\n")
       (define changed "#lang rhombus\nimport: \"model.rhm\" as shapes\nshapes.square(3)\n")
       (for ([needle '("as m" "\nm")])
         (rhombus-workspace rhombus-function use needle "m" "shapes" #t
                            (list rhombus-function changed))))))
  (test-case "Rhombus capture in either direction refuses without edits"
    (with-native-rename
     (lambda ()
       (rhombus-document-refusal rhombus-function "fun square" "square" "area")
       (rhombus-workspace rhombus-function "#lang rhombus\n" "fun square" "square" "area" #f
                            (list (string-replace rhombus-function "square" "area") "#lang rhombus\n"))
       (for ([text '("#lang rhombus\nfun square(x): x * x\nfun f(area): square(area)\n"
                     "#lang rhombus\ndef area = 4\nfun f(square): square + area\n")]
             [needle '("fun square" "f(square")])
         (rhombus-document-refusal text needle "square" "area")
         (rhombus-refusal text "#lang rhombus\n" needle "square" "area")))))
  (test-case "Rhombus unrelated local spellings and quoted data stay unchanged"
    (with-native-rename
     (lambda ()
       (define text "#lang rhombus\ndef square = 9\nfun f(square): square + 1\nsquare\n'square'\n")
       (define changed "#lang rhombus\ndef area = 9\nfun f(square): square + 1\narea\n'square'\n")
       (rhombus-document-refusal text "def square" "square" "area")
       (rhombus-workspace text "#lang rhombus\n" "def square" "square" "area" #f
                            (list changed "#lang rhombus\n")))))
  (test-case "Rhombus unsaved buffers and dynamic members obey native policy"
    (with-native-rename
     (lambda ()
       (rhombus-document-refusal rhombus-function "fun square" "square" "area" "file:///tmp/rename-unsaved.rhm")
       (rhombus-workspace rhombus-function "#lang rhombus\n" "fun square" "square" "area" #f
                            (list (string-replace rhombus-function "square" "area") "#lang rhombus\n"))
       (define text "#lang rhombus\nclass Point(x)\nfun dyn(v): v.x\n")
       (define doc (document text))
       (define pos (position doc text "v.x" "x"))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-prepare-rename doc pos)))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) pos "ordinate")))
       (check-equal? (doc-get-text doc) text))))
  (test-case "Racket rename retains its rules after native Rhombus rename"
    (with-native-rename
     (lambda ()
       (rhombus-document-refusal rhombus-function "fun square" "square" "area")
       (rhombus-workspace rhombus-function "#lang rhombus\n" "fun square" "square" "area" #f
                            (list (string-replace rhombus-function "square" "area") "#lang rhombus\n"))
       (local-success model)
       (with-workspace (lambda (file client sources) (workspace-success file sources "define-pair square)" "square)"))))))
  (test-case "Rhombus dynamic field declaration refuses on both routes"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nclass Point(x)\nfun dyn(v): v.x\ndyn(Point(1))\n")
       (define doc (document text))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) (position doc text "Point(x" "x") "ordinate")))
       (rhombus-refusal text "#lang rhombus\n" "Point(x" "x" "ordinate"))))
  (test-case "Rhombus dynamic method declaration refuses on both routes"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nclass Point():\n  method norm(): 1\nfun dyn(v): v.norm()\ndyn(Point())\n")
       (define doc (document text))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) (position doc text "method norm" "norm") "lengthy")))
       (define use (position doc text "v.norm" "norm"))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-prepare-rename doc use)))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) use "lengthy")))
       (rhombus-refusal text "#lang rhombus\n" "method norm" "norm" "lengthy"))))
  (test-case "Rhombus class and separately written field keep separate names"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nclass Point(Point)\nfun dyn(v): v.Point\ndyn(Point(1))\n")
       (define changed "#lang rhombus\nclass Position(Point)\nfun dyn(v): v.Point\ndyn(Position(1))\n")
       (for ([needle '("class Point" "dyn(Point")])
         (rhombus-document-refusal text needle "Point" "Position")
         (rhombus-workspace text "#lang rhombus\n" needle "Point" "Position" #f
                            (list changed "#lang rhombus\n"))))))
  (test-case "Rhombus use retains Racket import selector planning"
    (with-rhombus
     (lambda ()
       (with-workspace
        (lambda (file client sources)
          (define other (build-path (path-only file) "other.rkt"))
          (define rkt "#lang racket/base\n(require (rename-in \"model.rkt\" [square sq]))\n(sq 2)\n")
          (display-to-file rkt other)
          (workspace-success client (hash-set sources other rkt) "\nsquare" "square"))
        "#lang racket/base\n(provide square)\n(define (square x) (* x x))\n"
        "#lang rhombus\nimport: \"model.rkt\" open\nsquare(2)\n"))))
  (test-case "Rhombus workspace CRLF preserves source coordinates"
    (with-rhombus
     (lambda ()
       (rhombus-workspace (string-replace rhombus-function "\n" "\r\n")
                          (string-replace rhombus-open "\n" "\r\n")
                          "fun square" "square" "area"))))
  (test-case "Rhombus default module alias renames from declaration and use"
    (with-rhombus
     (lambda ()
       (define use "#lang rhombus\nimport: \"model.rhm\"\nmodel.square(3)\n")
       (rhombus-workspace rhombus-function use "fun square" "square" "area")
       (rhombus-workspace rhombus-function use "model.square" "square" "area" #t))))
  (test-case "Rhombus unrelated export clause permits local rename"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nexport:\n  rename: spare as public\ndef spare = 1\ndef square = 9\nsquare\n")
       (rhombus-document-refusal text "def square" "square" "area")
       (rhombus-workspace text "#lang rhombus\n" "def square" "square" "area")
       (define aliased "#lang rhombus\nexport:\n  rename: square as sq\ndef square = 9\nsquare\n")
       (rhombus-document-refusal aliased "def square" "square" "area")
       (rhombus-workspace aliased "#lang rhombus\n" "def square" "square" "area" #f
                            (list (string-replace aliased "square" "area") "#lang rhombus\n")))))
  (test-case "Rhombus default alias uses differing unsaved sources"
    (with-rhombus
     (lambda ()
       (define use "#lang rhombus\nimport: \"model.rhm\"\nmodel.square(3)\n")
       (with-workspace
        (lambda (file client sources)
          (define disk "#lang rhombus\ndef old = 0\n")
          (display-to-file disk file #:exists 'truncate)
          (display-to-file disk client #:exists 'truncate)
          (define doc (document rhombus-function (path->uri file)))
          (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) (position doc rhombus-function "fun square" "square") "area")))
          (check-exn #rx"Save the file in the workspace first" (lambda () (doc-prepare-rename doc (position doc rhombus-function "fun square" "square"))))
          (define result (workspace-rename sources client (hasheq 'line 2 'character 7) "area"))
          (for ([(path text) (in-hash sources)])
            (check-equal? (apply-edits (make-doc (path->uri path) text)
                                      (map jsexpr->TextEdit (hash-ref (hash-ref result 'changes) (string->symbol (path->uri path)))))
                          (string-replace text "square" "area"))
            (check-equal? (file->string path) disk)))
        rhombus-function use #:suffix ".rhm"))))
  (test-case "Rhombus namespace members preserve unrelated names"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nnamespace Tools:\n  export: scale\n  fun scale(x):\n    fun scale(y): y\n    scale(x) * 2\nnamespace Other:\n  export: scale\n  fun scale(x): x + 1\nfun local(scale): scale\nTools.scale(2) + Other.scale(3)\nTools.scale(4)\n'scale'\n'v.scale'\n'namespace ~extend Tools'\n")
       (define changed (string-replace (string-replace text "export: scale\n  fun scale(x):\n    fun scale(y): y\n    scale(x) * 2" "export: resize\n  fun resize(x):\n    fun scale(y): y\n    scale(x) * 2") "Tools.scale" "Tools.resize"))
       (for ([needle '("fun scale" "Tools.scale")])
         (rhombus-document-refusal text needle "scale" "resize")
         (with-workspace
          (lambda (file client sources)
            (rhombus-document-refusal text needle "scale" "resize" (path->uri file))
            (for ([(path original) (in-hash sources)]) (check-equal? (file->string path) original)))
          text "#lang rhombus\n" #:suffix ".rhm")
         (rhombus-workspace text "#lang rhombus\n" needle "scale" "resize" #f
                            (list changed "#lang rhombus\n"))))))
  (test-case "Rhombus nested namespace rename edits its own component"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nnamespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    fun deep(x): x + 1\nOuter.Inner.deep(4)\n")
       (for ([needle '("namespace Inner" "Outer.Inner")])
         (rhombus-document-refusal text needle "Inner" "Inside")
         (rhombus-workspace text "#lang rhombus\n" needle "Inner" "Inside")))))
  (test-case "Rhombus nested namespace member rename edits its own component"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nnamespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    fun deep(x): x + 1\nOuter.Inner.deep(4)\n")
       (for ([needle '("fun deep" "Outer.Inner.deep")])
         (rhombus-document-refusal text needle "deep" "deeper")
         (rhombus-workspace text "#lang rhombus\n" needle "deep" "deeper")))))
  (test-case "Rhombus namespace classes retain class family rules"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nnamespace Tools:\n  export: Point\n  class Point(Point)\ndef p :: Tools.Point = Tools.Point(1)\np.Point\n")
       (define changed "#lang rhombus\nnamespace Tools:\n  export: Position\n  class Position(Point)\ndef p :: Tools.Position = Tools.Position(1)\np.Point\n")
       (for ([needle '("class Point" "= Tools.Point")])
         (rhombus-document-refusal text needle "Point" "Position")
         (rhombus-workspace text "#lang rhombus\n" needle "Point" "Position" #f
                            (list changed "#lang rhombus\n"))))))
  (test-case "Rhombus namespace fields require resolved access"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nnamespace Tools:\n  export: Point\n  class Point(x)\ndef p = Tools.Point(1)\np.x\n")
       (rhombus-document-refusal text "class Point" "Point" "Position")
       (rhombus-workspace text "#lang rhombus\n" "class Point" "Point" "Position" #f
                            (list (string-replace text "Point" "Position") "#lang rhombus\n"))
       (for ([needle '("Point(x" "p.x")])
         (rhombus-document-refusal text needle "x" "ordinate")
         (rhombus-workspace text "#lang rhombus\n" needle "x" "ordinate" #f
                            (list (regexp-replace* #px"\\bx\\b" text "ordinate") "#lang rhombus\n")))
       (define dynamic (string-append text "fun dyn(v): v.x\n"))
       (for ([needle '("Point(x" "p.x")])
         (define doc (document dynamic))
         (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) (position doc dynamic needle "x") "ordinate")))
         (check-equal? (doc-get-text doc) dynamic)
         (rhombus-refusal dynamic "#lang rhombus\n" needle "x" "ordinate"))
       (with-workspace
        (lambda (file client sources)
          (for ([selected (in-list (list file client))] [needle '("Point(x" "p.x")])
            (define source (hash-ref sources selected))
            (define doc (make-doc (path->uri selected) source))
            (check-exn exn:fail?
                       (lambda () (workspace-rename sources selected
                                    (json-pos (position doc source needle "x")) "ordinate"))))
          (for ([(path source) (in-hash sources)]) (check-equal? (file->string path) source)))
        (string-replace text "#lang rhombus" "#lang rhombus\nexport: Tools")
        "#lang rhombus\nimport: \"model.rhm\" open\ndef p = Tools.Point(2)\np.x\nfun dyn(v): v.x\n"
        #:suffix ".rhm"))))
  (test-case "Rhombus imported namespace components rename across files"
    (with-rhombus
     (lambda ()
       (for ([entry
              (in-list
               (list
                (list "#lang rhombus\nexport: Tools\nnamespace Tools:\n  export: scale\n  fun scale(x): x * 2\nTools.scale(2)\n" "Tools.scale(3)\n" "fun scale" "Tools.scale" "scale" "resize")
                (list "#lang rhombus\nexport: Outer\nnamespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    fun deep(x): x + 1\nOuter.Inner.deep(4)\n" "Outer.Inner.deep(3)\n" "namespace Inner" "Outer.Inner" "Inner" "Inside")
                (list "#lang rhombus\nexport: Outer\nnamespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    fun deep(x): x + 1\nOuter.Inner.deep(4)\n" "Outer.Inner.deep(3)\n" "fun deep" "Outer.Inner.deep" "deep" "deeper")
                (list "#lang rhombus\nexport: Tools\nnamespace Tools:\n  export: Point\n  class Point(x)\nTools.Point(1)\n" "def p = Tools.Point(2)\np.x\n" "class Point" "Tools.Point" "Point" "Position")
                (list "#lang rhombus\nexport: Tools\nnamespace Tools:\n  export: Point\n  class Point(x)\ndef p = Tools.Point(1)\np.x\n" "def p = Tools.Point(2)\np.x\n" "Point(x" "p.x" "x" "ordinate")))])
         (define text (car entry))
         (define use (string-append "#lang rhombus\nimport: \"model.rhm\" open\n" (cadr entry)))
         (for ([client? '(#f #t)])
           (rhombus-workspace text use (list-ref entry (if client? 3 2))
                              (list-ref entry 4) (list-ref entry 5) client?
                              (for/list ([source (in-list (list text use))])
                                (regexp-replace* (pregexp (string-append "\\b" (list-ref entry 4) "\\b"))
                                                 source (list-ref entry 5)))))))))
  (test-case "Rhombus namespace collisions and unsupported forms refuse without edits"
    (with-rhombus
     (lambda ()
       (define plain "#lang rhombus\nnamespace Tools:\n  export: scale\n  fun scale(x): x * 2\nTools.scale(2)\n")
       (rhombus-document-refusal plain "fun scale" "scale" "resize")
       (rhombus-workspace plain "#lang rhombus\n" "fun scale" "scale" "resize" #f
                            (list (string-replace plain "scale" "resize") "#lang rhombus\n"))
       (for ([text (in-list
                    (list
                     (string-replace plain "  export: scale" "  export: scale\n  export: resize\n  fun resize(x): x")
                     (string-replace plain "  export: scale" "  export:\n    rename: scale as public")
                     (string-append plain "namespace ~extend Tools:\n  export: spare\n  def spare = 1\n")
                     (string-append plain "fun dyn(v): v.scale(2)\n")
                     (string-append plain "export: all_from(.Tools)\n")))])
         (define name (if (string-contains? text "resize") "resize" "resized"))
         (define valid (if (string-contains? text "as public") (string-replace text "Tools.scale(2)" "Tools.public(2)") text))
         (for ([needle (list "fun scale" (if (string-contains? text "as public") "fun scale" "Tools.scale"))])
           (with-check-info (['source valid] ['needle needle])
             (rhombus-refusal valid "#lang rhombus\n" needle "scale" name)))))))
  (test-case "Rhombus malformed provider matrix refuses in the workspace"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\ndef square = 9\nsquare\n")
       (define good (hasheq 'valid? #t 'complete? #t))
       (define select (current-language-adapter-rename))
       (define (edit req)
         (hasheq 'uri (hash-ref req 'uri) 'range '(18 . 24) 'old-text "square" 'new-text "area"))
       (define cases
         (list (cons 'false (lambda (_) #f))
               (cons 'non-hash (lambda (_) 'yes))
               (cons 'mutable (lambda (_) (hash-copy good)))
               (cons 'missing (lambda (_) (hasheq 'valid? #t)))
               (cons 'nonboolean (lambda (_) (hash-set good 'valid? 1)))
               (cons 'by-name (lambda (_) (hash-set good 'by-name? 1)))
               (cons 'refusal (lambda (_) (hash-set good 'valid? #f)))
               (cons 'incomplete (lambda (_) (hash-set good 'complete? #f)))
               (cons 'reason (lambda (_) (hash-set good 'reason 17)))
               (cons 'canonical (lambda (_) (hash-set good 'canonical 17)))
               (cons 'unknown-family (lambda (_) (hash-set good 'family 17)))
               (cons 'family (lambda (_) (hash-set good 'family (box 'bad))))
               (cons 'family-procedure (lambda (_) (hash-set good 'family void)))
               (cons 'family-cycle (lambda (_) (hash-set good 'family (read (open-input-string "#0=(x . #0#)")))))
               (cons 'edits (lambda (_) (hash-set good 'edits 17)))
               (cons 'outside-uri (lambda (r) (hash-set good 'edits (list (hash-set (edit r) 'uri "untitled:outside")))))
               (cons 'outside-range (lambda (r) (hash-set good 'edits (list (hash-set (edit r) 'range '(999 . 1005))))))
               (cons 'old-text (lambda (r) (hash-set good 'edits (list (hash-set (edit r) 'old-text "wrong!")))))
               (cons 'replacement (lambda (r) (hash-set good 'edits (list (hash-set (edit r) 'new-text "other")))))
               (cons 'overlap (lambda (r) (hash-set good 'edits (list (edit r) (hash-set (edit r) 'range '(19 . 25))))))
               (cons 'duplicate (lambda (r) (hash-set good 'edits (list (edit r) (edit r)))))
               (cons 'mutable-edit (lambda (r) (hash-set good 'edits (list (hash-copy (edit r))))))))
       (for* ([entry (in-list cases)] [stage '(prepare plan)])
         (with-check-info (['answer (car entry)] ['stage stage])
           (parameterize ([current-language-adapter-rename
                           (lambda (adapter)
                             (and (select adapter)
                                  (lambda (request)
                                    (case (hash-ref request 'stage)
                                      [(scan) (hasheq 'names '() 'computed? #f 'exports '())]
                                      [else (if (eq? (hash-ref request 'stage) stage) ((cdr entry) request) good)]))))])
             (rhombus-refusal text "#lang rhombus\n" "def square" "square" "area")))))))

  (for ([fixture (in-list
                 (list
                  (list "providerless origin retains importing namespace interfaces" "#lang racket/base\n(provide square)\n(define square 1)\n" "#lang rhombus/and_meta\nimport: \"model.rhm\" open\ndecl.macro 'make $name':\n  let public = Syntax.make_id(if name.unwrap() == #'square | \"first\" | \"second\")\n  'namespace Tools:\n     export:\n       rename: field as $public\n     def field = $name\n   export: Tools'\nmake square\nsquare\n" "define square" "square" "area")
                  (list "Rhombus expanded macro field refuses member rename" "#lang rhombus/and_meta\nclass Point(x)\nexpr.macro 'read($v)': '$(v).x'\nfun dyn(v): read(v)\ndyn(Point(1))\n" "#lang rhombus\n" "Point(x" "x" "ordinate")
                  (list "Rhombus expanded macro method refuses member rename" "#lang rhombus/and_meta\nclass Point():\n  method norm(): 1\nexpr.macro 'read($v)': '$(v).norm()'\nfun dyn(v): read(v)\ndyn(Point())\n" "#lang rhombus\n" "method norm" "norm" "lengthy")
                  (list "Rhombus template escape refuses member rename" "#lang rhombus/and_meta\nclass Point(x)\nfun dyn(v): '$(v.x)'\ndyn(Point(1))\n" "#lang rhombus\n" "Point(x" "x" "ordinate")
                  (list "Rhombus mixed static and dynamic access refuses member rename" "#lang rhombus/and_meta\nclass Point(x)\nclass Other(x)\nexpr.macro 'both $v . $field':\n  '($v . $field) + Other . $field(Other(1))'\nfun dyn(v): both v.x\ndyn(Point(2))\n" "#lang rhombus\n" "Point(x" "x" "ordinate")
                  (list "Rhombus imported macro access refuses member rename" "#lang rhombus\nexport: Tools\nnamespace Tools:\n  export: Point\n  class Point(x)\n" "#lang rhombus/and_meta\nimport: \"model.rhm\" open\nexpr.macro 'read($v)': '$(v).x'\nfun dyn(v): read(v)\ndyn(Tools.Point(1))\n" "Point(x" "x" "ordinate")
                  (list "Rhombus dynamically reached replacement refuses member rename" "#lang rhombus\nclass Point(x)\nclass Other(ordinate)\nfun dyn(v): v.ordinate\ndyn(Other(1))\n" "#lang rhombus\n" "Point(x" "x" "ordinate")
                  (list "Rhombus unrelated namespace public export change refuses" "#lang rhombus/and_meta\ndecl.macro 'make $name':\n  let public = Syntax.make_id(if name.unwrap() == #'square | \"first\" | \"second\")\n  'def $name = 1\n   namespace Tools:\n     export:\n       rename: field as $public\n     def field = 2\n   export: Tools'\nmake square\nsquare\n" "#lang rhombus\n" "make square" "square" "area")))])
    (test-case (car fixture)
      (with-rhombus (lambda () (apply rhombus-refusal (cdr fixture))))))
  (test-case "Rhombus member scans include importing Racket code"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nexport: make_point\nclass Point(x)\nfun make_point(): Point(1)\n")
       (define use "#lang racket/base\n(require \"model.rhm\" rhombus/dot)\n(dynamic-dot-ref (make_point) 'x)\n")
       (with-workspace
        (lambda (file client sources)
          (document use (path->uri client))
          (define doc (make-doc (path->uri file) text))
          (check-exn #rx"run-time member lookup"
                     (lambda () (workspace-rename sources file (json-pos (position doc text "Point(x" "x")) "ordinate")))
          (for ([(path original) (in-hash sources)]) (check-equal? (file->string path) original)))
        text use #:suffix ".rhm"))))
  (test-case "Rhombus computed access refuses member rename"
    (with-rhombus
     (lambda ()
       (define select (current-language-adapter-rename))
       (define computed? #f)
       (parameterize ([current-language-adapter-rename
                       (lambda (adapter)
                         (define provider (select adapter))
                         (and provider
                              (lambda (request)
                                (define answer (provider request))
                                (when (eq? (hash-ref request 'stage) 'scan)
                                  (set! computed? (or computed? (hash-ref answer 'computed?))))
                                answer)))])
         (rhombus-refusal "#lang rhombus\nimport: lib(\"rhombus/dot.rkt\") open\nclass Point(x)\ndef name = #'x\n#{dynamic-dot-ref}(Point(1), name)\n"
                          "#lang rhombus\n" "Point(x" "x" "ordinate"))
       (check-true computed?))))
  (test-case "Rhombus same-spelled class and field select separate owners"
    (with-rhombus
     (lambda ()
       (for ([prefix '("" "namespace Tools:\n  export: Point\n  ")])
         (define ns? (not (equal? prefix "")))
         (define ctor (if ns? "Tools.Point" "Point"))
         (define text (string-append "#lang rhombus\n" prefix "class Point(Point)\ndef p :: " ctor " = " ctor "(1)\np.Point\n"))
         (define field (string-replace (string-replace text "Point(Point)" "Point(ordinate)") "p.Point" "p.ordinate"))
         (rhombus-workspace text "#lang rhombus\n" "Point(Point" "Point" "ordinate" #f (list field "#lang rhombus\n"))
         (define renamed (string-replace (string-replace (string-replace text "class Point" "class Position") "export: Point" "export: Position") ctor (if ns? "Tools.Position" "Position")))
         (define expected (string-replace (string-replace renamed "Position(Position)" "Position(Point)") "p.Position" "p.Point"))
         (rhombus-workspace text "#lang rhombus\n" "class Point" "Point" "Position" #f (list expected "#lang rhombus\n"))))))
  (test-case "providerless portal content retains interface validation"
    (define text #<<SRC
#lang racket/base
(require (for-syntax racket/base))
(define-syntax (make stx)
  (syntax-case stx ()
    [(_ name)
     (with-syntax ([public (datum->syntax #f (if (eq? (syntax-e #'name) 'square) 'first 'second))]
                   [Tools ((make-interned-syntax-introducer 'rhombus/namespace) #'Tools)])
       #'(begin (define name 1)
                (define field 2)
                (#%require (portal Tools (nspace Tools #f (public field))))
                (#%provide (for-space rhombus/namespace Tools))))]))
(make square)
square
SRC
)
    (define doc (document text))
    (check-false (doc-rename-provider doc))
    (define pos (position doc text "make square" "square"))
    (check-false (doc-rename doc (Doc-uri doc) pos "area"))
    (with-workspace
     (lambda (file client sources)
       (check-exn exn:fail? (lambda () (workspace-rename sources file (json-pos pos) "area"))))
     text "#lang racket/base\n"))
  (test-case "providerless exported macro retains scoped template reference"
    (with-workspace
     (lambda (file client sources) (workspace-success file sources "define square" "square"))
     "#lang racket/base\n(provide get)\n(define square 1)\n(define-syntax-rule (get) square)\nsquare\n"
     "#lang racket/base\n(require \"model.rkt\")\n(get)\n"))
  (test-case "Rhombus untitled buffers require saving before rename"
    (with-rhombus
     (lambda ()
       (define doc (document rhombus-function))
       (define pos (position doc rhombus-function "fun square" "square"))
       (parameterize ([current-language-adapter-rename (lambda (_) #f)])
         (check-exn #rx"Save the file in the workspace first" (lambda () (doc-prepare-rename doc pos)))
       (check-exn #rx"Save the file in the workspace first" (lambda () (doc-rename doc (Doc-uri doc) pos "area")))))))

  (test-case "Rhombus static field and method renames succeed"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nclass Point(x):\n  method norm(): 1\ndef p :: Point = Point(1)\np.x + p.norm()\n")
       (rhombus-workspace text "#lang rhombus\n" "Point(x" "x" "ordinate")
       (rhombus-workspace text "#lang rhombus\n" "method norm" "norm" "lengthy"))))
  (test-case "Rhombus unavailable dot bindings fail safely"
    (with-rhombus
     (lambda ()
       (define select (current-language-adapter-rename))
       (define seen #f)
       (define scans 0)
       (parameterize ([current-language-adapter-rename
                       (lambda (adapter)
                         (define provider (select adapter))
                         (and provider
                              (lambda (request)
                                (if (and (eq? (hash-ref request 'stage) 'scan)
                                         (begin (set! scans (add1 scans)) (> scans 2)))
                                    (let ([resolve (current-module-name-resolver)])
                                      (parameterize ([current-module-name-resolver
                                                      (lambda args
                                                        (when (equal? (car args) '(submod rhombus/private/amalgam dot))
                                                          (error 'rename "Dot bindings unavailable."))
                                                        (apply resolve args))])
                                        (define answer (provider request))
                                        (set! seen (hash-ref answer 'computed?))
                                        answer))
                                    (provider request)))))])
         (rhombus-refusal "#lang rhombus\nclass Point(x)\ndef p :: Point = Point(1)\np.x\n"
                          "#lang rhombus\n" "Point(x" "x" "ordinate"))
       (check-true seen))))
  (test-case "Rhombus unrelated namespace tokens grant no veto"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus\nnamespace Tools:\n  export: scale\n  fun scale(x): x*2\nTools.scale(2)\ndef rename = 1\ndef all_from = 2\n")
       (rhombus-workspace text "#lang rhombus\n" "fun scale" "scale" "resize"))))
  (test-case "Rhombus malformed scan records refuse without edits"
    (with-rhombus
     (lambda ()
       (define select (current-language-adapter-rename))
       (define good (hasheq 'names '() 'computed? #f 'exports '()))
       (for ([bad (in-list (list #f (hash-copy good) (hash-remove good 'names)
                                 (hash-set good 'names '(17)) (hash-set good 'computed? 1)
                                 (hash-remove good 'computed?) (hash-set good 'exports '(17))))])
         (parameterize ([current-language-adapter-rename
                         (lambda (adapter)
                           (define provider (select adapter))
                           (and provider (lambda (request)
                                           (if (eq? (hash-ref request 'stage) 'scan) bad (provider request)))))])
           (rhombus-refusal rhombus-function "#lang rhombus\n" "fun square" "square" "area"))))))

  (test-case "Rhombus macro-created fields require member classification"
    (with-rhombus
     (lambda ()
       (define text "#lang rhombus/and_meta\ndefn.macro 'make $name($field)': 'class $name($field)'\nmake Point(x)\nfun dyn(v): v.x\ndyn(Point(1))\n")
       (define select (current-language-adapter-rename))
       (define by-name? #f)
       (parameterize ([current-language-adapter-rename
                       (lambda (adapter)
                         (define provider (select adapter))
                         (and provider
                              (lambda (request)
                                (define answer (provider request))
                                (when (eq? (hash-ref request 'stage) 'plan)
                                  (set! by-name? (hash-ref answer 'by-name?)))
                                answer)))])
         (rhombus-refusal text "#lang rhombus\n" "Point(x" "x" "ordinate"))
       (check-true by-name?)
       ;; Proven ordinary definitions remain editable alongside reflection.
       (for ([declaration '("def square = 9" "fun square(): 9" "class square()")])
         (define ordinary (string-append "#lang rhombus\n" declaration "\nsquare\n"))
         (rhombus-workspace ordinary "#lang racket/base\n(define reflect eval)\n"
                            declaration "square" "area" #f
                            (list (string-replace ordinary "square" "area")
                                  "#lang racket/base\n(define reflect eval)\n"))))))
  (for ([reflection '(dynamic-require eval eval-syntax)])
    (test-case (format "Rhombus member scans refuse reflection through ~a" reflection)
      (with-rhombus
       (lambda ()
         (define text "#lang rhombus\nexport: make_point\nclass Point(x)\nfun make_point(): Point(1)\n")
         (define use
           (case reflection
             [(dynamic-require)
              "#lang racket/base\n(require \"model.rhm\")\n(define read-field (dynamic-require 'rhombus/dot 'dynamic-dot-ref))\n(read-field (make_point) 'x)\n"]
             [(eval)
              "#lang racket/base\n(require \"model.rhm\" (rename-in racket/base [eval reflect]))\n(define read-field (reflect '(dynamic-require 'rhombus/dot 'dynamic-dot-ref) (make-base-namespace)))\n(read-field (make_point) 'x)\n"]
             [else
              "#lang racket/base\n(require \"model.rhm\")\n(define load (eval-syntax #'dynamic-require (make-base-namespace)))\n(define read-field (load 'rhombus/dot 'dynamic-dot-ref))\n(read-field (make_point) 'x)\n"]))
         (with-workspace
          (lambda (file client sources)
            (document use (path->uri client))
            (define doc (make-doc (path->uri file) text))
            (check-exn #rx"run-time member lookup"
                       (lambda () (workspace-rename sources file
                                    (json-pos (position doc text "Point(x" "x")) "ordinate")))
            (for ([(path original) (in-hash sources)]) (check-equal? (file->string path) original)))
          text use #:suffix ".rhm")
         ;; Local names with the same spelling do not denote reflection.
         (rhombus-workspace "#lang rhombus\nclass Point(x)\ndef p :: Point = Point(1)\np.x\n"
                            "#lang racket/base\n(define eval 1)\n(define dynamic-require 2)\n"
                            "Point(x" "x" "ordinate" #f
                            (list "#lang rhombus\nclass Point(ordinate)\ndef p :: Point = Point(1)\np.ordinate\n"
                                  "#lang racket/base\n(define eval 1)\n(define dynamic-require 2)\n"))))))
  (test-case "Rhombus namespace owners cannot authorise other member exports"
    (with-rhombus
     (lambda ()
       (rhombus-refusal
        "#lang rhombus/and_meta\ndecl.macro 'make $name':\n  let public = Syntax.make_id(if name.unwrap() == #'Tools | \"first\" | \"second\")\n  'namespace $name:\n     export:\n       rename: field as $public\n     def field = 2\n   export: $name'\nmake Tools\n"
        "#lang rhombus\n" "make Tools" "Tools" "Kit"))))
  (test-case "Rhombus relocated public names grant no edit permission"
    (with-rhombus
     (lambda ()
       (rhombus-refusal
        "#lang rhombus/and_meta\ndecl.macro 'make $name':\n  let public = Syntax.make_id(if name.unwrap() == #'square | \"first\" | \"second\").relocate(name.srcloc())\n  'def $name = 1\n   namespace Tools:\n     export:\n       rename: field as $public\n     def field = 2\n   export: Tools'\nmake square\nsquare\n"
        "#lang rhombus\n" "make square" "square" "area"))))
  (for ([level '(scan export interface owner)])
    (test-case (format "Rhombus scan rejects non-symbol keys in ~a records" level)
      (with-rhombus
       (lambda ()
         (define select (current-language-adapter-rename))
         (define (bad record) (hash-set record 17 'bad))
         (parameterize ([current-language-adapter-rename
                         (lambda (adapter)
                           (define provider (select adapter))
                           (and provider
                                (lambda (request)
                                  (define answer (provider request))
                                  (if (eq? (hash-ref request 'stage) 'scan)
                                      (case level
                                        [(scan) (bad answer)]
                                        [else
                                         (hash-update answer 'exports
                                           (lambda (exports)
                                             (for/list ([entry (in-list exports)])
                                               (case level
                                                 [(export) (bad entry)]
                                                 [(interface) (hash-update entry 'interface bad)]
                                                 [(owner) (hash-update entry 'owners (lambda (owners) (map bad owners)))]))))])
                                      answer))))])
           (rhombus-refusal "#lang rhombus\nexport: square\ndef square = 9\nsquare\n"
                            "#lang rhombus\n" "def square" "square" "area"))))))
  (test-case "Rhombus imported target family keys remain valid"
    (with-rhombus
     (lambda ()
       (define select (current-language-adapter-rename))
       (define seen #f)
       (parameterize ([current-language-adapter-rename
                       (lambda (adapter)
                         (define provider (select adapter))
                         (and provider
                              (lambda (request)
                                (define answer (provider request))
                                (if (eq? (hash-ref request 'stage) 'plan)
                                    (let ([family (findf (lambda (family)
                                                          (eq? (syntax-e (hash-ref family 'canonical)) 'square))
                                                        (hash-ref (hash-ref request 'target) 'families))])
                                      (check-not-false family)
                                      (set! seen #t)
                                      (hash-set answer 'family (hash-ref family 'key)))
                                    answer))))])
         (rhombus-workspace rhombus-function rhombus-open "\nsquare" "square" "area" #t))
       (check-true seen))))
)
