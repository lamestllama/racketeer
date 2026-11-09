#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/list racket/file racket/string drracket/check-syntax
         "../../common/source.rkt"
         "../../doclib/internal-types.rkt"
         "../../doclib/doc.rkt"
         "../../common/interfaces.rkt"
         "../../doclib/check-syntax.rkt"
         "../../doclib/doc-trace.rkt"
         "../../doclib/editor.rkt"
         "../../doclib/lexer.rkt"
         "../../workspace/api.rkt"
         "../../lsp/compose/references.rkt")

(define source (path->source (build-path (current-directory) "generic.rkt")))
(define prefix
  (string-append
    "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
    "(define-syntax (define-thing stx)\n"
    "  (syntax-case stx () [(_ name)\n"
    "    (with-syntax ([helper (format-id #'name \"~a-helper\" #'name #:source #'name)])\n"
    "      #'(begin (define name 1) (define helper 2)))]))\n"))

(define (analyse text only? [source source] [facts-box #f] [provider #f])
  (define editor (new lsp-editor%))
  (send editor insert text 0)
  (define trace (new build-trace% [source source] [doc-text editor]
                     [lexer-state (build-lexer-state text (source-uri source))]
                     [contribution-only? only?]))
  (define expanded
    (expand-source source (open-input-string text) trace #:contribution-only? only?
                   #:bindings-provider
                   (lambda (request)
                     (define facts (hash-ref request 'facts))
                     (when facts-box (set-box! facts-box facts))
                     (if provider (provider facts) (hasheq)))))
  (check-true (ExpandResult-all-succeed? expanded))
  (send trace walk-stx expanded)
  trace)

(define (check-identities text expected)
  (define full (analyse text #f))
  (define only (analyse text #t))
  (check-equal? (send full get-contribution) (send only get-contribution))
  (define definitions (Doc-Contribution-definitions (send full get-contribution)))
  (for ([id (in-list expected)])
    (check-true (for/or ([binding (in-hash-keys definitions)])
                  (eq? id (Module-Binding-id binding))) (symbol->string id))))

(module+ rename-safety
  (define local-text
    "#lang htdp/isl+\n(define (f n)\n (local [(define-struct point (x))]\n  (point-x (make-point n))))\n(f 1)\n")
  (define cases
    (list
      (list "local teaching structure" local-text (Pos 3 3))
      (list "escaped constructor"
            "#lang racket/base\n(struct point (x))\n(define p (|point| 1))\n(point-x p)\n"
            (Pos 1 8))
      (list "macro-rebuilt escaped accessor"
            (string-append
              "#lang racket/base\n(require (for-syntax racket/base))\n"
              "(define-syntax (call stx)\n (syntax-case stx ()\n  [(_ fn arg)\n"
              "   (with-syntax ([fn (datum->syntax #'fn (syntax-e #'fn) #'fn)])\n"
              "    #'(fn arg))]))\n(struct point (x))\n"
              "(define p (point 1))\n(call |point-x| p)\n")
            (Pos 7 15))
      (list "escaped accessor"
            "#lang racket/base\n(struct point (x))\n(define p (point 1))\n(|point-x| p)\n"
            (Pos 1 15))))
  (for* ([example (in-list cases)] [only? '(#f #t)])
    (define text (cadr example))
    (define trace (analyse text only?))
    (define doc (make-doc (source-uri source) text))
    (doc-update-trace! doc trace (send trace get-contribution) 0)
    (test-case (format "~a refuses prepare rename in mode ~a" (car example) only?)
      (check-false (doc-prepare-rename doc (caddr example))))
    (test-case (format "~a refuses rename in mode ~a" (car example) only?)
      (check-false (doc-rename doc (source-uri source) (caddr example) "changed"))))
  (for ([only? '(#f #t)])
    (test-case (format "local teaching structure preserves its precise anchor in mode ~a" only?)
      (define declarations (send (analyse local-text only?) get-declaration))
      (define start (caar (regexp-match-positions #rx"point \\(x" local-text)))
      (check-equal? (send declarations occurrence-at start) (CharRange start (+ start 5))))))

(module+ test (require (submod ".." rename-safety)))

(module+ test
  (test-case "macro-created unused binders retain core anchors in both modes"
    (define text (string-append prefix "(define-thing thing)\n"))
    (check-identities text '(thing thing-helper))
    (for ([only? '(#f #t)])
      (define facts-box (box #f))
      (define declarations (send (analyse text only? source facts-box) get-declaration))
      (define facts (unbox facts-box))
      (for ([id '(thing thing-helper)])
        (check-true
          (for/or ([name (in-list (hash-ref facts 'names))])
            (and (eq? (hash-ref name 'role) 'definition)
                 (eq? (syntax-e (hash-ref name 'identifier)) id)
                 (pair? (hash-ref name 'anchor))))))))

  (test-case "locationless generated storage retains identity and a core binder anchor"
    (define text
      (string-append
        "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
        "(define-syntax (define-thing stx)\n"
        " (syntax-case stx () [(_ name)\n"
        "  (with-syntax ([helper (format-id #'name \"~a-helper\" #'name)])\n"
        "   #'(begin (define name 1) (define helper 2)))]))\n"
        "(define-thing thing)\n(provide thing thing-helper)\n"))
    (define full-facts (box #f))
    (define only-facts (box #f))
    (define full (analyse text #f source full-facts))
    (define only (analyse text #t source only-facts))
    (check-equal? (send full get-contribution) (send only get-contribution))
    (for ([trace (in-list (list full only))] [facts-box (in-list (list full-facts only-facts))])
      (define facts (unbox facts-box))
      (check-true
        (for/or ([binder (in-list (hash-ref facts 'binders))])
          (and (eq? 'thing-helper (syntax-e (hash-ref binder 'identifier)))
               (not (syntax-position (hash-ref binder 'identifier)))
               (eq? (hash-ref binder 'role) 'define-values)
               (Module-Binding? (hash-ref binder 'binding))
               (member (hash-ref binder 'binding)
                       (append (hash-keys (Doc-Contribution-definitions (send trace get-contribution)))
                               (hash-keys (Doc-Contribution-references (send trace get-contribution)))))
               (pair? (hash-ref binder 'anchor)))))))

  (test-case "a struct forwarded through a macro exports every identity"
    (check-identities
      "#lang racket/base\n(define-syntax-rule (define-record name) (struct name ()))\n(define-record item)\n(provide (struct-out item))\nitem\nitem?\nstruct:item\n"
      '(item item? struct:item)))

  (test-case "define-values through a macro keeps identities without using nominal export names"
    (define text
      (string-append prefix
        "(define-syntax (define-many stx)\n"
        " (syntax-case stx () [(_ name)\n"
        "  (with-syntax ([helper (format-id #'name \"~a-helper\" #'name #:source #'name)])\n"
        "   #'(define-values (name helper) (values 1 2)))]))\n"
        "(define-many many)\n(provide many (rename-out [many-helper many-public]))\n"
        "(define many-public 5)\nmany\nmany-helper\nmany-public\n"))
    (check-identities text '(many many-helper many-public))
    (define pos (add1 (caar (regexp-match-positions #rx"\nmany-public\n" text))))
    (for ([only? '(#f #t)])
      (define declarations (send (analyse text only?) get-declaration))
      (check-equal? (send declarations uses-at pos) (list (CharRange pos (+ pos 11))))))

  (test-case "core binder anchors retain phases and submodule identities"
    (check-identities
      (string-append prefix "(begin-for-syntax (define phase-name 1))\n"
        "(module inner racket/base (define inside 2) (provide inside))\n")
      '(phase-name inside))
    (define text
      (string-append
        "#lang racket/base\n(require (for-syntax racket/base))\n"
        "(define-syntax-rule (define-at-both name)\n"
        " (begin (define name 1) (begin-for-syntax (define name 2))))\n"
        "(define-at-both shared)\nshared\n(begin-for-syntax shared)\n"))
    (define runtime-pos (add1 (caar (regexp-match-positions #rx"\nshared\n" text))))
    (define syntax-pos (+ (caar (regexp-match-positions #rx"begin-for-syntax shared" text))
                          (string-length "begin-for-syntax ")))
    (for ([only? '(#f #t)])
      (define declarations (send (analyse text only?) get-declaration))
      (for ([pos (in-list (list runtime-pos syntax-pos))] [phase '(0 1)])
        (check-equal? (send declarations module-binding-at pos)
                      (Module-Binding (source-file-path source) '() phase 'shared))
        (check-equal? (send declarations uses-at pos) (list (CharRange pos (+ pos 6))))))
    ;; A plain require imports phase-1 exports with an import shift of zero.
    (define lib (make-temporary-file "phase-export~a.rkt"))
    (dynamic-wind
      void
      (lambda ()
        (display-to-file
          "#lang racket/base\n(require (for-syntax racket/base))\n(define shared 1)\n(begin-for-syntax (define shared 2))\n(provide (for-syntax shared))\n"
          lib #:exists 'truncate)
        (define imported
          (format "#lang racket/base\n(require (for-syntax racket/base))\n(require (file ~s))\n(begin-for-syntax shared)\n" (path->string lib)))
        (define pos (+ (caar (regexp-match-positions #rx"begin-for-syntax shared" imported))
                       (string-length "begin-for-syntax ")))
        (for ([only? '(#f #t)])
          (define declarations (send (analyse imported only?) get-declaration))
          (check-equal? (send declarations module-binding-at pos)
                        (Module-Binding (source-file-path (path->source lib)) '() 1 'shared))))
      (lambda () (delete-file lib))))

  (for ([body (in-list '("(define name 1) (define helper 2)"
                         "(struct name ())"
                         "(define-values (name helper) (values 1 2))"))]
        [kind '("definitions" "struct binders" "value binders")])
    (test-case (format "unused generated local ~a retain their authored anchor" kind)
      (define text
        (string-append
          "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
          "(define-syntax (with-created stx)\n"
          " (syntax-case stx () [(_ source)\n"
          "  (with-syntax ([name (format-id #'source \"~a\" #'source #:source #'source)]\n"
          "                [helper (format-id #'source \"~a-helper\" #'source #:source #'source)])\n"
          "   #'(let () " body " 0))]))\n"
          "(with-created local)\n"))
      (define start (+ (caar (regexp-match-positions #rx"with-created local" text)) 13))
      (for ([only? '(#f #t)])
        (define declarations (send (analyse text only?) get-declaration))
        (check-equal? (send declarations occurrence-at start) (CharRange start (+ start 5)))
        (check-true (> (send declarations binding-count-at start) 1)))))

  (test-case "scoped lexical owners at one range keep separate uses"
    (define text
      (string-append
        "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
        "(define-syntax (two-locals stx)\n"
        " (syntax-case stx () [(_ origin left right)\n"
        "  (let* ([a (format-id #'origin \"~a\" #'origin #:source #'origin)]\n"
        "         [b ((make-syntax-introducer) a)]\n"
        "         [a-use (datum->syntax a (syntax-e a) #'left)]\n"
        "         [b-use (datum->syntax b (syntax-e b) #'right)])\n"
        "    (with-syntax ([a a] [b b] [a-use a-use] [b-use b-use])\n"
        "      #'(let ([a 1] [b 2]) (list a-use b-use))))]))\n"
        "(two-locals local local local)\n"))
    (define start (+ (caar (regexp-match-positions #rx"two-locals local" text)) 11))
    (for ([only? '(#f #t)])
      (define declarations (send (analyse text only?) get-declaration))
      (check-equal? (send declarations binding-count-at start) 2)
      (for ([offset '(6 12)])
        (check-equal? (send declarations uses-at (+ start offset))
                      (list (CharRange (+ start offset) (+ start offset 5)))))))

  (test-case "reference lookup keys expand an explicit family without joining a shared-range outsider"
    (define text (string-append prefix "(define-thing thing)\nthing\nthing-helper\n; other\n"))
    (for ([only? '(#f #t)])
      (define members '())
      (define trace
        (analyse text only? source #f
          (lambda (facts)
            (set! members
                  (for/list ([id '(thing thing-helper)])
                    (for/first ([name (in-list (hash-ref facts 'names))]
                                #:when (and (eq? (hash-ref name 'role) 'definition)
                                            (eq? (syntax-e (hash-ref name 'identifier)) id)))
                      name)))
            (hasheq 'families
                    (list (hasheq 'key 'thing 'canonical (hash-ref (car members) 'identifier)
                                  'members members))))))
      (define declarations (send trace get-declaration))
      (define shared (hash-ref (car members) 'range))
      (send declarations syncheck:add-definition-target/phase-level+space
            (source-syntax-source source) (car shared) (cdr shared) 'outsider '() 0)
      (define outside (caar (regexp-match-positions #rx"other" text)))
      (send declarations syncheck:add-jump-to-definition/phase-level+space
            (source-syntax-source source) outside (+ outside 5) 'outsider
            (source-file-path source) '() 0)
      (define doc (make-doc (source-uri source) text))
      (doc-update-trace! doc trace (send trace get-contribution) 0)
      (for ([line '(7 8)])
        (define result (doc-references doc (source-uri source) (Pos line 0) #t))
        (check-equal? (sort (map Module-Binding-id (Document-Reference-Result-module-binding result)) symbol<?)
                      '(thing thing-helper))
        (check-equal? (length (filter (lambda (location)
                                       (equal? (Location-range location) (Range (Pos 6 14) (Pos 6 19))))
                                     (Reference-Source-locations (Document-Reference-Result-source result)))) 1))
      (check-equal? (send declarations reference-module-bindings-at outside)
                    (list (Module-Binding (source-file-path source) '() 0 'outsider)))))

  (test-case "quoted data and binding metadata require scoped evidence"
    (define quoted (analyse "#lang racket/base\n'(define-values (imaginary) 1)\n" #t))
    (check-equal? (hash-count (Doc-Contribution-definitions (send quoted get-contribution))) 0)
    (define text
      (string-append
        "#lang racket/base\n(require (for-syntax racket/base))\n"
        "(define-syntax (with-retained stx)\n"
        " (syntax-case stx () [(_ name use)\n"
        "  (let* ([storage (datum->syntax #'name (syntax-e #'name) #f)]\n"
        "         [expanded (with-syntax ([id storage])\n"
        "                     (local-expand #'(let ([id 1]) id) 'expression null))]\n"
        "         [bound (syntax-case expanded () [(_ ([(id) rhs]) body) #'id])]\n"
        "         [located (datum->syntax bound (syntax-e bound) #'name)]\n"
        "         [used (datum->syntax bound (syntax-e bound) #'use)]\n"
        "         [bad (syntax-property (datum->syntax #f 'unbound #'name) 'original-for-check-syntax #t)])\n"
        "    (syntax-property\n"
        "     (syntax-property\n"
        "      (syntax-property expanded 'disappeared-binding (list located bad))\n"
        "      'disappeared-use (list used bad))\n"
        "     'origin (list bad)))]))\n"
        "(with-retained local local)\n"))
    (define start (+ (caar (regexp-match-positions #rx"with-retained local" text))
                     (string-length "with-retained ")))
    (for ([only? '(#f #t)])
      (define facts-box (box #f))
      (define declarations (send (analyse text only? source facts-box) get-declaration))
      (check-equal? (send declarations definition-at (+ start 6)) (CharRange start (+ start 5)))
      (check-equal? (send declarations uses-at start) (list (CharRange (+ start 6) (+ start 11))))
      (check-false
        (for/or ([name (in-list (hash-ref (unbox facts-box) 'names))])
          (eq? 'unbound (syntax-e (hash-ref name 'identifier))))))))

(module+ test
  (for* ([language '("racket/base" "htdp/bsl" "htdp/isl+" "htdp/asl")]
         [custom? (if (equal? language "racket/base") '(#f #t) '(#f))]
         [only? '(#f #t)])
    (test-case (format "field-bearing structures preserve component queries in ~a, constructor ~a, mode ~a" language custom? only?)
      (define teaching? (not (equal? language "racket/base")))
      (define form (if teaching? "define-struct" "struct"))
      (define text
        (format "#lang ~a\n(~a point (x y)~a)\n(define sample (~apoint 3 4))\n(define (point-sum p)\n  (if (point? p) (+ (point-x p) (point-y p)) 0))\n(point-sum sample)\n"
                language form (if custom? " #:constructor-name make-point" "")
                (if (or teaching? custom?) "make-" "")))
      (define trace (analyse text only?))
      (define doc (make-doc (source-uri source) text))
      (doc-update-trace! doc trace (send trace get-contribution) 0)
      (define (at needle offset)
        (+ offset (caar (regexp-match-positions (regexp (regexp-quote needle)) text))))
      (define stem (at "point (x" 0))
      (define field (at "point (x" 7))
      (define stems (sort (append (list stem (at "point? p" 0) (at "point-x p" 0) (at "point-y p" 0))
                                  (if custom? '() (list (at "point 3" 0)))) <))
      (define fields (list field (at "point-x p" 6)))
      (define groups
        (append (list (cons 5 stems) (cons 1 fields))
                (if custom? (list (cons 10 (list (at "#:constructor-name make-point" 19)
                                                (at "make-point 3" 0)))) '())))
      (for ([group (in-list groups)])
        (define width (car group))
        (define positions (cdr group))
        (for ([absolute (in-list positions)])
          (define pos (doc-abs-pos->pos doc absolute))
          (define expected (doc-abs-pos->pos doc (car positions)))
          (check-equal? (doc-definition doc (source-uri source) pos)
                        (Location (source-uri source)
                                  (Range expected (doc-abs-pos->pos doc (+ (car positions) width)))))
          (check-equal? (doc-prepare-rename doc pos)
                        (Range pos (doc-abs-pos->pos doc (+ absolute width))))
          (define edits (doc-rename doc (source-uri source) pos "changed"))
          (check-not-false edits)
          (when edits
            (check-equal?
              (map TextEdit-range (hash-ref (WorkspaceEdit-changes edits) (string->symbol (source-uri source))))
              (for/list ([start (in-list positions)])
                (Range (doc-abs-pos->pos doc start) (doc-abs-pos->pos doc (+ start width))))))
          (unless only?
            (define hover (doc-hover doc pos))
            (check-not-false hover)
            (when hover
              (check-true (string-contains? (Hover-contents hover)
                                           (format "(~a point (x y)~a)" form (if custom? " #:constructor-name make-point" "")))))))))))

(module+ test
  (test-case "named-space exports retain their originating declaration in both modes"
    (define directory (make-temporary-file "space-exports~a" 'directory))
    (define lib (build-path directory "space-lib.rkt"))
    (define use (build-path directory "space-use.rkt"))
    (define lib-text
      (string-append "#lang racket/base\n(require (for-syntax racket/base))\n"
        "(define-syntax (def stx)\n  (syntax-case stx ()\n    [(_ id)\n"
        "     (with-syntax ([sid ((make-interned-syntax-introducer 'names) #'id 'add)])\n"
        "       #'(begin (define sid 10) (provide (for-space names sid))))]))\n(def value)\n"))
    (define use-text
      (string-append "#lang racket/base\n(require (for-syntax racket/base))\n(require \"space-lib.rkt\")\n"
        "(define-syntax (use-name stx)\n  (syntax-case stx ()\n"
        "    [(_ id) ((make-interned-syntax-introducer 'names) #'id 'add)]))\n(use-name value)\n"))
    (dynamic-wind void
      (lambda ()
        (display-to-file lib-text lib)
        (display-to-file use-text use)
        (for* ([only? '(#f #t)] [shifted? '(#f #t)])
          (define imported-text
            (if shifted?
                (string-append
                  "#lang racket/base\n(require (for-syntax racket/base) (for-meta 2 racket/base))\n"
                  "(require (for-syntax \"space-lib.rkt\"))\n(begin-for-syntax\n"
                  "  (define-syntax (use-name stx)\n    (syntax-case stx ()\n"
                  "      [(_ id) ((make-interned-syntax-introducer 'names) #'id 'add)]))\n"
                  "  (use-name value))\n")
                use-text))
          (display-to-file imported-text use #:exists 'truncate)
          (define pos (if shifted? (Pos 7 12) (Pos 6 10)))
          (define (load-doc file text)
            (define doc (make-doc (source-uri (path->source file)) text))
            (check-true (doc-expand! doc #:contribution-only? only?))
            doc)
          (define dl (load-doc lib lib-text))
          (define du (load-doc use imported-text))
          (define ws (make-workspace))
          (workspace-add-folder! ws directory)
          (workspace-set-contribution! ws (Doc-contribution dl))
          (define keys (doc-module-bindings-at du pos))
          (check-equal? (length keys) 1)
          (check-equal? (Module-Binding-phase+space (car keys)) 0)
          (define facts-box (box #f))
          (analyse imported-text only? (path->source use) facts-box)
          (define facts (unbox facts-box))
          (check-true
            (for/or ([name (in-list (hash-ref facts 'names))])
              (and (= (car (hash-ref name 'range)) (doc-pos->abs-pos du pos))
                   (eq? (hash-ref name 'space) 'names))))
          (check-true (hash-has-key? (Doc-Contribution-definitions (Doc-contribution dl)) (car keys)))
          (define locations (reference-locations ws (doc-references du (Doc-uri du) pos #t) #t))
          (check-not-false
            (member (Location (Doc-uri dl) (Range (Pos 7 5) (Pos 7 10))) locations))))
      (lambda () (delete-directory/files directory)))))

(module+ test
  (test-case "an unmapped authored member prevents component rename"
    (define text "#lang racket/base\n(struct point (x))\npoint-x\nstruct:point\n")
    (for ([only? '(#f #t)])
      (define trace (analyse text only?))
      (define doc (make-doc (source-uri source) text))
      (doc-update-trace! doc trace (send trace get-contribution) 0)
      (check-false (doc-prepare-rename doc (Pos 1 8)))
      (check-false (doc-rename doc (source-uri source) (Pos 2 0) "changed"))))

  (test-case "an unrelated generated binding at the component anchor prevents rename"
    (define text
      (string-append "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
        "(define-syntax (define-record stx)\n (syntax-case stx () [(_ name)\n"
        "  (with-syntax ([other (format-id #'name \"other\" #:source #'name)])\n"
        "   #'(begin (struct name (x)) (define other 1)))]))\n"
        "(define-record point)\npoint-x\nother\n"))
    (for ([only? '(#f #t)])
      (define trace (analyse text only?))
      (define doc (make-doc (source-uri source) text))
      (doc-update-trace! doc trace (send trace get-contribution) 0)
      (check-false (doc-prepare-rename doc (Pos 6 15)))
      (check-false (doc-rename doc (source-uri source) (Pos 7 0) "changed")))))

(module+ test
  (test-case "four thousand lexical functions retain indexed analysis cost"
    (define text
      (string-append "#lang racket/base\n"
        (string-join (for/list ([i (in-range 4000)]) (format "(define (f~a x) x)" i)) "\n") "\n"))
    (collect-garbage)
    (define-values (traces cpu real gc) (time-apply (lambda () (analyse text #t)) '()))
    (check-equal? (hash-count (Doc-Contribution-definitions (send (car traces) get-contribution))) 4000)
    (check-true (< cpu 5000) (format "lexical analysis used ~a ms CPU" cpu))))

(module+ test
  (test-case "same-spelling scoped outsiders do not become direct component members"
    (define text
      (string-append "#lang racket/base\n(require (for-syntax racket/base))\n"
        "(define-syntax (define-record stx)\n (syntax-case stx () [(_ name use)\n"
        "  (let* ([other ((make-syntax-introducer) #'name)]\n"
        "         [used (datum->syntax other (syntax-e other) #'use)])\n"
        "   (with-syntax ([other other] [used used])\n"
        "    #'(begin (struct name (x)) (define other 1) used)))]))\n"
        "(define-record point point)\npoint-x\n"))
    (for ([only? '(#f #t)])
      (define trace (analyse text only?))
      (define doc (make-doc (source-uri source) text))
      (doc-update-trace! doc trace (send trace get-contribution) 0)
      (check-false (doc-prepare-rename doc (Pos 8 15)))
      (check-false (doc-rename doc (source-uri source) (Pos 9 0) "changed")))))
