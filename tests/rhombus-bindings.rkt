#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/file racket/list racket/port racket/runtime-path racket/string
         "../racketdap/adapters/rhombus-debugger.rkt"
         "../racketdap/adapters/rhombus.rkt"
         "../racketdap/language-adapters.rkt"
         "../racketdap/worker/load.rkt"
         (only-in "../racketdap/instrumentation/instrument.rkt" stop-kind stop-site site-line)
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/doclib/binding-facts.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/language-adapter.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/doclib/textbuffer/text-port.rkt")

(define-runtime-path launcher-hook "../vscode/language-adapters.rkt")
(define-runtime-path launcher-loader "../vscode/runtime/racketdap/language-adapters.rkt")
(define launcher-hooks #f)
(define (with-launcher proc)
  (parameterize ([current-language-adapter-resolver (current-language-adapter-resolver)]
                 [current-language-adapter-validator (current-language-adapter-validator)]
                 [current-language-adapter-bindings (current-language-adapter-bindings)])
    (unless launcher-hooks
      (dynamic-require launcher-hook #f)
      (set! launcher-hooks (list (current-language-adapter-resolver)
                                 (current-language-adapter-validator)
                                 (current-language-adapter-bindings))))
    (parameterize ([current-language-adapter-resolver (car launcher-hooks)]
                   [current-language-adapter-validator (cadr launcher-hooks)]
                   [current-language-adapter-bindings (caddr launcher-hooks)])
      (proc))))
(define available?
  (and (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
       (with-handlers ([exn:fail? (lambda (_) #f)])
         (collection-file-path "main.rkt" "rhombus") #t)))
(define model-text "#lang rhombus\nexport: square\nfun square(x): x * x\n")
(define client-text
  (string-append
   "#lang rhombus\nimport:\n  \"model.rhm\"\n  \"model.rhm\" as m\n"
   "namespace Tools:\n  export: scale\n  fun scale(x): x * 2\n"
   "namespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    fun deep(x): x + 1\n"
   "class Point(x, y):\n  method norm(): x + y\n"
   "def p = Point(1, 2)\n"
   "def a = model.square(3)\ndef b = m.square(4)\ndef c = Tools.scale(5)\n"
   "def d = Outer.Inner.deep(6)\ndef e = Outer.Inner.deep(7)\n"
   "def f = List.map([1, 2], fun (x): x + 1)\n"
   "def g = List.map([3, 4], fun (x): x + 1)\n"
   "def h = p.x\ndef i = p.norm()\n"
   "fun dyn(v): v.x\ndef j = [1, 2].length()\n"
   "fun shadow(model, square): model + square\n"))

(define (with-program proc)
  (define root (make-temporary-file "rhombus-bindings~a" 'directory))
  (dynamic-wind void
    (lambda ()
      (display-to-file model-text (build-path root "model.rhm"))
      (proc root))
    (lambda () (delete-directory/files root))))

(define (analyse file text only? [provider #t])
  (define source (path->source file))
  (define doc (make-doc (source-uri source) text))
  (define trace (new build-trace% [source source] [doc-text (doc-copy-text-buffer doc)]
                     [lexer-state (build-lexer-state text (source-uri source))]
                     [contribution-only? only?]))
  (define added '())
  (define result
    (expand-source source (open-input-text text) trace #:contribution-only? only?
      #:bindings-provider
      (and provider
           (lambda (request)
             (define result (if (eq? provider 'empty) (hasheq 'names '()) (bindings request #f)))
             (set! added
                   (for/list ([name (in-list (hash-ref result 'names))])
                     (list (hash-ref name 'range)
                           (identifier-module-binding (hash-ref name 'identifier)
                                                      (hash-ref name 'phase) file)
                           (hash-ref name 'phase))))
             result))))
  (check-true (ExpandResult-all-succeed? result)
              (format "expansion: ~a\n~a\n~a" text (ExpandResult-pre-exn result) (ExpandResult-post-exn result)))
  (send trace walk-stx result)
  (doc-update-trace! doc trace (send trace get-contribution) 0)
  (values doc (remove-duplicates added)))

(define (offset text needle [component needle])
  (define start (caar (regexp-match-positions (regexp (regexp-quote needle)) text)))
  (+ start (- (string-length needle) (string-length component))))
(define (position text offset)
  (define prefix (substring text 0 offset))
  (define lines (string-split prefix "\n" #:trim? #f))
  (Pos (sub1 (length lines)) (string-length (last lines))))
(define (selection text needle [component needle])
  (define start (offset text needle component))
  (Range (position text start) (position text (+ start (string-length component)))))
(define (binding-keys doc text needle [component needle])
  (doc-module-bindings-at doc (position text (offset text needle component))))

(define (check-members root text only?)
  (define file (build-path root "client.rhm"))
  (define-values (doc added) (analyse file text only?))
  (define-values (model _) (analyse (build-path root "model.rhm") model-text only? #f))
  (for ([entry (in-list '(("model.square" "square" "fun square" "square" model)
                         ("m.square" "square" "fun square" "square" model)
                         ("Tools.scale" "scale" "fun scale" "scale" client)
                         ("Outer.Inner.deep" "Outer" "namespace Outer" "Outer" client)
                         ("Outer.Inner.deep" "Inner" "namespace Inner" "Inner" client)
                         ("Outer.Inner.deep" "deep" "fun deep" "deep" client)
                         ("p.x" "x" "class Point(x" "x" client)
                         ("p.norm" "norm" "method norm" "norm" client)))])
    (define path (car entry))
    (define component (cadr entry))
    (define start (+ (offset text path)
                     (caar (regexp-match-positions (regexp (regexp-quote component)) path))))
    (define use-pos (position text start))
    (define use-range (Range use-pos (position text (+ start (string-length component)))))
    (define keys (doc-module-bindings-at doc use-pos))
    (define defining-doc (if (eq? (list-ref entry 4) 'model) model doc))
    (define defining-text (if (eq? (list-ref entry 4) 'model) model-text text))
    (define expected (binding-keys defining-doc defining-text (caddr entry) (cadddr entry)))
    (check-not-equal? keys '() path)
    (for ([key (in-list keys)]) (check-not-false (member key expected) path))
    (check-equal? (doc-occurrence-at doc use-pos) use-range path)
    (check-not-false (doc-definition doc (source-uri (Doc-source doc)) use-pos) path)
    (define references (doc-references doc (source-uri (Doc-source doc)) use-pos #t))
    (check-not-false references path)
    (check-not-false
     (member (Location (source-uri (Doc-source doc)) use-range)
             (Reference-Source-locations (Document-Reference-Result-source references))) path)
    (when (eq? defining-doc doc)
      (define at-definition
        (doc-references doc (source-uri (Doc-source doc))
                        (position text (offset text (caddr entry) (cadddr entry))) #t))
      (check-not-false at-definition path)
      (check-not-false
       (member (Location (source-uri (Doc-source doc)) use-range)
               (Reference-Source-locations (Document-Reference-Result-source at-definition))) path)))
  (check-equal? (binding-keys doc text "model.square" "square")
                (binding-keys doc text "m.square" "square"))
  (define imported (doc-references doc (source-uri (Doc-source doc))
                                   (position text (offset text "m.square" "square")) #f))
  (for ([path '("model.square" "m.square")])
    (check-not-false
     (member (Location (source-uri (Doc-source doc)) (selection text path "square"))
             (Reference-Source-locations (Document-Reference-Result-source imported)))))
  (define map-keys (binding-keys doc text "List.map" "map"))
  (check-not-equal? map-keys '())
  (check-true (andmap (lambda (key) (not (equal? (Module-Binding-filepath key) file))) map-keys))
  (for ([key (in-list map-keys)]) (check-eq? (Module-Binding-id key) 'List.map))
  (check-equal? (doc-occurrence-at doc (position text (offset text "List.map" "map")))
                (selection text "List.map" "map"))
  (define map-result (doc-references doc (source-uri (Doc-source doc))
                                     (position text (offset text "List.map" "map")) #f))
  (check-equal? (length (Reference-Source-locations (Document-Reference-Result-source map-result))) 2)
  (for ([needle '("def f = List.map" "def g = List.map")])
    (check-not-false
     (member (Location (source-uri (Doc-source doc)) (selection text needle "map"))
             (Reference-Source-locations (Document-Reference-Result-source map-result)))))
  (values doc added))

(module+ test
  (unless available?
    (displayln "Skipping Rhombus bindings: set RACKETDAP_TEST_RHOMBUS=1 with Rhombus installed."))

  (test-case "scoped spans preserve phases and exclude quoted data and mismatched names"
    (when available?
      (with-program
       (lambda (root)
         (define forms
           (string-append
            "(define value 1)\n"
            "(define-syntax (member stx)\n"
            " (syntax-case stx () [(_ spelling quoted?)\n"
            "  (let* ([token #'spelling]\n"
            "         [loc (if (string? (syntax-e token))\n"
            "                  (list (syntax-source token) (syntax-line token)\n"
            "                        (add1 (syntax-column token)) (add1 (syntax-position token))\n"
            "                        (- (syntax-span token) 2)) token)])\n"
            "   (with-syntax ([id (datum->syntax #'value\n"
            "                     (if (equal? (syntax-e token) \"Lib.(+)\") '+ 'value) loc)])\n"
            "    (if (syntax-e #'quoted?) #'(quote-syntax id) #'id)))]))\n"
            "(member Lib.value #f)\n(member Quoted.value #t)\n(member Wrong.member #f)\n"
            "(member \"Lib . value\" #f)\n(member \"Lib.(+)\" #f)\n"))
         (define text
           (string-append "#lang racket/base\n(require (for-syntax racket/base) (for-meta 2 racket/base))\n"
                          forms "(begin-for-syntax\n" forms ")\n"))
         (define previous #f)
         (for ([only? '(#f #t)])
           (define-values (doc names) (analyse (build-path root "phases.rkt") text only?))
           (check-equal? (length names) 4)
           (check-equal? (sort (map (lambda (name) (Module-Binding-phase+space (cadr name))) names) <)
                         '(0 0 1 1))
           (for ([name (in-list names)])
             (check-equal? (substring text (caar name) (cdar name)) "value")
             (check-equal? (Module-Binding-id (cadr name)) 'value))
           (when previous (check-equal? (Doc-contribution doc) previous))
           (set! previous (Doc-contribution doc)))))))

  (test-case "dotted bindings resolve in full and contribution-only analysis"
    (when available?
      (with-program
       (lambda (root)
         (define-values (full names) (check-members root client-text #f))
         (define-values (only other-names) (check-members root client-text #t))
         (check-equal? names other-names)
         (check-equal? (Doc-contribution full) (Doc-contribution only))))))

  (test-case "CRLF preserves exact component ranges in both analysis modes"
    (when available?
      (with-program
       (lambda (root)
         (define text (string-replace client-text "\n" "\r\n"))
         (define-values (full names) (check-members root text #f))
         (define-values (only other-names) (check-members root text #t))
         (check-equal? names other-names)
         (check-equal? (Doc-contribution full) (Doc-contribution only))))))

  (test-case "dynamic members, literal receivers and local shadows add no member facts"
    (when available?
      (with-program
       (lambda (root)
         (define previous #f)
         (for ([only? '(#f #t)])
           (define-values (doc names) (analyse (build-path root "client.rhm") client-text only?))
           ;; The static member is a positive control for the same traversal.
           (check-not-false (assoc (cons (offset client-text "m.square" "square")
                                         (+ (offset client-text "m.square" "square") 6)) names))
           (for ([needle '("v.x" "].length" "shadow(model" "model + square")]
                 [component '("x" "length" "model" "square")])
             (define start (offset client-text needle component))
             (check-false (assoc (cons start (+ start (string-length component))) names)))
           (for ([needle '("v.x" "].length")] [component '("x" "length")])
             (check-equal? (binding-keys doc client-text needle component) '()))
           (when previous (check-equal? (Doc-contribution doc) previous))
           (set! previous (Doc-contribution doc)))))))

  (test-case "a selected adapter supplies its bindings provider to analysis"
    (when available?
     (with-launcher
     (lambda ()
      (with-program
       (lambda (root)
         (define file (build-path root "client.rhm"))
         (display-to-file client-text file)
         (for ([only? '(#f #t)])
           (define-values (doc _) (analyse file client-text only? #f))
           ;; Only the provider narrows a dotted path to its written component.
           (for ([path '("Tools.scale" "Outer.Inner")] [part '("scale" "Inner")])
             (check-equal? (doc-occurrence-at doc (position client-text (offset client-text path part)))
                           (selection client-text path part) path)))))))))
  (test-case "Rhombus descriptors add native expressions while preserving source stops"
    (when available?
      (with-program
       (lambda (root)
         (define file (build-path root "debug.rhm"))
         (define text "#lang rhombus\nfun answer(x): x + 1\nprintln(answer(4))\n")
         (display-to-file text file)
         (define defaults (validate-language-profile '(profile)))
         (define selected (resolve-language-adapter file #:text text))
         (check-equal? (car (hash-ref selected 'bindings)) 'expanded+)
         (define reference (cadr (hash-ref selected 'bindings)))
         (check-eq? (dynamic-require (vector-ref reference 0) (vector-ref reference 1)) bindings)
         (check-false (vector-ref reference 2))
         (define debugger (hash-ref selected 'debugger))
         (define expression-ref (cadr (hash-ref debugger 'expressions)))
         (check-eq? (dynamic-require (vector-ref expression-ref 0) (vector-ref expression-ref 1))
                    lower-expression)
         (check-equal? (hash-remove debugger 'expressions)
                       (hash-remove (hash-ref defaults 'debugger) 'expressions))
         (define completion-ref (cadar (hash-ref (hash-ref selected 'editor) 'completion)))
         (check-eq? (dynamic-require (vector-ref completion-ref 0) (vector-ref completion-ref 1))
                    completion)
         (define rename (hash-ref (hash-ref selected 'editor) 'rename))
         (check-equal? (car rename) 'expanded-graph)
         (check-equal? (vector-ref (cadr rename) 1) 'rename)
         (define (shared adapter)
           (define editor (hash-ref adapter 'editor))
           (for/fold ([adapter (hash-set adapter 'editor
                                (hash-set* editor
                                  'declarations (hash-ref (hash-ref defaults 'editor) 'declarations)
                                  'calls (hash-ref (hash-ref defaults 'editor) 'calls)
                                  'completion (hash-ref (hash-ref defaults 'editor) 'completion)
                                  'rename (hash-ref (hash-ref defaults 'editor) 'rename)))])
                     ([key '(match bindings debugger fingerprint)])
             (hash-remove adapter key)))
         (check-equal? (shared selected) (shared defaults))
         (for ([language '(rhombus rhombus/and_meta)]
               [reader '((submod rhombus reader) (submod rhombus/and_meta reader))])
           (define descriptor (resolve-language-adapter file #:language language))
           (check-equal? (hash-ref descriptor 'debugger) debugger)
           (check-equal? (hash-ref descriptor 'bootstrap) (hash-ref defaults 'bootstrap))
           (check-equal? (car (hash-ref descriptor 'bindings)) 'expanded+)
           (check-not-false (member (list 'reader reader)
                                   (hash-ref descriptor 'match))))
         (define (capture instrument? registry)
           (define stops '())
           (define output
             (with-output-to-string
               (lambda ()
                 (parameterize ([current-language-adapter-observer
                                 (lambda (_ descriptor)
                                   (check-equal? (hash-ref descriptor 'debugger)
                                                 (if registry (hash-ref defaults 'debugger) debugger)))])
                   (run-module file #:instrument? instrument? #:workspace root
                               #:language-adapter registry
                               #:on-event (lambda (stop)
                                            (set! stops (cons (list (stop-kind stop)
                                                                    (site-line (stop-site stop)))
                                                              stops))))))))
           (when instrument? (check-not-equal? stops '()))
           (list output (reverse stops)))
         (define empty (build-path root "empty.rktd"))
         (display-to-file "(profile)" empty)
         (for ([instrument? '(#f #t)])
           (check-equal? (capture instrument? #f) (capture instrument? empty)))
         (define-values (_ names) (analyse (build-path root "client.rhm") client-text #t))
         (check-not-equal? names '()))))))

(module+ test
  (test-case "macro pattern dots do not confirm generated member names"
    (when available?
      (with-program
       (lambda (root)
         (define text
           (string-append
            "#lang rhombus/and_meta\ndef value1 = 1\n"
            "expr.macro 'pick ($left . $name)':\n"
            "  let generated = Syntax.make_id(\"value1\", 'value1').relocate(name.srcloc())\n"
            "  '0'.property(Symbol.from_string(\"disappeared-use\"), generated)\n"
            "def v = pick (ignored . value)\n"))
         (for ([only? '(#f #t)])
           (define-values (_ names) (analyse (build-path root "pattern.rhm") text only?))
           (define start (offset text "ignored . value" "value"))
           (check-false (assoc (cons start (+ start 5)) names)))))))

  (test-case "narrowing removes an existing whole-path use of the same identity"
    (when available?
      (with-program
       (lambda (root)
         (define text
           (string-append
            "#lang racket/base\n(require (for-syntax racket/base))\n(define value 1)\n"
            "(define-syntax (member stx) (syntax-case stx () [(_ spelling)\n"
            " (syntax-property (datum->syntax #'value 'value #'spelling) 'original-for-check-syntax #t)]))\n"
            "(member Lib.value)\n"))
         (for ([only? '(#f #t)])
           (define-values (doc _) (analyse (build-path root "narrow.rkt") text only?))
           (define references (doc-references doc (source-uri (Doc-source doc))
                                              (position text (offset text "Lib.value" "value")) #f))
           (check-equal? (filter (lambda (location) (= (Pos-line (Range-start (Location-range location))) 5))
                                 (Reference-Source-locations (Document-Reference-Result-source references)))
                         (list (Location (source-uri (Doc-source doc)) (selection text "Lib.value" "value"))))
           (define uses (Doc-Contribution-references (Doc-contribution doc)))
           (define locations (append* (hash-values uses)))
           (check-not-false (member (Location (source-uri (Doc-source doc)) (selection text "Lib.value" "value")) locations))
           (check-false (member (Location (source-uri (Doc-source doc)) (selection text "Lib.value")) locations)))))))

  (test-case "narrowing retains overlapping sibling identities and their complete ranges"
    (when available?
      (with-program
       (lambda (root)
         (define text
           (string-append
            "#lang racket/base\n(require (for-syntax racket/base))\n(define value 1)\n(define sibling 2)\n"
            "(define-syntax (member stx) (syntax-case stx () [(_ spelling)\n"
            " (with-syntax ([a (syntax-property (datum->syntax #'value 'value #'spelling) 'original-for-check-syntax #t)]\n"
            "               [b (syntax-property (datum->syntax #'sibling 'sibling #'spelling) 'original-for-check-syntax #t)])\n"
            " #'(list a b))]))\n(member Lib.value)\n"))
         (for ([only? '(#f #t)])
           (define-values (generic _) (analyse (build-path root "siblings.rkt") text only? #f))
           (define-values (doc names) (analyse (build-path root "siblings.rkt") text only?))
           (check-equal? (sort (map Module-Binding-id (binding-keys doc text "Lib.value" "value")) symbol<?)
                         '(sibling value))
           (for ([id '(value sibling)])
             (define uses (Doc-Contribution-references (Doc-contribution doc)))
             (define key (for/first ([key (in-hash-keys uses)] #:when (eq? id (Module-Binding-id key))) key))
             (check-equal? (filter (lambda (location) (= (Pos-line (Range-start (Location-range location)))
                                                      (Pos-line (Range-start (selection text "Lib.value")))))
                                 (hash-ref uses key))
                           (list (Location (source-uri (Doc-source doc))
                                           (selection text "Lib.value" (if (eq? id 'value) "value" "Lib.value"))))))
           (define-values (empty other) (analyse (build-path root "siblings.rkt") text only? 'empty))
           (check-equal? (Doc-contribution generic) (Doc-contribution empty)))))))

  (test-case "Unicode and indented line breaks preserve written member ranges"
    (when available?
      (with-program
       (lambda (root)
         (for* ([name '("café")]
                [separator '("." "\n          . " "\r\n          . " "./* comment */")]
                [only? '(#f #t)])
           (define path (string-append "Outils" separator name))
           (define text (format "#lang rhombus\nnamespace Outils:\n  export: ~a\n  fun ~a(x): x * 2\ndef c = ~a(5)\n" name name path))
           (define-values (doc names) (analyse (build-path root "unicode.rhm") text only?))
           (define start (offset text path name))
           (if (string-contains? separator "comment")
               (check-false (assoc (cons start (+ start (string-length name))) names))
               (check-not-false (assoc (cons start (+ start (string-length name))) names))))
         ;; Retained spans can contain marks and digits even when a reader's
         ;; ordinary identifier grammar is narrower.
         (for* ([name '("café" "café٢")] [only? '(#f #t)])
           (define text
             (format "#lang racket/base\n(require (for-syntax racket/base))\n(define ~a 1)\n(define-syntax (member stx) (syntax-case stx () [(_ spelling) (datum->syntax #'~a '~a #'spelling)]))\n(member Outils.~a)\n"
                     name name name name))
           (define-values (_ names) (analyse (build-path root "marks.rkt") text only?))
           (define start (offset text (string-append "Outils." name) name))
           (check-not-false (assoc (cons start (+ start (string-length name))) names)))))))

  (test-case "the launcher fingerprints declared bindings imports without instantiating providers"
    (with-program
     (lambda (root)
       (define helper (build-path root "helper.rkt"))
       (define provider (build-path root "provider.rkt"))
       (define explicit (build-path root "selected.rktd"))
       (display-to-file "#lang racket/base\n(provide answer)\n(define answer 1)\n" helper)
       (display-to-file "#lang racket/base\n(require \"helper.rkt\")\n(provide bindings)\n(error 'provider \"unexpected instantiation\")\n(define (bindings request data) #f)\n" provider)
       (display-to-file "(profile (bindings (expanded+ #((file \"provider.rkt\") bindings #f))))" explicit)
       (parameterize ([current-namespace (make-base-namespace)])
         (define ordinary (resolve-language-adapter (build-path root "client.rkt") #:text "#lang racket/base\n1\n" #:explicit explicit))
         (check-false (assoc helper (hash-ref (hash-ref ordinary 'fingerprint) 'files))))
       (parameterize ([current-namespace (make-base-namespace)])
         (define selected (resolve-language-adapter (build-path root "client.rkt") #:text "#lang racket/base\n1\n"
                                                   #:explicit explicit #:declare-bindings? #t))
         (check-not-false (assoc helper (hash-ref (hash-ref selected 'fingerprint) 'files)))
         (call-with-output-file helper newline #:exists 'append)
         (check-false (language-adapter-current? selected)))))
    (when available?
      (with-launcher
       (lambda ()
         (with-program
          (lambda (root)
            (define observed #f)
            (parameterize ([(dynamic-require launcher-loader 'current-language-adapter-observer)
                            (lambda (_ adapter)
                              (when (pair? (hash-ref adapter 'bindings)) (set! observed adapter)))])
              (define-values (_ names) (analyse (build-path root "client.rhm") client-text #t #f))
              (check-not-false
               (for/or ([entry (in-list (hash-ref (hash-ref observed 'fingerprint) 'files))])
                 (regexp-match? #rx"syntax/kerncase[.]rkt$" (path->string (car entry))))))))))))

  (test-case "an optional adapter bindings decline preserves generic analysis"
    (with-launcher
     (lambda ()
       (with-program
        (lambda (root)
          (define provider (build-path root "decline.rkt"))
          (display-to-file "#lang racket/base\n(provide bindings)\n(define (bindings request data) #f)\n" provider)
          (define text "#lang racket/base\n(define value 1)\nvalue\n")
          (for ([only? '(#f #t)])
            (define-values (generic _) (analyse (build-path root "client.rkt") text only? #f))
            (parameterize ([current-language-adapter-resolver
                            (lambda args
                              (validate-language-profile
                               `(profile (bindings (expanded+ #((file ,(path->string provider)) bindings #f))))))])
              (define-values (doc names) (analyse (build-path root "client.rkt") text only? #f))
              (check-equal? (Doc-contribution doc) (Doc-contribution generic)))))))))

  (test-case "provide selectors retain label and numeric phases"
    (when available?
      (with-program
       (lambda (root)
         (display-to-file "#lang racket/base\n(provide value)\n(define value 1)\n" (build-path root "label.rkt"))
         (for* ([kind '(for-syntax for-label)] [only? '(#f #t)])
           (define text
             (string-append
              "#lang racket/base\n(require (for-syntax racket/base))\n"
              (if (eq? kind 'for-syntax) "(begin-for-syntax (define value 1))\n" "(require (for-label \"label.rkt\"))\n")
              "(define-syntax (export stx) (syntax-case stx () [(_ spelling)\n"
              (format " #`(provide (~a #,(syntax-property (datum->syntax #'value 'value #'spelling) 'original-for-check-syntax #t)))]))\n" kind)
              "(export Lib.value)\n"))
           (define-values (doc names) (analyse (build-path root "provide.rkt") text only?))
           (define name (assoc (cons (offset text "Lib.value" "value") (+ (offset text "Lib.value" "value") 5)) names))
           (check-not-false name)
           (when name (check-equal? (caddr name) (if (eq? kind 'for-label) #f 1)))))))))
