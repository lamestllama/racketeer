#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class
         "../vendor/collects/racket-langserver/doclib/editor.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/doclib/service/tail.rkt"
         drracket/check-syntax)

(module+ test
  (test-case "UTF-16 positions and incremental replacements preserve characters"
    (define editor (new lsp-editor%))
    (send editor insert "a😀λ\r\nz🙂\n" 0)
    (check-equal? (send editor line/char->pos 0 3) 2)
    (check-equal? (send editor pos->line/char 2) '(0 3))
    (check-equal? (send editor pos->line/char 7) '(1 3))
    (check-equal? (send editor line/char->pos 1 3) 7)
    (define original (send editor copy))
    (send editor replace "X" (send editor line/char->pos 0 1) (send editor line/char->pos 0 3))
    (check-equal? (send editor get-text) "aXλ\r\nz🙂\n")
    (check-equal? (send original get-text) "a😀λ\r\nz🙂\n")
    (check-equal? (send editor pos->line/char 7) '(1 3))
    (check-equal? (send editor pos->line/char 2) '(0 2)))

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
