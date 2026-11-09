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
                                 (current-language-adapter-bindings))))
    (parameterize ([current-language-adapter-resolver (car launcher-hooks)]
                   [current-language-adapter-validator (cadr launcher-hooks)]
                   [current-language-adapter-bindings (caddr launcher-hooks)])
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
(define (with-workspace proc [text model] [use consumer])
  (define root (make-temporary-file "rename-binders~a" 'directory))
  (dynamic-wind void
    (lambda ()
      (define file (build-path root "model.rkt"))
      (define client (build-path root "client.rkt"))
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
       "#lang rhombus\nimport: \"model.rkt\" open\nsquare(3)\n")))))
