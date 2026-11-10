#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require drracket/check-syntax rackunit racket/class racket/file racket/list racket/string racket/runtime-path
         "../racketdap/tools/bindings-service.rkt"
         racket-langserver/common/source racket-langserver/common/interfaces
         racket-langserver/doclib/internal-types racket-langserver/doclib/check-syntax racket-langserver/doclib/doc-trace
         racket-langserver/doclib/doc racket-langserver/doclib/editor racket-langserver/doclib/lexer)

(define-runtime-path native-provider "../racketdap/adapters/rhombus-debugger.rkt")
(define root (make-temporary-file "bindings-service~a" 'directory))
(define (at text needle [component needle])
  (+ (caar (regexp-match-positions (regexp (regexp-quote needle)) text))
     (caar (regexp-match-positions (regexp (regexp-quote component)) needle))))
(define (span text needle [component needle])
  (define start (at text needle component))
  (cons start (+ start (string-length component))))
(define (same-members actual expected)
  (check-equal? (length actual) (length expected))
  (for ([item (in-list expected)]) (check-not-false (member item actual))))
(define (analyse text [provider #f] [only? #f] [filename "model.rkt"])
  (define source (path->source (build-path root filename)))
  (display-to-file text (source-file-path source) #:exists 'replace)
  (parameterize ([current-extra-service-factories (hasheq 'bindings (bindings-factory provider))])
    (define doc (make-doc (source-uri source) text))
    (define result (doc-check-syntax doc #:contribution-only? only?))
    (check-true (CSResult-succeed? result))
    (define trace (CSResult-trace result))
    (doc-update-trace! doc trace (send trace get-contribution) 0)
    (values doc (send trace get-extra-service 'bindings) trace)))
(define (name-in request id [role 'definition])
  (for/first ([name (in-list (hash-ref (hash-ref request 'facts) 'names))]
              #:when (and (eq? id (syntax-e (hash-ref name 'identifier)))
                          (eq? role (hash-ref name 'role)))) name))
(define plain "#lang racket/base\n(define value 41)\n(+ value 1)\n(define (f x) x)\n")
(define generated
  (string-append
   "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
   "(define-syntax (make-names stx)\n (syntax-case stx () [(_ name)\n"
   "  (with-syntax ([helper (format-id #'name \"~a-helper\" #'name #:source #'name)])\n"
   "   #'(begin (define name 1) (define helper 2)))]))\n"
   "(make-names thing)\nthing\nthing-helper\n(void)\n"))
(define (synthetic)
  (define source (path->source (build-path root "callbacks.rkt")))
  (define editor (new lsp-editor%))
  (send editor insert (make-string 100 #\x) 0)
  (define trace
    (parameterize ([current-extra-service-factories (hasheq 'bindings (bindings-factory))])
      (new build-trace% [source source] [doc-text editor]
           [lexer-state (build-lexer-state (send editor get-text) (source-uri source))]
           [contribution-only? #t])))
  (values source trace (send trace get-extra-service 'bindings)))
(define empty-result (ExpandResult #'(begin) #'(begin) '()))

(module+ test
  (test-case "factory registration is optional and trace-local"
    (define-values (doc service trace) (analyse plain))
    (check-true (is-a? service bindings-service%))
    (check-false (send trace get-extra-service 'absent))
    (define-values (_doc another _trace) (analyse plain))
    (check-not-eq? service another)
    (parameterize ([current-extra-service-factories (hasheq)])
      (define old (make-doc (source-uri (Doc-source doc)) plain))
      (define result (doc-check-syntax old))
      (check-true (CSResult-succeed? result))
      (check-false (send (CSResult-trace result) get-extra-service 'bindings))
      (doc-update-trace! old (CSResult-trace result) (send (CSResult-trace result) get-contribution) 0)
      (check-equal? (doc-definition-at old (Pos 2 3)) (Range (Pos 1 8) (Pos 1 13)))
      (check-equal? (Doc-contribution old) (Doc-contribution doc))))

  (test-case "module and lexical bindings need no provider"
    (define-values (_ service _trace) (analyse plain))
    (check-equal? (send service definition-ranges-at (at plain "+ value" "value"))
                  (list (span plain "define value" "value")))
    (check-equal? (send service reference-ranges-at (at plain ") x" "x"))
                  (list (span plain ") x" "x")))
    (check-equal? (send service definition-ranges-at (at plain ") x" "x"))
                  (list (span plain "f x" "x"))))

  (test-case "struct names share a target while their references remain distinct"
    (define text "#lang racket/base\n(struct item (field))\nitem\nitem?\nstruct:item\nitem-field\n")
    (define-values (_ service _trace) (analyse text))
    (for ([id '(item item? struct:item)])
      (define use (string-append "\n" (symbol->string id) "\n"))
      (define keys (send service identities-at (at text use (symbol->string id))))
      (check-equal? (map Module-Binding-id keys) (list id))
      (check-equal? (send service definitions keys) (list (span text "struct item" "item")))
      (check-equal? (send service references keys) (list (span text use (symbol->string id)))))
    (same-members (map Module-Binding-id (send service identities-at (at text "struct item" "item")))
                  '(item item? struct:item item-field)))

  (test-case "macro names keep every identity at one written anchor"
    (define-values (_ service _trace) (analyse generated))
    (check-equal? (send service reference-ranges-at (at generated "(void)" "void"))
                  (list (span generated "(void)" "void")))
    (define anchor (span generated "make-names thing" "thing"))
    (define keys (send service identities-at (car anchor)))
    (same-members (map Module-Binding-id keys) '(thing thing-helper))
    (check-equal? (send service definitions keys) (list anchor))
    (for ([id '(thing thing-helper)])
      (define use (string-append "\n" (symbol->string id) "\n"))
      (define selected (send service identities-at (at generated use (symbol->string id))))
      (check-equal? (map Module-Binding-id selected) (list id))
      (check-equal? (send service references selected) (list (span generated use (symbol->string id))))))

  (test-case "phase and binding space remain independent at a shared occurrence"
    (define-values (source trace service) (synthetic))
    (define file (source-file-path source))
    (define phases '(0 1 #f (0 . names) (1 . names)))
    (for ([phase (in-list phases)] [start '(1 3 5 7 9)])
      (send trace syncheck:add-definition-target/phase-level+space file start (add1 start) 'value '() phase)
      (send trace syncheck:add-jump-to-definition/phase-level+space file 60 61 'value file '() phase))
    (send trace syncheck:add-arrow/name-dup file 50 51 file 80 81 #t 0 #f (lambda _ #f))
    (send trace syncheck:add-arrow/name-dup file 50 51 file 82 83 #t 1 #f (lambda _ #f))
    (send trace walk-stx empty-result)
    (check-not-equal? (send service identities-at 80) (send service identities-at 82))
    (check-equal? (send service reference-ranges-at 80) '((80 . 81)))
    (check-equal? (send service reference-ranges-at 82) '((82 . 83)))
    (define keys (send service identities-at 60))
    (same-members (map Module-Binding-phase+space keys) phases)
    (for ([key (in-list keys)])
      (define index (index-of phases (Module-Binding-phase+space key)))
      (check-equal? (send service definitions (list key)) (list (cons (+ 1 (* index 2)) (+ 2 (* index 2))))))
    (check-equal? (send service references keys) '((60 . 61))))

  (test-case "scoped expansion distinguishes phase-zero and transformer definitions"
    (define text "#lang racket/base\n(require (for-syntax racket/base))\n(define value 1)\n(begin-for-syntax (define value 2) value)\nvalue\n")
    (define-values (_ service _trace) (analyse text))
    (check-equal? (map Module-Binding-phase+space (send service identities-at (at text "\nvalue\n" "value"))) '(0))
    (check-equal? (map Module-Binding-phase+space (send service identities-at (at text "2) value" "value"))) '(1))
    (check-equal? (send service definition-ranges-at (at text "2) value" "value"))
                  (list (span text "define value 2" "value"))))

  (test-case "scoped names in distinct binding spaces keep separate references"
    (define text
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base))\n"
       "(define-syntax (def stx) (syntax-case stx () [(_ id)\n"
       " (with-syntax ([sid ((make-interned-syntax-introducer 'names) #'id 'add)])\n"
       "  #'(begin (define id 1) (define sid 2)))]))\n"
       "(define-syntax (use-name stx) (syntax-case stx ()\n"
       " [(_ id) ((make-interned-syntax-introducer 'names) #'id 'add)]))\n"
       "(def value)\nvalue\n(use-name value)\n"))
    (define-values (_ service _trace) (analyse text))
    (define ordinary (send service identities-at (at text "\nvalue\n" "value")))
    (define spaced (send service identities-at (at text "use-name value" "value")))
    (check-equal? (length ordinary) 1)
    (check-equal? (length spaced) 1)
    (check-not-equal? ordinary spaced)
    (check-equal? (send service references ordinary) (list (span text "\nvalue\n" "value")))
    (check-equal? (send service references spaced) (list (span text "use-name value" "value"))))

  (test-case "precise provider components replace coarse uses and preserve ties"
    (define text (string-append generated "; thing-helper\n"))
    (define whole (span text "\nthing-helper\n" "thing-helper"))
    (define narrow (cons (+ 6 (car whole)) (cdr whole)))
    (define-values (_ service _trace)
      (analyse text
        (lambda (request)
          (define use (name-in request 'thing-helper 'use))
          (define main (name-in request 'thing))
          (hasheq 'names (list (hash-set use 'range narrow)
                              (hash-set* main 'role 'use 'range narrow))))))
    (same-members (map Module-Binding-id (send service identities-at (car narrow))) '(thing thing-helper))
    (check-equal? (send service identities-at (car whole)) '())
    (check-equal? (send service references (send service identities-at (car narrow)))
                  (list (span text "\nthing\n" "thing") narrow)))

  (test-case "declining and empty providers retain generic answers"
    (for ([provider (in-list (list #f (lambda (_) #f) (lambda (_) (hasheq))
                                    (lambda (_) (hasheq 'names '()))))])
      (define-values (_ service _trace) (analyse plain provider))
      (check-equal? (send service definition-ranges-at (at plain "+ value" "value"))
                    (list (span plain "define value" "value")))))

  (test-case "invalid provider results cannot partially install names"
    (for ([bad (in-list (list (hasheq 'names 'bad)
                              (hasheq 'names (list (hasheq 'identifier #'unknown 'range '(0 . 1) 'role 'use)))
                              (hasheq 'names (list (hasheq 'identifier #'unknown 'range '(0 . 1000) 'role 'definition)))) )])
      (define-values (_ service _trace)
        (analyse plain (lambda (request)
                         (if (list? (hash-ref bad 'names))
                             (hash-set bad 'names (cons (hash-set (name-in request 'value) 'range '(0 . 1))
                                                       (hash-ref bad 'names))) bad))))
      (check-equal? (send service identities-at 0) '())
      (check-not-false (member 'value (map (lambda (binding) (hash-ref binding 'name))
                                         (send service get-source-bindings))))
      (check-equal? (send service definition-ranges-at (at plain "+ value" "value"))
                    (list (span plain "define value" "value")))))

  (test-case "certainty belongs to each name even when a confirmed identity is reused"
    (define text (string-append plain "; phantom value\n"))
    (define predicted (span text "phantom"))
    (define repeated (span text "phantom value" "value"))
    (define-values (_ service _trace)
      (analyse text
        (lambda (request)
          (hasheq 'names
                  (list (hasheq 'identifier #'phantom 'role 'definition 'certainty 'predicted 'range predicted)
                        (hash-set* (name-in request 'value) 'range repeated 'certainty 'predicted)
                        (hash-set* (name-in request 'value) 'role 'use 'range predicted 'certainty 'predicted))))))
    (check-equal? (send service identities-at (car predicted)) '())
    (check-equal? (send service identities-at (car repeated)) '())
    (check-equal? (map (lambda (name) (hash-ref name 'certainty)) (send service names-at (car predicted)))
                  '(predicted predicted))
    (define keys (send service identities-at (at text "+ value" "value")))
    (check-equal? (send service definitions keys) (list (span text "define value" "value")))
    (check-equal? (send service references keys) (list (span text "+ value" "value"))))

  (test-case "predicted callbacks cannot prove a local reference or definition"
    (define-values (source trace service) (synthetic))
    (define file (source-file-path source))
    (send trace syncheck:add-arrow/name-dup file 10 11 file 30 31 #f 0 #f (lambda _ #f))
    (send trace walk-stx empty-result)
    (check-equal? (send service identities-at 10) '())
    (check-equal? (send service identities-at 30) '())
    (check-equal? (map (lambda (name) (hash-ref name 'certainty)) (send service names-at 30)) '(predicted))
    (define-values (mixed-source mixed-trace mixed) (synthetic))
    (define mixed-file (source-file-path mixed-source))
    (send mixed-trace syncheck:add-arrow/name-dup mixed-file 20 21 mixed-file 30 31 #f 0 #f (lambda _ #f))
    (send mixed-trace syncheck:add-arrow/name-dup mixed-file 10 11 mixed-file 30 31 #t 0 #f (lambda _ #f))
    (send mixed-trace walk-stx empty-result)
    (same-members (map (lambda (name) (hash-ref name 'certainty)) (send mixed names-at 30))
                  '(confirmed predicted))
    (check-equal? (send mixed definition-ranges-at 30) '((10 . 11)))
    (define-values (jump-source jump-trace jump-service) (synthetic))
    (define jump-file (source-file-path jump-source))
    (send jump-trace syncheck:add-definition-target/phase-level+space jump-file 10 11 'guess '() 0)
    (send jump-trace syncheck:add-jump-to-definition/phase-level+space jump-file 40 41 'guess jump-file '() 0)
    (send jump-trace syncheck:add-arrow/name-dup jump-file 10 11 jump-file 40 41 #f 0 #t (lambda _ #f))
    (send jump-trace walk-stx empty-result)
    (check-equal? (send jump-service identities-at 40) '())
    (check-equal? (send jump-service reference-ranges-at 10) '((40 . 41)))
    (check-equal? (send jump-service references (send jump-service identities-at 10)) '())
    (check-equal? (map (lambda (name) (hash-ref name 'certainty)) (send jump-service names-at 40)) '(predicted)))

  (test-case "an actual arrow settles a use only for the identity it reaches"
    (define (identities definitions uses path binders)
      (for/list ([order '((#f #t) (#t #f))])
        (define-values (source trace service) (synthetic))
        (define file (source-file-path source))
        (for ([definition (in-list definitions)])
          (send trace syncheck:add-definition-target/phase-level+space
                file (car definition) (+ 5 (car definition)) (cdr definition) '() 0))
        (for ([id (in-list uses)])
          (send trace syncheck:add-jump-to-definition/phase-level+space
                file 30 35 id (or path file) '() 0))
        (for ([actual? (in-list order)])
          (define from (if actual? (car binders) (cdr binders)))
          (send trace syncheck:add-arrow/name-dup file from (+ 5 from) file 30 35 actual? 0 #t (lambda _ #f)))
        (send trace walk-stx empty-result)
        (sort (map Module-Binding-id (send service identities-at 30)) symbol<?)))
    (define imported (build-path root "imported.rkt"))
    (check-equal? (identities '((10 . confirmed)) '(confirmed) #f '(10 . 10)) '((confirmed) (confirmed)))
    (check-equal? (identities '((10 . confirmed) (20 . guess)) '(confirmed guess) #f '(10 . 20))
                  '((confirmed) (confirmed)))
    (check-equal? (identities '() '(alpha) imported '(0 . 0)) '((alpha) (alpha)))
    (check-equal? (identities '() '(alpha beta) imported '(0 . 0)) '(() ())))

  (test-case "navigation finds a template occurrence that a rename cannot rely on"
    (define text "#lang racket/base\n(define value 7)\n(define quoted #'value)\n(define (answer) (+ value 1))\n")
    (define-values (_ service _trace) (analyse text))
    (define declaration (span text "define value" "value"))
    (define template (span text "#'value" "value"))
    (define use (span text "+ value" "value"))
    (check-equal? (send service definition-ranges-at (car template)) (list declaration))
    (for ([range (list declaration template use)])
      (check-equal? (send service reference-ranges-at (car range)) (list template use)))
    (check-equal? (send service identities-at (car template)) '())
    (check-equal? (send service references (send service identities-at (car use))) (list use)))

  (test-case "facts and provider calls are shared by repeated queries in both analysis modes"
    (for ([only? '(#f #t)])
      (define calls 0)
      (define-values (_ service trace)
        (analyse plain (lambda (_) (set! calls (add1 calls)) (hasheq)) only?))
      (define facts (send service get-binding-facts))
      (for ([i (in-range 4)])
        (send service definition-ranges-at (at plain "+ value" "value"))
        (send service reference-ranges-at (at plain "+ value" "value"))
        (check-eq? (send service get-binding-facts) facts))
      (send service walk-stx empty-result)
      (check-equal? calls 1)
      (check-equal? (send service definition-ranges-at (at plain "+ value" "value"))
                    (list (span plain "define value" "value")))))

  (test-case "every edit discards old positions and retained source data"
    (for ([replacement '("omega" "longer-value" "")])
      (define-values (doc service _trace) (analyse plain))
      (define r (span plain "define value" "value"))
      (doc-apply-edit! doc (Range (doc-abs-pos->pos doc (car r)) (doc-abs-pos->pos doc (cdr r))) replacement)
      (check-equal? (send service identities-at (at plain "+ value" "value")) '())
      (send service walk-stx empty-result)
      (check-equal? (send service identities-at (at plain "+ value" "value")) '())
      (check-false (send service get-binding-facts))
      (check-equal? (send service get-source-bindings) '()))
    (for ([method '(expand contract reset)])
      (define-values (_ service _trace) (analyse plain))
      (if (eq? method 'reset) (send service reset) (dynamic-send service method 0 1))
      (check-equal? (send service definition-ranges-at (at plain "+ value" "value")) '())))

  (when (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
    (test-case "Rhombus dotted and nested components use the caller's validated provider"
      (define bindings (dynamic-require native-provider 'bindings))
      (define provider (lambda (request) (bindings request #f)))
      (define model "#lang rhombus\nexport: square\nfun square(x): x * x\n")
      (define-values (_model model-service _model-trace) (analyse model provider #t "model.rhm"))
      (define text
        (string-append "#lang rhombus\nimport:\n  \"model.rhm\" as m\n"
                       "namespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    fun deep(x): x + 1\n"
                       "def a = m.square(3)\ndef b = m.square(4)\n"
                       "def c = Outer.Inner.deep(6)\ndef d = Outer.Inner.deep(7)\n"))
      (for ([only? '(#f #t)])
        (define-values (_ service _trace) (analyse text provider only? "client.rhm"))
        (for ([use '("m.square" "Outer.Inner.deep" "Outer.Inner.deep" "Outer.Inner.deep")]
              [component '("m" "Outer" "Inner" "deep")]
              [definition '("as m" "namespace Outer" "namespace Inner" "fun deep")])
          (check-equal? (send service definition-ranges-at (at text use component))
                        (list (span text definition component)))
          (check-true (>= (length (send service reference-ranges-at (at text use component))) 2)))
        (define keys (send service identities-at (at text "m.square" "square")))
        (check-equal? (send model-service definitions keys) (list (span model "fun square" "square")))
        (check-equal? (length (send service references keys)) 2))))
  (delete-directory/files root))
