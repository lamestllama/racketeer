#lang racket/base

(require drracket/check-syntax
         rackunit
         racket/class
         racket/list
         "../../common/source.rkt"
         "../../common/interfaces.rkt"
         "../../doclib/internal-types.rkt"
         "../../doclib/service/declaration.rkt"
         "../../doclib/doc-trace.rkt"
         "../../doclib/doc.rkt"
         "../../doclib/editor.rkt"
         "../../doclib/lexer.rkt")

(define source (path->source (build-path (current-directory) "model.rkt")))
(define path (source-file-path source))
(define bindings
  (for/list ([name '(struct:a a? a)]) (Module-Binding path '() 0 name)))
(define (target declarations binding)
  (send declarations syncheck:add-definition-target/phase-level+space
        path 51 52 (Module-Binding-id binding) (Module-Binding-submods binding)
        (Module-Binding-phase+space binding)))
(define (jump declarations binding start)
  (send declarations syncheck:add-jump-to-definition/phase-level+space
        path start (add1 start) (Module-Binding-id binding)
        (Module-Binding-filepath binding) (Module-Binding-submods binding)
        (Module-Binding-phase+space binding)))
(define (entries-at entries range)
  (map cdr (filter (lambda (entry) (equal? (car entry) range)) entries)))
(define (check-bindings actual expected)
  (check-equal? (length actual) (length expected))
  (for ([binding expected]) (check-not-false (member binding actual))))

(define mixed-prefix
  (string-append
    "#lang racket/base\n"
    "(module model racket/base (provide (struct-out a)) (struct a ()))\n"
    "(require 'model (for-syntax racket/base racket/syntax))\n"
    "(define-syntax (both stx)\n"
    "  (syntax-case stx ()\n"
    "    [(_ name)\n"
    "     (with-syntax ([other (syntax-property (format-id #'name \"struct:a\" #:source #'name) 'original-for-check-syntax #t)])\n"
    "       #'(list name other))]))\n"))

(module+ test
  (test-case "mixed local and imported occurrence refuses both rename queries"
    (define doc (make-doc (source-uri source)
                         (string-append mixed-prefix "(define a? 7)\n(both a?)\na?\nstruct:a\n")))
    (check-true (doc-expand! doc))
    (check-false (doc-rename doc (source-uri source) (Pos 9 6) "changed"))
    (check-false (doc-prepare-rename doc (Pos 9 6))))

  (test-case "shared lexical and imported occurrence retains both query owners"
    (define doc (make-doc (source-uri source)
                         (string-append mixed-prefix "(let ([a? 7]) (both a?) a? struct:a)\n")))
    (check-true (doc-expand! doc))
    (check-equal? (doc-definition-ranges-at doc (Pos 8 20))
                  (list (Range (Pos 1 59) (Pos 1 60))
                        (Range (Pos 8 7) (Pos 8 9))))
    (check-equal? (doc-uses-at doc (Pos 8 20))
                  (list (Range (Pos 8 20) (Pos 8 22))
                        (Range (Pos 8 24) (Pos 8 26))
                        (Range (Pos 8 27) (Pos 8 35)))))

  (test-case "shared module local and imported occurrence returns every definition"
    (define doc (make-doc (source-uri source)
                         (string-append mixed-prefix "(define a? 7)\n(both a?)\n")))
    (check-true (doc-expand! doc))
    (define targets (doc-definition doc (source-uri source) (Pos 9 6)))
    (check-true (list? targets))
    (check-not-false (member (Location (source-uri source) (Range (Pos 8 8) (Pos 8 10))) targets))
    (check-not-false (member (Module-Binding path '(model) 0 'struct:a) targets)))

  (test-case "shared lexical occurrence includes all live declarations once"
    (define declarations (new declaration% [source source] [doc-text #f]))
    (for ([start '(10 20)])
      (send declarations syncheck:add-arrow/name-dup path start (add1 start) path 30 31 #t 0 #f #f))
    (check-equal? (send declarations definition-ranges-at 30) (list (CharRange 10 11) (CharRange 20 21)))
    (check-false (send declarations definition-at 30))
    (send declarations expand 0 2)
    (check-equal? (send declarations definition-ranges-at 32) (list (CharRange 12 13) (CharRange 22 23)))
    (send declarations contract 12 13)
    (check-equal? (send declarations definition-ranges-at 31) (list (CharRange 21 22))))

  (test-case "an explicit imported alias retains its module owner without a local definition"
    (define doc (make-doc (source-uri source)
                         "#lang racket/base\n(require (rename-in racket/list [add-between ab]))\n(ab '(1 2) 0)\n"))
    (check-true (doc-expand! doc))
    (check-false (doc-definition-at doc (Pos 2 1)))
    (check-true (Module-Binding? (doc-module-binding-at doc (Pos 2 1))))))

(module+ test
  (test-case "all three struct identities share a definition range"
    (define declarations (new declaration% [source source] [doc-text #f]))
    (for ([binding bindings]) (target declarations binding))
    (check-bindings (entries-at (send declarations module-binding-definitions) (CharRange 51 52)) bindings))

  (test-case "one use range retains every imported identity"
    (define declarations (new declaration% [source source] [doc-text #f]))
    (for ([binding bindings]) (jump declarations binding 60))
    (check-bindings (entries-at (send declarations module-binding-uses) (CharRange 60 61)) bindings))

  (for ([targets-first? '(#t #f)])
    (test-case (format "same-file uses retain their identities, targets first: ~a" targets-first?)
      (define declarations (new declaration% [source source] [doc-text #f]))
      (when targets-first? (for ([binding bindings]) (target declarations binding)))
      (for ([binding bindings] [start '(60 70 80)]) (jump declarations binding start))
      (unless targets-first? (for ([binding bindings]) (target declarations binding)))
      (for ([binding bindings] [start '(60 70 80)])
        (check-equal? (send declarations module-binding-at start) binding)
        (check-equal? (send declarations definition-at start) (CharRange 51 52))
        (check-equal? (send declarations uses-at start) (list (CharRange start (add1 start)))))
      (check-equal? (send declarations uses-at 51)
                    (list (CharRange 60 61) (CharRange 70 71) (CharRange 80 81)))))

  (test-case "phase, space and submodule are part of each retained identity"
    (define declarations (new declaration% [source source] [doc-text #f]))
    (define distinct
      (for/list ([phase '(0 1 (0 . names) #f)] [mods '(() () () (inner))])
        (Module-Binding path mods phase 'a)))
    (for ([binding distinct]) (target declarations binding) (jump declarations binding 60))
    (check-bindings (entries-at (send declarations module-binding-definitions) (CharRange 51 52)) distinct)
    (check-bindings (entries-at (send declarations module-binding-uses) (CharRange 60 61)) distinct))

  (test-case "repeated callbacks do not duplicate facts and edits move every identity"
    (define declarations (new declaration% [source source] [doc-text #f]))
    (for* ([repeat '(1 2)] [binding bindings]) (target declarations binding) (jump declarations binding 60))
    (send declarations expand 0 2)
    (check-bindings (entries-at (send declarations module-binding-definitions) (CharRange 53 54)) bindings)
    (check-bindings (entries-at (send declarations module-binding-uses) (CharRange 62 63)) bindings)
    (send declarations contract 53 54)
    (check-equal? (send declarations module-binding-definitions) '())
    (send declarations reset)
    (check-equal? (send declarations module-binding-uses) '()))

  (test-case "full trace contributions retain shared targets and uses"
    (define text (make-string 100 #\space))
    (define editor (new lsp-editor%))
    (send editor insert text 0)
    (define trace (new build-trace% [source source] [doc-text editor]
                       [lexer-state (build-lexer-state text (source-uri source))]))
    (for ([binding bindings]) (target trace binding) (jump trace binding 60))
    (define contribution (send trace get-contribution))
    (check-bindings (hash-keys (Doc-Contribution-definitions contribution)) bindings)
    (check-bindings (filter (lambda (binding) (member binding bindings))
                            (hash-keys (Doc-Contribution-references contribution))) bindings)
    (for ([binding bindings])
      (check-equal? (hash-ref (Doc-Contribution-definitions contribution) binding)
                    (Location (source-uri source) (Range (Pos 0 51) (Pos 0 52))))
      (check-equal? (hash-ref (Doc-Contribution-references contribution) binding)
                    (list (Location (source-uri source) (Range (Pos 0 60) (Pos 0 61))))))))

(module+ test
  (test-case "expanded local struct uses retain their exact identities"
    (define text "#lang racket/base\n(provide (struct-out a))\n(struct a ())\na?\nstruct:a\na\n")
    (define doc (make-doc (source-uri source) text))
    (check-true (doc-expand! doc))
    (for ([binding bindings] [line '(4 3 5)] [width '(8 2 1)])
      (define pos (Pos line 0))
      (check-equal? (doc-module-binding-at doc pos) binding)
      (check-equal? (doc-definition-at doc pos) (Range (Pos 2 8) (Pos 2 9)))
      (check-not-false (member (Range pos (Pos line width)) (doc-uses-at doc pos)))
      (for ([other '(3 4 5)] #:unless (= other line))
        (check-false (for/or ([range (in-list (doc-uses-at doc pos))])
                       (= other (Pos-line (Range-start range))))))
      (check-false (doc-rename doc (source-uri source) pos "changed")))))

(module+ test
  (require drracket/check-syntax
           rackunit
           racket/class
           "../../common/interfaces.rkt"
           "../../common/path-util.rkt"
           "../../common/source.rkt"
           "../../doclib/doc-trace.rkt"
           "../../doclib/internal-types.rkt"
           "../../doclib/lexer.rkt"
           "../../doclib/editor.rkt")
  (for ([names '((a) (struct:a a? a))])
    (test-case
      (format "definition targets ~s retain their shared range" names)
      (define path (build-path (current-directory) "m.rkt"))
      (define uri (path->uri path))
      (define text "#lang racket/base\n(provide a?)\n(struct a ())\n")
      (define doc-text (new lsp-editor%))
      (send doc-text insert text 0)
      (define trace
        (new build-trace%
          [source (path->source path)]
          [doc-text doc-text]
          [lexer-state (build-lexer-state text uri)]))
      ;; Check Syntax reports all three struct bindings at the written a.
      (for ([name (in-list names)])
        (send trace syncheck:add-definition-target/phase-level+space
              path 39 40 name '() 0))
      (check-equal?
        (for/hash ([entry (in-list
                            (send (send trace get-declaration) module-binding-definitions))])
          (values (cdr entry) (car entry)))
        (for/hash ([name (in-list names)])
          (values (Module-Binding path '() 0 name) (CharRange 39 40))))
      (check-equal?
        (Doc-Contribution-definitions (send trace get-contribution))
        (for/hash ([name (in-list names)])
          (values (Module-Binding path '() 0 name)
                  (Location uri (Range (Pos 2 8) (Pos 2 9)))))))))
