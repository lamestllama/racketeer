#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class racket/runtime-path
         "../vendor/collects/racket-langserver/doclib/editor.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/doclib/service/tail.rkt"
         drracket/check-syntax)

;; Documents need the bundled packages, which are not installed as collections.
(define-runtime-path bundled "../vendor/collects")
(define (server-api file name)
  (parameterize ([current-library-collection-paths
                  (cons bundled (current-library-collection-paths))])
    (dynamic-require (build-path bundled "racket-langserver" file) name)))

(module+ test
  (test-case "UTF-16 positions and incremental replacements preserve characters"
    (define editor (new lsp-editor%))
    (send editor insert "a😀λ\r\nz🙂\n" 0)
    (check-equal? (send editor lsp-position->pos 0 3) 2)
    (check-equal? (send editor pos->line/char 2) '(0 3))
    (check-equal? (send editor pos->line/char 7) '(1 3))
    (check-equal? (send editor lsp-position->pos 1 3) 7)
    (check-equal? (send editor lsp-position->pos 1 100) 7)
    (define original (send editor copy))
    (send editor replace "X" (send editor lsp-position->pos 0 1) (send editor lsp-position->pos 0 3))
    (check-equal? (send editor get-text) "aXλ\r\nz🙂\n")
    (check-equal? (send original get-text) "a😀λ\r\nz🙂\n")
    (check-equal? (send editor pos->line/char 7) '(1 3))
    (check-equal? (send editor pos->line/char 2) '(0 2)))

  (test-case "a protocol column past a line's end names the line's end, not the next line"
    (define make-source-doc (server-api "doclib/doc.rkt" 'make-source-doc))
    (define doc-pos->abs-pos (server-api "doclib/doc.rkt" 'doc-pos->abs-pos))
    (define doc-apply-edit! (server-api "doclib/doc.rkt" 'doc-apply-edit!))
    (define doc-get-text (server-api "doclib/doc.rkt" 'doc-get-text))
    (define path->source (server-api "common/source.rkt" 'path->source))
    (define jsexpr->Pos (server-api "common/interfaces.rkt" 'jsexpr->Pos))
    (define jsexpr->Range (server-api "common/interfaces.rkt" 'jsexpr->Range))
    (define ->jsexpr (server-api "common/json-util.rkt" '->jsexpr))
    (define (position line character) (jsexpr->Pos (hasheq 'line line 'character character)))
    (define (range start end)
      (jsexpr->Range (hasheq 'start (->jsexpr start) 'end (->jsexpr end))))
    (define document
      (make-source-doc (path->source (build-path (current-directory) "columns.rkt")) "a😀b\nkeep\n"))
    (check-equal? (doc-pos->abs-pos document (position 0 10)) 3)
    (doc-apply-edit! document (range (position 0 0) (position 0 6)) "X")
    (check-equal? (doc-get-text document) "X\nkeep\n"))

  (test-case "tail anchors include their operator and exclude arguments"
    (define service (new tail% [src 'source]
                         [lexer-state (build-lexer-state "(define (f x) (f x))" #f)]))
    (send service syncheck:add-tail-arrow 'source 0 'source 14)
    (send service syncheck:add-tail-arrow 'source 0 'source 14)
    (check-equal? (call-with-values (lambda () (send service at 15)) list) '(14 16 (0) ()))
    (check-equal? (call-with-values (lambda () (send service at 17)) list) '(#f #f () ()))
    (check-equal? (call-with-values (lambda () (send service at 1)) list) '(0 7 () (14))))

  (test-case "tail facts reject foreign sources and clear after any source edit"
    (define service (new tail% [src 'source]
                         [lexer-state (build-lexer-state "(define (f x) (f x))" #f)]))
    (send service syncheck:add-tail-arrow 'other 0 'source 14)
    (send service syncheck:add-tail-arrow 'source 0 'source 1000)
    (check-equal? (call-with-values (lambda () (send service at 15)) list) '(#f #f () ()))
    (send service syncheck:add-tail-arrow 'source 0 'source 14)
    (send service text-replaced 19 19)
    (check-equal? (call-with-values (lambda () (send service at 15)) list) '(#f #f () ())))

  (test-case "comments and nested operators do not turn argument identifiers into anchors"
    (define service (new tail% [src 'source]
                         [lexer-state (build-lexer-state "(define (f x) (#; ignored f x))" #f)]))
    (send service syncheck:add-tail-arrow 'source 0 'source 14)
    (check-equal? (call-with-values (lambda () (send service at 14)) list) '(14 15 (0) ()))
    (check-equal? (call-with-values (lambda () (send service at 18)) list) '(#f #f () ()))))
