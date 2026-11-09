#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/list racket/port racket/runtime-path racket/string syntax/modread
         (prefix-in native: "../racketdap/adapters/rhombus.rkt")
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer/state.rkt"
         (prefix-in client: "../vendor/collects/racket-langserver/tests/client.rkt")
         (only-in "../vendor/collects/racket-langserver/doclib/service/hover/detail.rkt" collect-rhombus-candidates bounding-range)
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/common/json-util.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/language-adapter.rkt")

(define-runtime-path launcher "../vscode/language-adapters.rkt")
(define-runtime-path transport "../vendor/collects/racket-langserver/lsp/text-document.rkt")
(define available?
  (and (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
       (with-handlers ([exn:fail? (lambda (_) #f)])
         (collection-file-path "main.rkt" "rhombus") #t)))
(define text
  (string-append
   "#lang rhombus/and_meta\n"
   "def answer :: Int = 42\n"
   "fun sum(x :: Int, y :: Int) :: Int:\n  def local = x\n  local + y\n"
   "namespace Tools:\n  export: scale\n  fun scale(x :: Int, ~factor: factor = 2) :: Int: x * factor\n"
   "class Point(x, y):\n  field z = 0\n  method norm() :: Int: x + y\n"
   "operator (x +++ y): x + y\n"
   "expr.macro 'hello $x': '$x'\n"
   "sum(1, 2)\nTools.scale(3, ~factor: 4)\nanswer\n"
   "error(\"runtime body must not run\")\n"))
(define docs (make-hash))
(define (analyse [source-text text])
  (hash-ref! docs source-text
    (lambda ()
      (dynamic-require launcher #f)
      (define doc (make-doc "file:///tmp/rhombus-outline.rhm" source-text))
      (doc-expand! doc)
      doc)))
(define (at doc needle [delta 0])
  (doc-abs-pos->pos doc
    (+ delta (caar (regexp-match-positions (regexp (regexp-quote needle)) (doc-get-text doc))))))
(define (all xs)
  (append-map (lambda (x) (cons x (all (DocumentSymbol-children x)))) xs))
(define (named doc name)
  (findf (lambda (x) (equal? name (DocumentSymbol-name x))) (all (doc-symbols-hierarchical doc))))
(define (help doc needle delta)
  (->jsexpr (doc-signature-help doc (at doc needle delta))))

(module+ test
  (unless available?
    (displayln "Skipping Rhombus outline: set RACKETDAP_TEST_RHOMBUS=1 with Rhombus installed."))

  (test-case "declaration kinds and nested blocks"
    (when available?
      (define doc (analyse))
      (check-true (doc-trace-latest? doc))
      (for ([name '("answer" "sum" "Tools" "Point" "z" "norm" "+++" "hello")]
            [kind (list SymbolKind-Variable SymbolKind-Function SymbolKind-Namespace SymbolKind-Class
                        SymbolKind-Field SymbolKind-Method SymbolKind-Operator SymbolKind-Function)])
        (define found (named doc name))
        (check-not-false found name)
        (when found (check-equal? (DocumentSymbol-kind found) kind name)))
      (check-equal? (map DocumentSymbol-name (DocumentSymbol-children (named doc "sum"))) '("local"))
      (check-equal? (map DocumentSymbol-name (DocumentSymbol-children (named doc "Tools"))) '("scale"))
      (check-equal? (map DocumentSymbol-name (DocumentSymbol-children (named doc "Point"))) '("x" "y" "z" "norm"))))

  (test-case "hierarchical and flat transport outlines agree"
    (when available?
      (define doc (analyse))
      (define result (dynamic-require transport 'document-symbol-result (lambda () #f)))
      (check-not-false result)
      (when result
        (define flat (result doc (Doc-uri doc) #f))
        (define tree (all (result doc (Doc-uri doc) #t)))
        (check-equal? (map SymbolInformation-name flat) (map DocumentSymbol-name tree))
        (check-equal? (map SymbolInformation-kind flat) (map DocumentSymbol-kind tree))
        (check-equal? (map (lambda (s) (Location-range (SymbolInformation-location s))) flat)
                      (map DocumentSymbol-selectionRange tree)))))

  (test-case "source signature for a direct call"
    (when available?
      (define result (help (analyse) "sum(1, 2)" 7))
      (check-not-false result)
      (when result
        (check-equal? (hash-ref result 'activeParameter) 1)
        (check-equal? (hash-ref (car (hash-ref result 'signatures)) 'label)
                      "sum(x :: Int, y :: Int) :: Int"))
      (define overloaded (analyse "#lang rhombus\nfun\n| choose(x): x\n| choose(x, y) :~ Int: x + y\nchoose(1, 2)\n"))
      (define overload (help overloaded "choose(1, 2)" 10))
      (check-not-false overload)
      (when overload
        (check-equal? (hash-ref overload 'activeSignature) 1)
        (check-equal? (map (lambda (s) (hash-ref s 'label)) (hash-ref overload 'signatures))
                      '("choose(x)" "choose(x, y) :~ Int")))))

  (test-case "source signature for a dotted call"
    (when available?
      (define result (help (analyse) "Tools.scale(3," 13))
      (check-not-false result)
      (when result
        (check-true (string-prefix? (hash-ref (car (hash-ref result 'signatures)) 'label) "scale(")))
      (define dotted (analyse "#lang rhombus\nnamespace Maths:\n  def seed = 0\nfun Maths.bump(x) :~ Int: x + 1\nMaths.bump(2)\n"))
      (define signature (help dotted "Maths.bump(2)" 12))
      (check-not-false signature)
      (when signature
        (check-equal? (hash-ref (car (hash-ref signature 'signatures)) 'label) "Maths.bump(x) :~ Int"))
      (check-not-false (named dotted "Maths.bump"))))

  (test-case "keyword arguments select the declared parameter"
    (when available?
      (define doc (analyse (string-append text "Tools.scale(~factor: 4, 3)\n")))
      (define result (help doc "Tools.scale(~factor: 4" 21))
      (check-not-false result)
      (when result
        (check-equal? (hash-ref result 'activeParameter) 1)
        (check-equal? (map (lambda (p) (hash-ref p 'label))
                          (hash-ref (car (hash-ref result 'signatures)) 'parameters))
                      '("x :: Int" "~factor: factor = 2")))
      (define positional (help doc "Tools.scale(~factor: 4, 3)" 24))
      (check-not-false positional)
      (when positional (check-equal? (hash-ref positional 'activeParameter) 0))))

  (test-case "source hover on a direct name carries declared annotations"
    (when available?
      (define doc (analyse))
      (define hover (doc-hover doc (at doc "sum(1" 1)))
      (check-not-false hover)
      (when hover
        (check-true (string-contains? (Hover-contents hover) "**Type**"))
        (check-true (string-contains? (Hover-contents hover) "sum(x :: Int, y :: Int) :: Int"))
        (check-equal? (Hover-range hover) (Range (at doc "sum(1") (at doc "sum(1" 3))))))

  (test-case "source hover on a dotted component"
    (when available?
      (define doc (analyse))
      (define hover (doc-hover doc (at doc "Tools.scale(3" 8)))
      (check-not-false hover)
      (when hover
        (check-true (string-contains? (Hover-contents hover) "**Type**"))
        (check-true (string-contains? (Hover-contents hover) "scale(x :: Int, ~factor: factor = 2) :: Int"))
        (check-equal? (Hover-range hover) (Range (at doc "Tools.scale(3" 6) (at doc "Tools.scale(3" 11))))))

  (test-case "selection and full ranges are exact with LF and CRLF"
    (when available?
      (for ([source-text (list text (string-replace text "\n" "\r\n"))])
        (define doc (analyse source-text))
        (define found (named doc "sum"))
        (check-not-false found)
        (when found
          (check-equal? (DocumentSymbol-selectionRange found) (Range (at doc "fun sum" 4) (at doc "fun sum" 7)))
          (check-equal? (DocumentSymbol-range found) (Range (at doc "fun sum") (at doc "local + y" 9)))))))

  (test-case "a broken buffer with readable shrubbery retains its outline"
    (when available?
      (define broken "#lang rhombus\nfun broken(x):\n  def retained = missing\n  x +\n")
      (define doc (analyse broken))
      (check-equal? (map DocumentSymbol-name (all (doc-symbols-hierarchical doc))) '("broken" "retained"))
      (define edited (make-doc "file:///tmp/rhombus-edited.rhm" text))
      (check-true (doc-expand! edited))
      (doc-apply-edit! edited (Range (Pos 0 0) (doc-abs-pos->pos edited (doc-end-abs-pos edited))) broken)
      (doc-update-version! edited 1)
      (check-false (doc-expand! edited))
      (check-equal? (map DocumentSymbol-name (all (doc-symbols-hierarchical edited))) '("broken" "retained"))))

  (test-case "declaration kinds reach semantic tokens at definitions and uses"
    (when available?
      (define doc (analyse))
      (for ([needle '("class Point" "method norm" "Tools.scale(3" "field z" "namespace Tools" "x +++ y" "'hello" "def answer")]
            [delta '(6 7 6 6 10 2 1 4)]
            [kind '("class" "method" "function" "property" "namespace" "operator" "macro" "variable")])
        (define pos (doc-pos->abs-pos doc (at doc needle delta)))
        (define tokens (doc-range-tokens doc (Range (doc-abs-pos->pos doc pos) (doc-abs-pos->pos doc (add1 pos)))))
        (check-true (ormap (lambda (t) (equal? (->jsexpr (SemanticToken-type t)) kind)) tokens) needle))))

  (test-case "another language keeps its existing outline and signatures"
    (when available?
      (define code "#lang racket/base\n(define (plain x) x)\n(plain 1)\n")
      (define generic (parameterize ([current-language-adapter-resolver #f]) (analyse code)))
      (check-equal? (map DocumentSymbol-name (doc-symbols-hierarchical generic)) '("plain"))
      (check-false (doc-signature-help generic (at generic "(plain 1)" 8)))))

  (test-case "nested calls and non-call parentheses select only the native callee"
    (when available?
      (define doc (analyse (string-append text "sum(Tools.scale(1), 2)\n")))
      (define result (help doc "sum(Tools.scale(1), 2)" 20))
      (check-not-false result)
      (when result
        (check-equal? (hash-ref result 'activeParameter) 1)
        (check-true (string-prefix? (hash-ref (car (hash-ref result 'signatures)) 'label) "sum(")))
      (define trailing (analyse (string-append text "sum(1, )\n")))
      (define active (help trailing "sum(1, )" 7))
      (check-not-false active)
      (when active (check-equal? (hash-ref active 'activeParameter) 1))))

  (test-case "binding metadata contributes declarations from user-defined forms"
    (when available?
      (define doc
        (analyse
         (string-append "#lang rhombus/and_meta\n"
                        "decl.macro 'named $id': 'def $id = 1'\n"
                        "named made\n")))
      (check-not-false (named doc "made"))
      (check-equal? (count (lambda (d) (equal? (DocumentSymbol-name d) "made"))
                           (all (doc-symbols-hierarchical doc))) 1)
      (check-equal? (DocumentSymbol-range (named doc "made")) (Range (at doc "named made") (at doc "named made" 10)))
      (check-false (named doc "id")))))

(module+ test
  (test-case "binding prefixes, keyword fields and clause modifiers select actual names"
    (when available?
      (define doc (analyse "#lang rhombus\ndef mutable value = 1\nclass C(mutable x, ~y):\n  private method hidden(a): a\n"))
      (check-true (doc-trace-latest? doc))
      (check-equal? (map DocumentSymbol-name (all (doc-symbols-hierarchical doc)))
                    '("value" "C" "x" "y" "hidden"))
      (for ([name '("value" "x" "y" "hidden")]
            [kind (list SymbolKind-Variable SymbolKind-Field SymbolKind-Field SymbolKind-Method)]
            [needle '("mutable value" "mutable x" "~y" "method hidden")]
            [offset '(8 8 1 7)])
        (define symbol (named doc name))
        (check-equal? (DocumentSymbol-kind symbol) kind)
        (check-equal? (DocumentSymbol-selectionRange symbol)
                      (Range (at doc needle offset) (at doc needle (+ offset (string-length name))))))))

  (test-case "metadata excludes ordinary anonymous function parameters"
    (when available?
      (define doc (analyse "#lang rhombus\n[1, 2].map(fun (x): x + 1)\n"))
      (check-true (doc-trace-latest? doc))
      (check-equal? (doc-symbols-hierarchical doc) '())))

  (test-case "parenthesised initialisers retain executable declarations only"
    (when available?
      (define doc (analyse "#lang rhombus/and_meta\ndef value = (block:\n               def child = 1\n               child)\ndef callable = (fun (arg):\n                  def local = arg\n                  local)\ndef quoted = 'def phantom = 1'\n"))
      (check-true (doc-trace-latest? doc))
      (check-equal? (map DocumentSymbol-name (DocumentSymbol-children (named doc "value"))) '("child"))
      (check-equal? (map DocumentSymbol-name (DocumentSymbol-children (named doc "callable"))) '("local"))
      (check-false (named doc "arg"))
      (check-false (named doc "phantom"))))

  (test-case "keyword compatibility selects overloads and shorthand formal indices"
    (when available?
      (define doc (analyse "#lang rhombus\nfun\n| choose(x, ~one: y): x + y\n| choose(x, ~two: z): x + z\nfun f(~x, y): x + y\nchoose(1, ~two: 2)\nf(2, ~x: 1)\n"))
      (check-true (doc-trace-latest? doc))
      (define chosen (help doc "choose(1, ~two: 2)" 16))
      (check-not-false chosen)
      (check-equal? (hash-ref chosen 'activeSignature) 1)
      (check-equal? (hash-ref chosen 'activeParameter) 1)
      (check-equal? (hash-ref (help doc "f(2, ~x: 1)" 9) 'activeParameter) 0)))

  (test-case "overload selection requires every required keyword"
    (when available?
      (define doc (analyse "#lang rhombus\nfun\n| choose(x, ~one: a, ~two: b): x + a + b\n| choose(x, ~two: b): x + b\nchoose(1, ~two: 3)\n"))
      (check-true (doc-trace-latest? doc))
      (define result (help doc "choose(1, ~two: 3)" 16))
      (check-not-false result)
      (check-equal? (list (hash-ref result 'activeSignature)
                          (hash-ref result 'activeParameter))
                    '(1 1))))

  (test-case "destructuring initialisers contribute nested declarations once"
    (when available?
      (define doc (analyse "#lang rhombus\ndef [a, b] = (block:\n                def child = 1\n                [child, child])\n"))
      (check-true (doc-trace-latest? doc))
      (check-equal? (sort (map DocumentSymbol-name (all (doc-symbols-hierarchical doc))) string<?)
                    '("a" "b" "child"))))

  (test-case "rest arguments map to the rest formal"
    (when available?
      (define doc (analyse "#lang rhombus\nfun f(x, & more): x\nf(1, 2, 3)\n"))
      (define result (help doc "f(1, 2, 3)" 9))
      (check-not-false result)
      (check-equal? (hash-ref result 'activeParameter) 1)))

  (test-case "an unresolved inner call suppresses the outer signature"
    (when available?
      (define doc (analyse "#lang rhombus\nfun f(x, y): x + y\nfun g(h): f(h(1), 2)\n"))
      (check-true (doc-trace-latest? doc))
      (check-false (help doc "f(h(1), 2)" 5))))

  (test-case "analysis retains immutable provider records without reader syntax"
    (when available?
      (define (contains-syntax? v)
        (cond [(syntax? v) #t]
              [(pair? v) (or (contains-syntax? (car v)) (contains-syntax? (cdr v)))]
              [(hash? v) (for/or ([(k x) (in-hash v)]) (or (contains-syntax? k) (contains-syntax? x)))]
              [(vector? v) (ormap contains-syntax? (vector->list v))]
              [else #f]))
      (define (immutable-record? v)
        (cond [(hash? v) (and (immutable? v)
                             (for/and ([(k x) (in-hash v)])
                               (and (immutable-record? k) (immutable-record? x))))]
              [(pair? v) (and (immutable-record? (car v)) (immutable-record? (cdr v)))]
              [(string? v) (immutable? v)]
              [else (or (not v) (symbol? v) (keyword? v) (number? v) (boolean? v) (null? v))]))
      (for* ([code (list text "#lang racket/base\n(define plain 1)\n")]
             [contribution-only? '(#f #t)])
        (define doc (make-doc "file:///tmp/native-lifetime.rhm" code))
        (define trace (CSResult-trace (doc-check-syntax doc #:contribution-only? contribution-only?)))
        (define state (send trace get-lexer-state))
        (check-false (contains-syntax? (struct->vector state)))
        (define fields (vector->list (struct->vector state)))
        (check-true (immutable-record? (list-ref fields 5)))
        (when (or contribution-only? (string-prefix? code "#lang racket/base"))
          (check-equal? (list-ref fields 5) #f))
        (for ([mutate (list (lambda (t) (send t reset))
                            (lambda (t) (send t text-replaced 0 1))
                            (lambda (t) (send t expand 0 1))
                            (lambda (t) (send t contract 0 1)))])
          (define fresh-trace
            (CSResult-trace (doc-check-syntax doc #:contribution-only? contribution-only?)))
          (define fresh-state (send fresh-trace get-lexer-state))
          (when (and (not contribution-only?) (equal? code text))
            (check-true (hash? (vector-ref (struct->vector fresh-state) 5))))
          (mutate fresh-trace)
          (check-false (contains-syntax? (struct->vector fresh-state)))
          (check-equal? (vector-ref (struct->vector fresh-state) 5) #f)))))

  (test-case "declaration extraction scales across two sizes and is cached per analysis"
    (when available?
      (define (sample n)
        (define code (string-append "#lang rhombus\n"
                       (apply string-append (for/list ([i (in-range n)]) (if (even? i) (format "def x~a = 1\n" i) (format "named x~a\n" i))))))
        (define in (open-input-string code))
        (port-count-lines! in)
        (define pre (with-module-reading-parameterization (lambda () (read-syntax 'scaling in))))
        (define bindings
          (for/list ([r (in-list (regexp-match-positions* #px"x[0-9]+" code))])
            (hasheq 'range r 'kind 'variable 'declaration? #t)))
        (define request
          (hasheq 'text code 'pre pre 'facts (hasheq 'bindings bindings) 'cancelled? (lambda () #f)
                  'hooks (hasheq 'source-range
                                 (lambda (s)
                                   (define-values (rs _) (collect-rhombus-candidates s 'scaling (string-length code) 0))
                                   (bounding-range rs)))))
        (for/fold ([best +inf.0]) ([i (in-range 3)])
          (collect-garbage)
          (define start (current-process-milliseconds))
          (define ds (native:declarations request #f))
          (define elapsed (- (current-process-milliseconds) start))
          (check-equal? (length ds) n)
          (min best elapsed)))
      (define small (sample 1600))
      (define large (sample 6400))
      (printf "Declaration scaling, 1600/6400: ~a/~a ms\n" small large)
      (check-true (< large (* 9 (max 1 small))))
      (define declarations-provider (current-language-adapter-declarations))
      (define calls-provider (current-language-adapter-calls))
      (define counts (make-hasheq))
      (define (counted selector key)
        (lambda (adapter)
          (define provider (selector adapter))
          (and provider (lambda (request)
                          (when (hash-ref request 'pre #f) (hash-update! counts key add1 0))
                          (provider request)))))
      (parameterize ([current-language-adapter-declarations (counted declarations-provider 'declarations)]
                     [current-language-adapter-calls (counted calls-provider 'calls)])
        (define doc (make-doc "file:///tmp/native-cache.rhm" text))
        (check-true (doc-expand! doc))
        (define initial (hash-copy counts))
        (check-equal? (hash-ref initial 'declarations 0) 1)
        (check-equal? (hash-ref initial 'calls 0) 1)
        (for ([i (in-range 3)])
          (doc-symbols-hierarchical doc)
          (doc-hover doc (at doc "sum(1" 1))
          (help doc "sum(1, 2)" 7)
          (doc-range-tokens doc (Range (Pos 0 0) (doc-abs-pos->pos doc (doc-end-abs-pos doc)))))
        (check-equal? counts initial)
        (doc-apply-edit! doc (Range (Pos 0 0) (doc-abs-pos->pos doc (doc-end-abs-pos doc)))
                         "#lang rhombus\ndef replacement = 1\n")
        (doc-update-version! doc 1)
        (check-false (named doc "sum"))
        (check-true (doc-expand! doc))
        (check-equal? (map DocumentSymbol-name (doc-symbols-hierarchical doc)) '("replacement"))
        (check-equal? (hash-ref counts 'declarations) 2)
        (check-equal? (hash-ref counts 'calls) 2))))

  (test-case "loading native tooling preserves generic signature triggers"
    (when available?
      (dynamic-require launcher #f)
      (client:with-racket-lsp
       (lambda (session)
         (define request (client:make-request session "initialize"
                            (hasheq 'processId 1 'capabilities (hasheq) 'rootUri "file:///tmp/" 'rootPath "/tmp")))
         (client:client-send session request)
         (define id (client:client-wait-response request))
         (check-equal? (hash-ref (hash-ref (hash-ref (hash-ref id 'result) 'capabilities)
                                         'signatureHelpProvider) 'triggerCharacters)
                       '(" " ")" "]")))))))
