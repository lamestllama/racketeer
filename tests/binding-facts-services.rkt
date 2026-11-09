#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/list racket/string racket/runtime-path syntax/modread
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/autocomplete.rkt"
         "../vendor/collects/racket-langserver/doclib/binding-facts.rkt"
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt")

(define-runtime-path binding-macro "fixtures/binding-services-macro.rkt")

(define source (path->source (build-path (find-system-path 'temp-dir) "binding-services.rkt")))
(define prefix
  (string-append
   "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
   "(define-syntax (def stx)\n (syntax-case stx () [(_ name rhs)\n"
   "  (with-syntax ([name (datum->syntax #'name (syntax-e #'name) #'name)]\n"
   "                [helper (format-id #'name \"~a-helper\" #'name #:source #'name)])\n"
   "   #'(begin (define name rhs) (define helper 0) (define internal 9)))]))\n"
   "(define-syntax (bind stx)\n (syntax-case stx () [(_ name rhs body ...)\n"
   "  (with-syntax ([name (datum->syntax #'name (syntax-e #'name) #'name)])\n"
   "   #'(let () (let ([name rhs]) body ...)))]))\n"))

(define (analyse text [provider #f] [facts? #t] [only? #f] [service-box #f])
  (define doc (make-doc (source-uri source) text))
  (define trace-class
    (if facts? build-trace%
        (class build-trace% (super-new)
          (define/override (add-binding-facts facts) (void)))))
  (define trace (new trace-class [source source] [doc-text (doc-copy-text-buffer doc)]
                     [lexer-state (build-lexer-state text (source-uri source))]
                     [contribution-only? only?]))
  (when service-box (set-box! service-box (send trace get-declaration)))
  (define result
    (if provider
        (expand-source source (open-input-string text) trace #:bindings-provider provider #:contribution-only? only?)
        (expand-source source (open-input-string text) trace #:contribution-only? only?)))
  (check-true (ExpandResult-all-succeed? result))
  (send trace walk-stx result)
  (doc-update-trace! doc trace (send trace get-contribution) 0)
  doc)
(define (at doc needle [offset 0])
  (doc-abs-pos->pos doc (+ offset (caar (regexp-match-positions
                                      (regexp (regexp-quote needle)) (doc-get-text doc))))))
(define (labels doc pos)
  (map CompletionItem-label (CompletionList-items (doc-completion doc pos))))
(define (symbols doc)
  (define (flatten xs)
    (append-map (lambda (x) (cons x (flatten (DocumentSymbol-children x)))) xs))
  (flatten (doc-symbols-hierarchical doc)))
(define (named doc name)
  (filter (lambda (x) (equal? name (DocumentSymbol-name x))) (symbols doc)))
(define (token-at doc pos)
  (define absolute (doc-pos->abs-pos doc pos))
  (for/first ([token (in-list (doc-range-tokens doc (Range (Pos 0 0) (doc-abs-pos->pos doc (doc-end-abs-pos doc)))))]
              #:when (<= (SemanticToken-start token) absolute (sub1 (SemanticToken-end token))))
    token))

(module+ test
  (test-case "a rebuilt definition is completed once and has its authored extent"
    (define doc (analyse (string-append prefix "(def square (lambda (x) (* x x)))\nsquare\n")))
    (check-equal? (count (lambda (s) (equal? s "square")) (labels doc (at doc "\nsquare" 1))) 1)
    (define found (named doc "square"))
    (check-equal? (length found) 1)
    (when (pair? found)
      (check-equal? (DocumentSymbol-kind (car found)) SymbolKind-Function)
      (check-equal? (DocumentSymbol-selectionRange (car found))
                    (Range (at doc "square (lambda") (at doc "square (lambda" 6)))
      (check-equal? (DocumentSymbol-range (car found))
                    (Range (at doc "(def square") (at doc "\nsquare")))))

  (test-case "a binding macro contributes a local declaration and visible completion"
    (define text (string-append prefix "(require racket/match)\n"
                               "(bind local 1 (let ([ordinary 2]) (+ local ordinary)))\n"
                               "(bind second 1 (match-define (list incidental) '(2)) (+ second incidental))\n(void)\n"))
    (define doc (analyse text))
    (check-not-false (member "local" (labels doc (at doc "(+ local" 7))))
    (check-equal? (length (named doc "local")) 1)
    (check-equal? (named (analyse text #f #f) "local") '())
    (check-equal? (named doc "ordinary") '())
    (check-equal? (named doc "incidental") '())
    (check-false (and (member "local" (labels doc (at doc "(void)" 1))) #t)))

  (test-case "an internal define-syntax-rule contributes a local declaration"
    (define doc
      (analyse (string-append "#lang racket/base\n"
                 "(let () (define-syntax-rule (bind n) (let ([n 1]) n))\n"
                 " (bind mine))\n(void)\n")))
    (define found (named doc "mine"))
    (check-equal? (length found) 1)
    (when (pair? found)
      (check-equal? (DocumentSymbol-selectionRange (car found))
                    (Range (at doc "mine") (at doc "mine" 4))))
    (check-not-false (member "mine" (labels doc (at doc "mine"))))
    (check-false (member "mine" (labels doc (at doc "(void)")))))

  (test-case "a let-syntax binding macro contributes a local declaration"
    (define doc
      (analyse (string-append "#lang racket/base\n(require (for-syntax racket/base))\n"
                 "(let-syntax ([bind (syntax-rules () [(_ n) (let ([n 1]) n)])])\n"
                 " (bind mine))\n(void)\n")))
    (define found (named doc "mine"))
    (check-equal? (length found) 1)
    (when (pair? found)
      (check-equal? (DocumentSymbol-selectionRange (car found))
                    (Range (at doc "mine") (at doc "mine" 4))))
    (check-not-false (member "mine" (labels doc (at doc "mine"))))
    (check-false (member "mine" (labels doc (at doc "(void)")))))

  (test-case "nested macro binding collection scales with expansion size"
    (define (elapsed size)
      (define text
        (string-append
          "#lang racket/base\n(require (for-syntax racket/base))\n"
          "(define-syntax (nest stx)\n"
          " (syntax-case stx () [(_ name ...)\n"
          "  (for/fold ([body #'0]) ([name (in-list (reverse (syntax->list #'(name ...))))])\n"
          "   #`(let ([#,name 1]) #,body))]))\n(nest "
          (string-join (for/list ([i (in-range size)]) (format "local~a" i)) " ")
          ")\n"))
      (parameterize ([current-namespace (make-base-namespace)])
        (define pre
          (with-module-reading-parameterization
            (lambda () (read-syntax (source-syntax-source source) (open-input-string text)))))
        (define expanded (expand pre))
        (apply min
          (for/list ([trial (in-range 3)])
            (collect-garbage)
            (define start (current-inexact-milliseconds))
            (define facts (collect-binding-facts source expanded text pre))
            (define duration (- (current-inexact-milliseconds) start))
            (check-equal? (count (lambda (binder)
                                  (and (eq? (hash-ref binder 'role) 'let-values)
                                       (hash-ref binder 'declaration?)))
                                (hash-ref facts 'binders)) size)
            duration))))
    (define small (elapsed 200))
    (define large (elapsed 800))
    (printf "nested binding timings: 200 = ~a ms; 800 = ~a ms\n" small large)
    (check-true (< large (* 8 small))))

  (test-case "an imported binding macro contributes a local declaration and visible completion"
    (define text
      (format "#lang racket/base\n(require (file ~s))\n(bind imported 1 (+ imported 2))\n(void)\n"
              (path->string binding-macro)))
    (define doc (analyse text))
    (check-not-false (member "imported" (labels doc (at doc "(+ imported" 7))))
    (check-equal? (length (named doc "imported")) 1)
    (check-equal? (named (analyse text #f #f) "imported") '())
    (check-false (member "imported" (labels doc (at doc "(void)")))))

  (test-case "generated helpers sharing a written anchor stay out of authored services"
    (define doc (analyse (string-append prefix "(def public 1)\npublic-helper\n")))
    (check-not-false (member "public" (labels doc (at doc "\npublic-helper" 1))))
    (check-false (and (member "public-helper" (labels doc (at doc "\npublic-helper" 1))) #t))
    (check-equal? (map DocumentSymbol-name (filter (lambda (s) (equal? (DocumentSymbol-selectionRange s)
                                                      (Range (at doc "public 1") (at doc "public 1" 6))))
                                                (symbols doc))) '("public"))
    (check-equal? (named doc "public-helper") '())
    (check-equal? (named doc "internal") '()))

  (test-case "predictions cannot supply a declaration, completion or semantic kind"
    (define text (string-append prefix "(def confirmed 1)\n(void 'phantom 'confirmed)\n"))
    (define doc
      (analyse text
        (lambda (request)
          (define start (caar (regexp-match-positions #rx"phantom" text)))
          (define confirmed
            (for/first ([name (in-list (hash-ref (hash-ref request 'facts) 'names))]
                        #:when (and (eq? (hash-ref name 'role) 'definition)
                                    (eq? (syntax-e (hash-ref name 'identifier)) 'confirmed)))
              (hash-ref name 'identifier)))
          (define quoted (add1 (caar (regexp-match-positions #rx"'confirmed" text))))
          (hasheq 'names (list (hasheq 'identifier confirmed 'role 'definition
                                      'certainty 'predicted 'range (cons quoted (+ quoted 9)))
                              (hasheq 'identifier #'phantom 'role 'definition
                                      'certainty 'predicted 'range (cons start (+ start 7))))))))
    (check-equal? (length (named doc "confirmed")) 1)
    (check-equal? (named doc "phantom") '())
    (check-false (member "phantom" (labels doc (at doc "phantom"))))
    (check-false (token-at doc (at doc "phantom")))
    (check-false (token-at doc (at doc "confirmed)"))))

  (test-case "confirmed core callable kinds reach declarations and non-call uses"
    (define doc (analyse (string-append prefix "(def callable (case-lambda [(x) x]))\n(list callable)\n")))
    (for ([pos (in-list (list (at doc "callable (case") (at doc "callable)")))])
      (define token (token-at doc pos))
      (check-not-false token)
      (when token (check-equal? (SemanticToken-type token) SemanticTokenType-function)))
    (check-equal? (map DocumentSymbol-kind (named doc "callable")) (list SymbolKind-Function)))

  (test-case "a lambda spelling bound to an ordinary procedure proves no callable kind"
    (define doc (analyse (string-append prefix "(let ([lambda list]) (def value (lambda 1)) value)\n")))
    (check-equal? (map DocumentSymbol-kind (named doc "value")) (list SymbolKind-Variable))
    (define token (token-at doc (at doc "value (lambda")))
    (check-not-false token)
    (when token (check-equal? (SemanticToken-type token) SemanticTokenType-variable)))

  (test-case "forwarded binders and renamed core lambdas use confirmed kinds"
    (define doc
      (analyse (string-append prefix
                 "(require (rename-in racket/base [lambda fun]))\n"
                 "(define-syntax-rule (forward name rhs) (define name rhs))\n"
                 "(forward forwarded (fun (x) x))\n(list forwarded)\n")))
    (check-equal? (map DocumentSymbol-kind (named doc "forwarded")) (list SymbolKind-Function))
    (check-not-false (member "forwarded" (labels doc (at doc "list forwarded" 6))))
    (check-equal? (SemanticToken-type (token-at doc (at doc "forwarded)"))) SemanticTokenType-function))

  (test-case "unused template names never become authored declarations"
    (define doc
      (analyse (string-append prefix
                 "(define-syntax-rule (unused) (define prediction 1))\n"
                 "(def actual 1)\n(void)\n")))
    (check-equal? (length (named doc "actual")) 1)
    (check-not-false (member "unused" (labels doc (at doc "(void)"))))
    (check-equal? (named doc "prediction") '())
    (check-false (and (member "prediction" (labels doc (at doc "(void)"))) #t))
    (define incomplete (make-doc (source-uri source)
                                "#lang racket/base\n(define-syntax-rule (unused) (define prediction 1))\n("))
    (check-equal? (named incomplete "prediction") '()))

  (test-case "nested macro declarations respect local scope and identity at shadowed uses"
    (define doc
      (analyse (string-append prefix
                 "(define (outer arg) (def nested (lambda (x) x)) (list nested))\n"
                 "(let ([nested 1]) nested)\n(void)\n")))
    (define outer (car (named doc "outer")))
    (check-equal? (map DocumentSymbol-name (DocumentSymbol-children outer)) '("nested"))
    (check-not-false (member "nested" (labels doc (at doc "list nested" 6))))
    (check-equal? (SemanticToken-type (token-at doc (at doc "nested))"))) SemanticTokenType-function)
    (check-equal? (SemanticToken-type (token-at doc (at doc "nested)\n"))) SemanticTokenType-variable))

  (test-case "a local binding is absent outside its body and in its own initialiser"
    (define doc (analyse (string-append prefix "(bind scoped (+ 1 2) scoped)\n(void)\n")))
    (check-equal? (length (named doc "scoped")) 1)
    (check-not-false (member "scoped" (labels doc (at doc "scoped)"))))
    (check-false (and (member "scoped" (labels doc (at doc "(+ 1 2)" 3))) #t))
    (check-false (and (member "scoped" (labels doc (at doc "(void)"))) #t)))

  (for ([form '("define-struct" "struct")])
    (test-case (format "~a keeps structure hover, field anchors and local rename with macro declarations" form)
      (define constructor (if (equal? form "define-struct") "make-point" "point"))
      (define doc (analyse (string-append prefix (format "(~a point (x y))\n" form)
                                         (format "(def sample (~a 3 4))\n(point-x sample)\n" constructor))))
      (check-equal? (length (named doc "sample")) 1)
      (check-equal? (map DocumentSymbol-kind (named doc "point")) (list SymbolKind-Struct))
      (define field (at doc "x y"))
      (define use (at doc "point-x sample" 6))
      (check-equal? (doc-definition doc (source-uri source) use)
                    (Location (source-uri source) (Range field (at doc "x y" 1))))
      (define hover (doc-hover doc use))
      (check-not-false hover)
      (when hover (check-true (string-contains? (Hover-contents hover) (format "(~a point (x y))" form))))
      (define edits (doc-rename doc (source-uri source) use "z"))
      (check-not-false edits)
      (when edits
        (check-equal? (map TextEdit-range (hash-ref (WorkspaceEdit-changes edits) (string->symbol (source-uri source))))
                      (list (Range field (at doc "x y" 1)) (Range use (at doc "point-x sample" 7)))))))

  (test-case "ordinary documents retain identical completion, outline and tokens"
    (define text "#lang racket/base\n(struct point (x))\n(define (f x) (+ x 1))\n(define y (f 1))\n(let ([z y]) z)\n")
    (define doc (analyse text))
    (define old (analyse text #f #f))
    (check-true (equal? (doc-completion doc (at doc "(f 1)" 2)) (doc-completion old (at old "(f 1)" 2))))
    (check-equal? (doc-symbols-hierarchical doc) (doc-symbols-hierarchical old))
    (define range (Range (Pos 0 0) (doc-abs-pos->pos doc (doc-end-abs-pos doc))))
    (check-equal? (doc-range-tokens doc range) (doc-range-tokens old range)))
  (test-case "completion cost grows with the number of declarations"
    (define (elapsed size)
      (define declarations
        (for/list ([i (in-range size)])
          (define name (string->symbol (format "candidate~a" i)))
          (hasheq 'identifier (datum->syntax #f name) 'name name 'range (cons i (add1 i))
                  'module '() 'phase 0 'scope (cons 0 (+ size 1)))))
      (define legacy (map (lambda (binding) (hash-ref binding 'name)) declarations))
      (define facts
        (hasheq 'binders '() 'regions '()
                'names (map (lambda (binding) (hash-set (hash-set binding 'role 'definition)
                                                       'certainty 'confirmed)) declarations)))
      (apply min
        (for/list ([trial (in-range 3)])
          (collect-garbage)
          (define start (current-inexact-milliseconds))
          (define result (binding-completions facts declarations declarations size legacy))
          (define duration (- (current-inexact-milliseconds) start))
          (check-equal? result legacy)
          duration)))
    (define small (elapsed 3000))
    (define large (elapsed 12000))
    (printf "completion timings: 3000 = ~a ms; 12000 = ~a ms\n" small large)
    (check-true (< large (* 8 small))))

  (test-case "equal-length replacements discard confirmed source data"
    (define service (box #f))
    (define doc (analyse (string-append prefix "(def alpha 1)\n(void)\n") #f #t #f service))
    (check-not-false (member "alpha" (labels doc (at doc "(void)"))))
    (doc-apply-edit! doc (Range (at doc "alpha 1") (at doc "alpha 1" 5)) "omega")
    (check-false (send (unbox service) get-binding-facts))
    (check-equal? (send (unbox service) get-source-bindings) '())
    (check-equal? (named doc "omega") '()))

  (for ([entry (in-list
                '(("let" "(let ([a 1] [b 2]) (+ a b) (void 'inside))")
                  ("let*" "(let* ([a 1] [b a]) (+ a b) (void 'inside))")
                  ("letrec" "(letrec ([a (lambda () b)] [b 2]) (a) (void 'inside))")
                  ("let-values" "(let-values ([(a b) (values 1 2)]) (+ a b) (void 'inside))")
                  ("let*-values" "(let*-values ([(a) 1] [(b) a]) (+ a b) (void 'inside))")
                  ("letrec-values" "(letrec-values ([(a) (lambda () b)] [(b) 2]) (a) (void 'inside))")
                  ("named let" "(let loop ([a 1] [b 2]) (+ a b) (void 'inside))")
                  ("do" "(do ([a 0 (add1 a)] [b 2 b]) ((= a b) a) (+ a b) (void 'inside))")
                  ("define" "(define (a b) (+ b 1) (void 'inside))")
                  ("define-values" "(define-values (a b) (values 1 2))\n(void a b 'inside)")
                  ("lambda" "(lambda (a b) (+ a b) (void 'inside))")
                  ("lambda with optional arguments" "(lambda (a [b 1]) (+ a b) (void 'inside))")
                  ("lambda with keyword arguments" "(lambda (a #:b b) (+ a b) (void 'inside))")
                  ("define with optional and keyword arguments" "(define (f a [b 1] #:c [c 2]) (+ a b c) (void 'inside))")
                  ("case-lambda" "(case-lambda [(a) (void a 'inside)] [(a b) (+ a b)])")
                  ("for" "(for ([a '(1 2)] [b '(3 4)]) (+ a b) (void 'inside))")
                  ("for/list" "(for/list ([a '(1 2)]) (void 'inside) a)")
                  ("for/fold" "(for/fold ([a 0]) ([b '(1 2)]) (void 'inside) (+ a b))")
                  ("parameterize" "(define a (make-parameter 0)) (parameterize ([a 1]) (void (a) 'inside))")
                  ("with-handlers" "(with-handlers ([exn:fail? (lambda (a) (void a))]) (void 'inside))")
                  ("let-syntax" "(let-syntax ([a (syntax-rules () [(_) 1])]) (void (a) 'inside))")
                  ("match-let" "(match-let ([(list a b) '(1 2)]) (+ a b) (void 'inside))")
                  ("match-define" "(let () (match-define (list a b) '(1 2)) (void a b 'inside))")))])
    (test-case (format "~a retains identical completion, outline and tokens" (car entry))
      (define text (string-append "#lang racket/base\n(require racket/match (for-syntax racket/base))\n" (cadr entry) "\n(void 'outside)\n"))
      (define doc (analyse text))
      (define old (analyse text #f #f))
      (for ([position (in-list (regexp-match-positions* #px"\\b[ab]\\b|'inside|'outside" text))])
        (define offset (car position))
        (check-true (equal? (doc-completion doc (doc-abs-pos->pos doc offset))
                            (doc-completion old (doc-abs-pos->pos old offset)))
                    (format "~a completion at ~a" (car entry) offset)))
      (check-equal? (doc-symbols-hierarchical doc) (doc-symbols-hierarchical old))
      (define range (Range (Pos 0 0) (doc-abs-pos->pos doc (doc-end-abs-pos doc))))
      (check-equal? (doc-range-tokens doc range) (doc-range-tokens old range))))

  (test-case "simultaneous bindings exclude every sibling initialiser"
    (define doc
      (analyse (string-append prefix
                 "(define-syntax-rule (bind2 ([a x] [b y]) body) (let ([a x] [b y]) body))\n"
                 "(bind2 ([alpha 1] [beta (+ 2 3)]) (+ alpha beta))\n")))
    (for ([name '("alpha" "beta")])
      (check-not-false (member name (labels doc (at doc "(+ alpha beta)" 3))))
      (check-false (member name (labels doc (at doc "(+ 2 3)" 3))))))

  (test-case "macro completion respects the cursor module and phase"
    (define doc
      (analyse (string-append prefix
                 "(def alpha 1)\n"
                 "(module sub racket/base (void 'independent))\n"
                 "(module* shared #f (void 'inherited))\n"
                 "(module* separate racket/base (void 'separate))\n"
                 "(begin-for-syntax (define-syntax-rule (defstage n) (define n 1))\n"
                 " (defstage stage) (void 'phased))\n"
                 "(void 'outer)\n")))
    (check-false (member "alpha" (labels doc (at doc "'independent"))))
    (check-false (member "alpha" (labels doc (at doc "'separate"))))
    (check-not-false (member "alpha" (labels doc (at doc "'inherited"))))
    (check-not-false (member "alpha" (labels doc (at doc "'outer"))))
    (check-not-false (member "stage" (labels doc (at doc "'phased"))))
    (check-false (member "stage" (labels doc (at doc "'outer"))))
    (check-false (member "stage" (labels doc (doc-abs-pos->pos doc (doc-end-abs-pos doc))))))

  (test-case "independent submodules reset completion phase inside transformer regions"
    (define doc
      (analyse
        (string-append
          "#lang racket/base\n(require (for-syntax racket/base))\n"
          "(begin-for-syntax\n"
          " (module sub racket/base\n"
          "  (define-syntax-rule (def n) (define n 1))\n"
          "  (def inside) (void 'sub))\n"
          " (module* separate racket/base\n"
          "  (define-syntax-rule (def n) (define n 1))\n"
          "  (def separate) (void 'separate))\n"
          " (define-syntax-rule (defstage n) (define n 1))\n"
          " (defstage stage)\n"
          " (module* shared #f (void 'shared))\n"
          " (void 'phased))\n"
          "(void 'outer)\n")))
    (check-not-false (member "inside" (labels doc (at doc "'sub"))))
    (check-not-false (member "separate" (labels doc (at doc "'separate"))))
    (check-not-false (member "stage" (labels doc (at doc "'shared"))))
    (check-not-false (member "stage" (labels doc (at doc "'phased"))))
    (check-false (member "inside" (labels doc (at doc "'phased"))))
    (check-false (member "separate" (labels doc (at doc "'shared"))))
    (check-false (member "stage" (labels doc (at doc "'outer")))))

  (test-case "source projections release scoped syntax and namespace properties"
    (define service (box #f))
    (define namespace (box #f))
    (define doc
      (analyse
        (string-append prefix
          "(define-syntax (property-def stx)\n"
          " (syntax-case stx () [(_ name)\n"
          "  (with-syntax ([name (syntax-property #'name 'retained-namespace (make-base-empty-namespace))])\n"
          "   #'(define name (lambda (x) x)))]))\n"
          "(property-def callable)\n(list callable)\n")
        (lambda (request)
          (for ([binder (in-list (hash-ref (hash-ref request 'facts) 'binders))])
            (define ns (syntax-property (hash-ref binder 'identifier) 'retained-namespace))
            (when ns (set-box! namespace (make-weak-box ns))))
          (hasheq))
        #t #f service))
    (check-not-false (unbox namespace))
    (define (plain? value)
      (cond [(or (syntax? value) (namespace? value)) #f]
            [(hash? value) (for/and ([(key item) (in-hash value)]) (and (plain? key) (plain? item)))]
            [(pair? value) (and (plain? (car value)) (plain? (cdr value)))]
            [(vector? value) (for/and ([item (in-vector value)]) (plain? item))]
            [else #t]))
    (check-true (plain? (send (unbox service) get-source-bindings)))
    (check-true (plain? (send (unbox service) get-binding-facts)))
    (collect-garbage)
    (collect-garbage)
    (check-false (weak-box-value (unbox namespace)))
    (check-equal? (map DocumentSymbol-kind (named doc "callable")) (list SymbolKind-Function))
    (check-equal? (SemanticToken-type (token-at doc (at doc "callable)"))) SemanticTokenType-function))

  (test-case "contribution analysis omits source service projections"
    (define service (box #f))
    (define calls 0)
    (define doc
      (analyse (string-append prefix "(def alpha 1)\nalpha\n")
        (lambda (request)
          (set! calls (add1 calls))
          (define binders (hash-ref (hash-ref request 'facts) 'binders))
          (check-true (pair? binders))
          (for ([binder (in-list binders)])
            (for ([key '(extent kind scope scope-exclusions declaration?)])
              (check-false (hash-has-key? binder key))))
          (hasheq))
        #t #t service))
    (check-equal? calls 1)
    (check-equal? (send (unbox service) get-source-bindings) '())
    (check-not-false (doc-definition doc (source-uri source) (at doc "\nalpha" 1)))))
