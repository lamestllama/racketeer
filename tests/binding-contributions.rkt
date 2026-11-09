#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require drracket/check-syntax
         rackunit
         racket/class
         racket/list
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/editor.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt")

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
(define (check-bindings actual expected)
  (check-equal? (length actual) (length expected))
  (for ([binding expected]) (check-not-false (member binding actual))))

(module+ test
  (test-case "contribution-only trace retains shared targets and uses"
    (define text (make-string 100 #\space))
    (define editor (new lsp-editor%))
    (send editor insert text 0)
    (define trace (new build-trace% [source source] [doc-text editor]
                       [lexer-state (build-lexer-state text (source-uri source))] [contribution-only? #t]))
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
  (test-case "contribution-only expansion retains exact local struct identities"
    (define text "#lang racket/base\n(provide (struct-out a))\n(struct a ())\na?\nstruct:a\na\n")
    (define doc (make-doc (source-uri source) text))
    (check-true (doc-expand! doc #:contribution-only? #t))
    (for ([binding bindings] [line '(4 3 5)] [width '(8 2 1)])
      (define pos (Pos line 0))
      (check-equal? (doc-module-binding-at doc pos) binding)
      (check-equal? (doc-definition-at doc pos) (Range (Pos 2 8) (Pos 2 9)))
      (check-not-false (member (Range pos (Pos line width)) (doc-uses-at doc pos)))
      (for ([other '(3 4 5)] #:unless (= other line))
        (check-false (for/or ([range (in-list (doc-uses-at doc pos))])
                       (= other (Pos-line (Range-start range))))))
      (check-false (doc-rename doc (source-uri source) pos "changed")))))
