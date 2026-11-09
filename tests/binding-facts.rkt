#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/file racket/list racket/runtime-path
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/workspace/api.rkt"
         "../vendor/collects/racket-langserver/lsp/compose/references.rkt"
         "../vscode/workspace-wire.rkt")

(define-runtime-path analysis "../vscode/workspace-analysis.rkt")
(define root (make-temporary-file "binding-facts~a" 'directory))
(define source (path->source (build-path root "model.rkt")))
(define text
  (string-append
    "#lang racket/base\n(require (for-syntax racket/base racket/syntax))\n"
    "(define-syntax (define-thing stx)\n"
    " (syntax-case stx () [(_ name)\n"
    "  (with-syntax ([helper (format-id #'name \"~a-helper\" #'name #:source #'name)] [other (format-id #'name \"unrelated\" #:source #'name)])\n"
    "   #'(begin (define name 1) (define helper 2) (define other 3)))]))\n"
    "(define-thing thing)\n(provide thing thing-helper)\n"
    "(void)\nthing\nthing-helper\nunrelated\n; native\n"))
(define (definition facts id)
  (for/first ([name (in-list (hash-ref facts 'names))]
              #:when (and (eq? (hash-ref name 'role) 'definition)
                          (eq? (syntax-e (hash-ref name 'identifier)) id)))
    name))
(define calls (box 0))
(define (provider request)
  (set-box! calls (add1 (unbox calls)))
  (check-true (immutable? request))
  (check-equal? (hash-ref request 'operation) 'bindings)
  (check-equal? (hash-ref request 'uri) (source-uri source))
  (check-equal? (hash-ref request 'text) text)
  (check-true (syntax? (hash-ref request 'expanded)))
  (check-false ((hash-ref request 'cancelled?)))
  (define facts (hash-ref request 'facts))
  (define main (definition facts 'thing))
  (define helper (definition facts 'thing-helper))
  (define start (caar (regexp-match-positions #rx"native" text)))
  (hasheq 'names
          (list (hasheq 'identifier (hash-ref helper 'identifier) 'role 'use
                        'range (cons start (+ start 6))))
          'families
          (list (hasheq 'key 'thing 'canonical (hash-ref main 'identifier) 'complete? #t
                        'members (list (hash-set main 'anchor '(value 0))
                                       (hash-set helper 'anchor '(value 1)))))))
(define (analyse only? [bindings-provider #f] [source source] [text text])
  (define doc (make-doc (source-uri source) text))
  (define trace (new build-trace% [source source] [doc-text (doc-copy-text-buffer doc)]
                     [lexer-state (build-lexer-state text (source-uri source))]
                     [contribution-only? only?]))
  (define result
    (if bindings-provider
        (expand-source source (open-input-string text) trace #:contribution-only? only?
                       #:bindings-provider bindings-provider)
        (expand-source source (open-input-string text) trace #:contribution-only? only?)))
  (check-true (ExpandResult-all-succeed? result))
  (send trace walk-stx result)
  (doc-update-trace! doc trace (send trace get-contribution) 0)
  doc)
(define (keys result)
  (define binding (Document-Reference-Result-module-binding result))
  (if (list? binding) binding (list binding)))

(module+ test
  (test-case "generic collection never calls an absent provider"
    (set-box! calls 0)
    (define full (analyse #f))
    (define only (analyse #t))
    (check-equal? (unbox calls) 0)
    (check-equal? (Doc-contribution full) (Doc-contribution only))
    (for ([id '(thing thing-helper unrelated)])
      (check-true (for/or ([key (in-hash-keys (Doc-Contribution-definitions (Doc-contribution full)))])
                    (eq? id (Module-Binding-id key))))))

  (test-case "one optional call supplies component uses and family keys in both modes"
    (set-box! calls 0)
    (define full (analyse #f provider))
    (define only (analyse #t provider))
    (check-equal? (unbox calls) 2)
    (check-equal? (Doc-contribution full) (Doc-contribution only))
    (define out (open-output-string))
    (define errors (open-output-string))
    (define logged
      (parameterize ([current-output-port out] [current-error-port errors])
        (analyse #t (lambda (request) (display "bindings\n") (provider request)))))
    (check-equal? (Doc-contribution logged) (Doc-contribution only))
    (check-equal? (unbox calls) 3)
    (check-equal? (get-output-string out) "")
    (check-equal? (get-output-string errors) "bindings\n")
    (for ([doc (in-list (list full only))])
      (define results
        (for/list ([pos (in-list (list (Pos 9 0) (Pos 10 0) (Pos 12 2)))])
          (doc-references doc (source-uri source) pos #t)))
      (for ([result (in-list results)])
        (check-equal? (sort (map Module-Binding-id (keys result)) symbol<?) '(thing thing-helper))
        (check-equal? (Reference-Source-locations (Document-Reference-Result-source result))
                      (Reference-Source-locations (Document-Reference-Result-source (car results)))))
      (check-equal? (map Module-Binding-id (keys (doc-references doc (source-uri source) (Pos 11 0) #f)))
                    '(unrelated))))

  (test-case "every family member finds unopened-file uses and one shared declaration"
    (define doc (analyse #t provider))
    (define workspace (make-workspace))
    (workspace-add-folder! workspace root)
    (workspace-set-contribution! workspace (Doc-contribution doc))
    (define definitions (Doc-Contribution-definitions (Doc-contribution doc)))
    (define member-keys
      (filter (lambda (key) (memq (Module-Binding-id key) '(thing thing-helper))) (hash-keys definitions)))
    (display-to-file text (source-file-path source) #:exists 'truncate)
    (define unopened (path->source (build-path root "unopened.rkt")))
    (define imported-text "#lang racket/base\n(require \"model.rkt\")\nthing\nthing-helper\n")
    (display-to-file imported-text (source-file-path unopened))
    (define unopened-doc (analyse #t #f unopened (file->string (source-file-path unopened))))
    (define locations
      (list (Location (source-uri unopened) (Range (Pos 2 0) (Pos 2 5)))
            (Location (source-uri unopened) (Range (Pos 3 0) (Pos 3 12)))))
    (workspace-set-contribution! workspace (Doc-contribution unopened-doc))
    ;; An older contributed occurrence from the live file must stay absent.
    (define stale (Location (source-uri source) (Range (Pos 99 0) (Pos 99 1))))
    (workspace-set-contribution!
      workspace (Doc-Contribution (source-file-path source)
                                  (for/hash ([key (in-list member-keys)]) (values key (list stale)))
                                  definitions))
    (for ([pos (in-list (list (Pos 9 0) (Pos 10 0) (Pos 12 2)))])
      (define result (doc-references doc (source-uri source) pos #t))
      (define actual (reference-locations workspace result #t))
      (for ([location (in-list locations)]) (check-not-false (member location actual)))
      (check-false (member stale actual))
      (check-equal? (length actual) (length (remove-duplicates actual)))
      (check-equal? (count (lambda (location) (equal? (Location-range location) (Range (Pos 6 14) (Pos 6 19)))) actual) 1)
      (check-false (member (Location (source-uri source) (Range (Pos 11 0) (Pos 11 9))) actual))))

  (test-case "imported family members select both keys and deduplicate their external declaration"
    (display-to-file text (source-file-path source) #:exists 'truncate)
    (define imported (path->source (build-path root "imported.rkt")))
    (define imported-text "#lang racket/base\n(require \"model.rkt\")\nthing\nthing-helper\n")
    (define imported-doc
      (analyse #t
        (lambda (request)
          (define members
            (for/list ([id '(thing thing-helper)] [anchor '(first second)])
              (define name
                (for/first ([name (in-list (hash-ref (hash-ref request 'facts) 'names))]
                            #:when (eq? id (syntax-e (hash-ref name 'identifier))))
                  name))
              (hash-set name 'anchor anchor)))
          (hasheq 'families
                  (list (hasheq 'key 'imported 'canonical (hash-ref (car members) 'identifier)
                                'members members))))
        imported imported-text))
    (define workspace (make-workspace))
    (workspace-add-folder! workspace root)
    (workspace-set-contribution! workspace (Doc-contribution (analyse #t)))
    (for ([line '(2 3)])
      (define result (doc-references imported-doc (source-uri imported) (Pos line 0) #t))
      (check-equal? (length (keys result)) 2)
      (define locations (reference-locations workspace result #t))
      (check-equal? (length locations) (length (remove-duplicates locations)))
      (check-equal? (count (lambda (location)
                             (and (equal? (Location-uri location) (source-uri source))
                                  (equal? (Location-range location) (Range (Pos 6 14) (Pos 6 19)))))
                           locations) 1)))

  (test-case "invalid names, unbound identifiers and incomplete family records are refused"
    (for ([result (in-list
                   (list (hasheq 'names (list (hasheq 'identifier #'unbound 'role 'use 'range '(0 . 1))))
                         (hasheq 'families (list (hasheq 'key 'bad 'canonical #'unbound 'members '())))
                         (hasheq 'names 'bad)))])
      (check-exn #rx"expected" (lambda () (analyse #t (lambda (_) result))))))

  (test-case "predictions cannot create confirmed declarations or references"
    (define doc
      (analyse #t
        (lambda (_)
          (hasheq 'names (list (hasheq 'identifier #'unbound 'role 'definition
                                      'range '(0 . 1) 'certainty 'predicted))))))
    (check-false (doc-occurrence-at doc (Pos 0 0))))

  (test-case "worker query records round-trip family, scalar and local lookup keys"
    (dynamic-require analysis #f)
    (define round-trip
      (parameterize ([current-namespace (module->namespace analysis)])
        (eval '(lambda (record path)
                 (reference-query->datum (datum->reference-query path record))))))
    (define path (source-file-path source))
    (define first-key (list path '() 0 'thing))
    (define second-key (list path '(inner) '(1 . names) 'helper))
    (for ([binding (in-list (list #f first-key (list 'bindings first-key second-key)))])
      (define record (list '() binding))
      (define out (open-output-bytes))
      (write-worker-message record out)
      (define transported (read-worker-message (open-input-bytes (get-output-bytes out))))
      (check-equal? (round-trip transported path) record)))

  (test-case "generic provide collection retains label and numeric binding phases"
    (display-to-file "#lang racket/base\n(provide value)\n(define value 1)\n"
                     (build-path root "label.rkt"))
    (for* ([kind '(for-syntax for-label)] [only? '(#f #t)])
      (define text
        (string-append
         "#lang racket/base\n(require (for-syntax racket/base))\n"
         (if (eq? kind 'for-syntax) "(begin-for-syntax (define value 1))\n"
             "(require (for-label \"label.rkt\"))\n")
         "(define-syntax (export stx) (syntax-case stx () [(_ spelling)\n"
         (format " #`(provide (~a #,(syntax-property (datum->syntax #'value 'value #'spelling) 'original-for-check-syntax #t)))]))\n" kind)
         "(export Lib.value)\n"))
      (define facts #f)
      (analyse only? (lambda (request) (set! facts (hash-ref request 'facts)) (hasheq)) source text)
      (define range (car (regexp-match-positions #rx"Lib.value" text)))
      (check-not-false
       (for/or ([name (in-list (hash-ref facts 'names))])
         (and (equal? (hash-ref name 'range) range)
              (equal? (hash-ref name 'phase) (if (eq? kind 'for-label) #f 1)))))))

  (test-case "shifted imports replace only the superseded whole-span occurrence"
    (define lib (build-path root "shifted-label.rkt"))
    (display-to-file "#lang racket/base\n(provide value)\n(define value 1)\n" lib)
    (define text
      (string-append
       "#lang racket/base\n(require (for-syntax racket/base \"shifted-label.rkt\") (for-meta 2 racket/base))\n"
       "(begin-for-syntax\n"
       "(define-syntax (member stx) (syntax-case stx () [(_ spelling)\n"
       " (syntax-property (datum->syntax #'value 'value #'spelling) 'original-for-check-syntax #t)]))\n"
       "(member Lib.value))\n"))
    (define whole (car (regexp-match-positions #rx"Lib.value" text)))
    (define narrow (cons (+ (car whole) 4) (cdr whole)))
    (define binding (Module-Binding lib '() 0 'value))
    (define (location doc range)
      (Location (source-uri source)
                (Range (doc-abs-pos->pos doc (car range))
                       (doc-abs-pos->pos doc (cdr range)))))
    (define results
      (for/list ([only? '(#f #t)])
        (define generic (analyse only? #f source text))
        (define empty (analyse only? (lambda (_) (hasheq)) source text))
        (check-equal? (Doc-contribution generic) (Doc-contribution empty))
        (check-equal? (hash-ref (Doc-Contribution-references (Doc-contribution generic)) binding)
                      (list (location generic whole)))
        (define doc
          (analyse only?
            (lambda (request)
              (define name
                (for/first ([name (in-list (hash-ref (hash-ref request 'facts) 'names))]
                            #:when (and (eq? (hash-ref name 'role) 'use)
                                        (equal? (hash-ref name 'range) whole)
                                        (eq? (syntax-e (hash-ref name 'identifier)) 'value)))
                  name))
              (check-equal? (hash-ref name 'phase) 1)
              (hasheq 'names (list (hash-set name 'range narrow))))
            source text))
        (define references
          (doc-references doc (source-uri source) (doc-abs-pos->pos doc (car narrow)) #f))
        (list (filter (lambda (location)
                        (= (Pos-line (Range-start (Location-range location))) 5))
                      (Reference-Source-locations (Document-Reference-Result-source references)))
              (hash-ref (Doc-Contribution-references (Doc-contribution doc)) binding))))
    (define expected (list (Location (source-uri source) (Range (Pos 5 12) (Pos 5 17)))))
    (check-equal? results (make-list 2 (list expected expected))))

  (delete-directory/files root))
