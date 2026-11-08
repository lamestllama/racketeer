#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class racket/dict racket/file racket/list racket/runtime-path racket/set)

(define-runtime-path bundled "../vendor/collects")
(current-library-collection-paths (cons bundled (current-library-collection-paths)))
(define (api file names)
  (apply values (for/list ([name names]) (dynamic-require (build-path bundled "racket-langserver" file) name))))
(define-values (make-doc doc-expand! Doc-contribution doc-references doc-rename doc-definition-ranges)
  (api "doclib/doc.rkt" '(make-doc doc-expand! Doc-contribution doc-references doc-rename doc-definition-ranges)))
;; Inspect the completed trace without widening the document's public API.
(define Doc-trace
  (parameterize ([current-namespace (module->namespace (build-path bundled "racket-langserver/doclib/doc.rkt"))])
    (eval 'Doc-trace)))
(define-values (path->uri) (api "common/path-util.rkt" '(path->uri)))
(define-values (jsexpr->Pos) (api "common/interfaces.rkt" '(jsexpr->Pos)))
(define (Pos row column) (jsexpr->Pos (hasheq 'line row 'character column)))
(define-values (expand-source) (api "doclib/check-syntax.rkt" '(expand-source)))
(define-values (ExpandResult ExpandResult-logs ExpandResult-post-syntax)
  (api "doclib/internal-types.rkt" '(ExpandResult ExpandResult-logs ExpandResult-post-syntax)))
(define-values (path->source) (api "common/source.rkt" '(path->source)))
(define-values (build-trace%) (api "doclib/doc-trace.rkt" '(build-trace%)))
(define-values (build-lexer-state) (api "doclib/lexer.rkt" '(build-lexer-state)))
(define-values (lsp-editor%) (api "doclib/editor.rkt" '(lsp-editor%)))
(define-values (inferred-message)
  (api "doclib/service/tooltip-log.rkt" '(typed-racket-inferred-type-message)))

(define text
  "#lang racket/base\n(require racket/list)\n(provide answer)\n(define (answer unused) (let ([x 1]) (+ x 2)))\n(answer 0)\n(struct item (value))\n(item 42)\n")
(define-runtime-path file "contribution-sample.rkt")
(define uri (path->uri file))
(define (document mode)
  (define d (make-doc uri text))
  (check-true (if (eq? mode 'default) (doc-expand! d) (doc-expand! d #:contribution-only? mode)))
  d)
(define (tooltip-log message forced)
  (define located (datum->syntax #f 'x (list file 1 0 1 1)))
  (vector 'info message
          (list (syntax-property located 'mouse-over-tooltips
                                 (vector located 0 1 (lambda () (set-box! forced (add1 (unbox forced))) "type"))))
          'online-check-syntax))
(define (products trace)
  (define hover (send trace get-hover))
  (list (send trace get-semantic-tokens)
        (sort (send trace get-completions) symbol<?)
        (sort (dict->list (send trace get-docs)) < #:key caar)
        (sort (dict->list (send trace get-requires)) < #:key caar)
        (sort (set->list (send trace get-warn-diags)) string<? #:key (lambda (value) (format "~s" value)))
        (call-with-values (lambda () (send hover annotation-at 0)) list)
        (call-with-values (lambda () (send hover source-detail-at 66)) list)
        (call-with-values (lambda () (send (send trace get-typed-racket) inferred-type-at 0)) list)
        (send (send trace get-inlay-hints) hints-in-range 0 (string-length text))
        (call-with-values (lambda () (send (send trace get-tails) at (caar (regexp-match-positions #rx"\\(define" text)))) list)))

(module+ test
  (test-case "contribution analysis keeps bindings and skips service products and tooltip providers"
    (define full (document 'default))
    (define only (document #t))
    (check-equal? (Doc-contribution only) (Doc-contribution full))
    (check-equal? (doc-definition-ranges only) (doc-definition-ranges full))
    ;; Cover every source position, including unused locals and imported uses.
    (for ([line (in-list (string-split-lines text))] [row (in-naturals)])
      (for ([column (in-range (string-length line))])
        (define pos (Pos row column))
        (check-equal? (doc-references only uri pos #t) (doc-references full uri pos #t))
        (check-equal? (doc-rename only uri pos "renamed") (doc-rename full uri pos "renamed"))))
    (define forced (box 0))
    (define logs (list (tooltip-log "hover" forced) (tooltip-log inferred-message forced)))
    (define indexed (Doc-trace only))
    ;; These callbacks have observable products in all remaining services.
    (define callbacks
      (parameterize ([current-namespace (module->namespace (build-path bundled "racket-langserver/doclib/doc-trace.rkt"))])
        (eval '(lambda (trace file)
                 (send trace syncheck:add-require-open-menu file 0 1 file)
                 (send trace syncheck:add-docs-menu file 0 1 'x "x" file 'x "x")
                 (send trace syncheck:add-mouse-over-status file 0 1 "no bound occurrences")
                 (send trace syncheck:add-tail-arrow file 57 file 94)))))
    (define input (open-input-string text))
    (port-count-lines! input)
    (define pre-syntax (parameterize ([read-accept-reader #t]) (read-syntax file input)))
    (for ([trace (list indexed (Doc-trace full))])
      ;; Seed the hint service directly so an accidental build! is observable,
      ;; independently of whether it also received the document's syntax walk.
      (send (send trace get-inlay-hints) walk-stx (ExpandResult pre-syntax #f '()))
      (callbacks trace file)
      (send trace walk-log logs)
      (when (eq? trace indexed) (check-equal? (unbox forced) 0)))
    (check-equal? (unbox forced) 2)
    (define empty (Doc-trace (make-doc uri text)))
    (check-equal? (products indexed) (products empty))
    ;; Each skipped service has something to produce for this fixture.
    (for ([result (in-list (products (Doc-trace full)))] [initial (in-list (products empty))]
          [name '(highlight completion docs require diagnostic hover detail typed-racket inlay tail)])
      (check-not-equal? result initial (symbol->string name))))

  (test-case "contribution analysis propagates resource failures without changing full diagnostics"
    (define failing-text
      "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (raise (exn:fail:out-of-memory \"resource probe\" (current-continuation-marks))))\n")
    (check-exn exn:fail:out-of-memory?
               (lambda () (doc-expand! (make-doc uri failing-text) #:contribution-only? #t)))
    (for ([mode '(default #f)])
      (check-exn #rx"error-diagnostics: unexpected failure"
                 (lambda ()
                   (define doc (make-doc uri failing-text))
                   (if (eq? mode 'default) (doc-expand! doc)
                       (doc-expand! doc #:contribution-only? #f))))))

  (test-case "default and explicit full analysis agree and only full expansion enables info logs"
    (check-true (equal? (products (Doc-trace (document 'default))) (products (Doc-trace (document #f)))) "default service results")
    (define logging-template
      "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (unless (eq? (and (log-level? (current-logger) 'info 'contribution-test) #t) ~s) (error 'test \"unexpected log interception\")) (when (log-level? (current-logger) 'info 'contribution-test) (log-message (current-logger) 'info 'contribution-test \"enabled\" #f)))\n")
    (for ([only? '(#t #f)])
      (define logging-text (format logging-template (not only?)))
      (define editor (new lsp-editor%))
      (send editor insert logging-text 0)
      (define trace (new build-trace% [source (path->source file)] [doc-text editor]
                         [lexer-state (build-lexer-state logging-text uri)] [contribution-only? only?]))
      (define result
        (parameterize ([current-logger (make-logger #f #f)])
          (expand-source (path->source file) (open-input-string logging-text) trace #:contribution-only? only?)))
      (check-not-false (ExpandResult-post-syntax result))
      (define logs (filter (lambda (record) (eq? (vector-ref record 3) 'contribution-test)) (ExpandResult-logs result)))
      (check-equal? (length logs) (if only? 0 1)))))

(define (string-split-lines text)
  (regexp-split #rx"\n" text))
