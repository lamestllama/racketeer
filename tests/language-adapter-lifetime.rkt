#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class racket/file racket/port
         (submod "language-adapter-cache.rkt" support)
         "../racketdap/language-adapters.rkt"
         "../racketdap/worker/load.rkt"
         "../racketdap/tools/macro-source.rkt"
         "../racketdap/tools/macro-steps/expansion.rkt")
(module+ test
  (for ([kind '(descriptor provider dependency)])
    (test-case (format "a ~a edit between analysis and publication publishes nothing" kind)
      (with-project
       (lambda (root source files change)
         (parameterize ([resolver (lambda (file source-text pre roots)
                                    (resolve-language-adapter file #:text source-text #:pre pre #:workspace root))]
                        [validator current?])
           (define doc (make-doc (path->uri source) text))
           (check-true (doc-expand! doc))
           (define trace
             (parameterize ([current-namespace (module->namespace 'racket-langserver/doclib/doc)])
               ((eval 'Doc-trace) doc)))
           (define product ((api "lsp/analysis.rkt" 'Analysis-Product)
                            #t ((api "lsp/analysis.rkt" 'Analysis-Summary) (hash) (hash))
                            (list (hasheq 'message "completed")) trace (send trace get-contribution) #f))
           (define sd ((api "lsp/safedoc.rkt" 'new-safedoc) (path->uri source) text 0))
           (define publisher ((api "lsp/source-controller/analysis-publisher.rkt" 'make-analysis-publisher)
                              ((api "workspace/state.rkt" 'make-workspace))))
           (define messages '())
           ((api "lsp/source-controller/analysis-publisher.rkt" 'set-analysis-notifier!) publisher
            (lambda (method value) (set! messages (cons value messages))))
           (define store ((api "workspace/source-store.rkt" 'make-source-store)))
           (define src ((api "common/source.rkt" 'path->source) source))
           ((api "workspace/source-store.rkt" 'source-store-open!) store src sd)
           (define snapshot ((api "workspace/source-store.rkt" 'Source-Snapshot)
                             src (gensym) 'buffer (string->immutable-string text)))
           (change kind)
           ((api "lsp/source-controller/analysis-publisher.rkt" 'publish-document-analysis!) publisher sd snapshot product)
           (check-equal? messages '())
           (check-false ((api "lsp/safedoc.rkt" 'SafeDoc-available) sd)))))))
  (test-case "an expansion error still installs the selected structural and formatting policy"
    (define source-text "#lang racket/base\n(define (answer)\n(+ missing 1))\n")
    (parameterize ([resolver (lambda args (validate-language-profile
                                          '(profile (editor (body-mode non-sexp) (formatting off)))))])
      (define doc (make-doc "file:///tmp/adapter-errors.rkt" source-text))
      (define result ((api "doclib/doc.rkt" 'doc-check-syntax) doc))
      (check-false ((api "doclib/check-syntax.rkt" 'CSResult-succeed?) result))
      (define trace ((api "doclib/check-syntax.rkt" 'CSResult-trace) result))
      (define product ((api "lsp/analysis.rkt" 'Analysis-Product) #f #f '() trace #f #f))
      (define sd ((api "lsp/safedoc.rkt" 'new-safedoc) "file:///tmp/adapter-errors.rkt" source-text 0))
      (define publisher ((api "lsp/source-controller/analysis-publisher.rkt" 'make-analysis-publisher)
                         ((api "workspace/state.rkt" 'make-workspace))))
      (define src ((api "common/source.rkt" 'uri->source) "file:///tmp/adapter-errors.rkt"))
      (define snapshot ((api "workspace/source-store.rkt" 'Source-Snapshot)
                        src (gensym) 'buffer (string->immutable-string source-text)))
      ((api "lsp/source-controller/analysis-publisher.rkt" 'publish-document-analysis!) publisher sd snapshot product)
      (define published ((api "lsp/safedoc.rkt" 'SafeDoc-doc) sd))
      (check-equal? ((api "doclib/doc-lang.rkt" 'Language-Policy-body-mode)
                     ((api "doclib/doc.rkt" 'doc-language-policy) published)) 'non-sexp)
      (define range ((api "common/interfaces.rkt" 'jsexpr->Range)
                     (hasheq 'start (hasheq 'line 0 'character 0) 'end (hasheq 'line 2 'character 15))))
      (define options ((api "common/interfaces.rkt" 'jsexpr->FormattingOptions)
                       (hasheq 'tabSize 2 'insertSpaces #t)))
      (check-equal? ((api "doclib/doc.rkt" 'doc-format-edits) published range #:formatting-options options) '())))
  (test-case "an adapter changing inside its provider cannot return a selected profile"
    (with-project
     (lambda (root source files change)
       (display-to-file
        (format "#lang racket/base\n(require racket/file)\n(provide profile)\n(define (profile request data)\n (display-to-file \"\\n\" ~s #:exists 'append)\n '(profile (match (language racket/base))))\n"
                (path->string (car files)))
        (cadr files) #:exists 'truncate)
       (check-exn #rx"adapter changed during selection"
                  (lambda () (resolve-language-adapter source #:text text #:workspace root))))))
  (test-case "a descriptor changing during compilation cannot declare cached debugger code"
    (with-project
     (lambda (root source files change)
       (display-to-file
        (format "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ~s newline #:exists 'append))\n(provide answer)\n(define (answer) 42)\n"
                (path->string (car files)))
        source #:exists 'truncate)
       (check-exn #rx"language adapter changed during load"
                  (lambda ()
                    (run-module source #:instrument? #t #:workspace root
                                #:cache-directory (build-path root "cache") #:entry 'answer))))))
  (test-case "retained inspector queries refuse an edited descriptor"
    (with-project
     (lambda (root source files change)
       (call-with-macro-source
        (hasheq 'source (path->string source) 'sourceIsFile #t 'text text
                'mode "module" 'directory (path->string root) 'workspace root)
        (lambda (stx)
          (define inspector #f)
          (expansion-steps stx "none" #:schema-version 2
                           #:retain-inspector (lambda (query) (set! inspector query)))
          (check-not-false inspector)
          (change 'descriptor)
          (check-exn #rx"Language adapter changed"
                     (lambda () (inspector (hasheq 'mode "position" 'position 1))))))))))

(module+ test
  (test-case "a rejected analysis cannot replace the accepted trace fingerprint"
    (with-project
     (lambda (root source files change)
       (parameterize ([resolver (lambda (file source-text pre roots)
                                  (resolve-language-adapter file #:text source-text #:pre pre #:workspace root))]
                      [validator current?])
         (define doc (make-doc (path->uri source) text))
         (check-true (doc-expand! doc))
         (define trace
           (parameterize ([current-namespace (module->namespace 'racket-langserver/doclib/doc)])
             ((eval 'Doc-trace) doc)))
         (define accepted (send trace get-language-adapter))
         (define contribution (send trace get-contribution))
         (define policy ((api "doclib/doc.rkt" 'doc-language-policy) doc))
         (define containing (api "doclib/doc.rkt" 'doc-find-containing-paren))
         (define open (caar (regexp-match-positions #rx"\\(answer\\)" text)))
         (check-equal? (containing doc (+ open 2)) open)
         (display-to-file "((profile (match (language racket/base)) (editor (expand? #f) (body-mode non-sexp))))"
                          (car files) #:exists 'truncate)
         (check-false (latest? doc))
         (check-false (doc-expand! doc))
         (check-equal? (send trace get-contribution) contribution)
         (check-true (eq? (send trace get-language-adapter) accepted))
         (check-equal? ((api "doclib/doc.rkt" 'doc-language-policy) doc) policy)
         (check-equal? (containing doc (+ open 2)) open)
         (check-false (latest? doc))))))
  (test-case "an empty explicit descriptor changing during compilation rejects debugger code"
    (with-project
     (lambda (root source files change)
       (define explicit (build-path root "chosen.rktd"))
       (display-to-file "(profile)" explicit)
       (display-to-file
        (format "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ~s newline #:exists 'append))\n(provide answer)\n(define (answer) 42)\n"
                (path->string explicit))
        source #:exists 'truncate)
       (check-exn #rx"language adapter changed during load"
                  (lambda ()
                    (run-module source #:instrument? #t #:workspace root #:language-adapter explicit
                                #:cache-directory (build-path root "cache") #:entry 'answer))))))
  (test-case "publication rejection stops the waiter and schedules fresh analysis"
    (with-project
     (lambda (root source files change)
       (parameterize ([resolver (lambda (file source-text pre roots)
                                  (resolve-language-adapter file #:text source-text #:pre pre #:workspace root))]
                      [validator current?])
         (define doc (make-doc (path->uri source) text))
         (check-true (doc-expand! doc))
         (define trace
           (parameterize ([current-namespace (module->namespace 'racket-langserver/doclib/doc)])
             ((eval 'Doc-trace) doc)))
         (define product ((api "lsp/analysis.rkt" 'Analysis-Product)
                          #t ((api "lsp/analysis.rkt" 'Analysis-Summary) (hash) (hash))
                          '() trace (send trace get-contribution) #f))
         (define owner "lsp/source-controller/source-owner.rkt")
         (define controller ((api owner 'make-source-controller)
                             #:resyntax #f #:analyze (lambda (_) (sync never-evt))))
         (dynamic-wind void
           (lambda ()
             (define sd ((api "lsp/safedoc.rkt" 'new-safedoc) (path->uri source) text 0))
             (define src ((api "common/source.rkt" 'path->source) source))
             ((api owner 'source-controller-open!) controller src sd)
             (define pending ((api "lsp/safedoc.rkt" 'SafeDoc-analysis-completion) sd))
             (define snapshot ((api owner 'source-controller-snapshot) controller src))
             (define accept
               (parameterize ([current-namespace
                               (module->namespace 'racket-langserver/lsp/source-controller/source-owner)])
                 (eval 'accept-analysis-result!)))
             (define checks 0)
             (define outcome
               (parameterize ([validator
                               (lambda (adapter)
                                 (set! checks (add1 checks))
                                 (when (= checks 2) (change 'descriptor))
                                 (current? adapter))])
                 (accept controller snapshot 'analysis #f #f product)))
             (check-equal? ((api "lsp/analysis.rkt" 'Analysis-Outcome-state) outcome) 'stopped)
             (check-equal? ((api "lsp/analysis.rkt" 'Analysis-Outcome-value) outcome) 'dependency-changed)
             (check-false ((api "lsp/safedoc.rkt" 'SafeDoc-available) sd))
             (check-not-eq? ((api "lsp/safedoc.rkt" 'SafeDoc-analysis-completion) sd) pending))
           (lambda () ((api owner 'source-controller-shutdown!) controller))))))))
