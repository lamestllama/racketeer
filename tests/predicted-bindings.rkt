#lang racket/base
(require rackunit racket/class drracket/check-syntax
         "../vendor/collects/racket-langserver/doclib/editor.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/doclib/service/hover/service.rkt")

(module+ test
  (define (make-service)
    (define text "(define value 1) #'value value")
    (define editor (new lsp-editor%))
    (send editor insert text 0)
    (new hover% [src 'source] [doc-text editor] [lexer-state (build-lexer-state text #f)]))
  (define (arrow service actual? [start 8] [phase 0] [left 19] [right 24] [source 'source])
    (send service syncheck:add-arrow/name-dup 'source start (+ start 5)
          source left right actual? phase #f (lambda (_) #f)))
  (define (at service position)
    (call-with-values (lambda () (send service predicted-binding-at position)) list))

  (test-case "prediction marks only the reported use"
    (define service (make-service))
    (arrow service #f)
    (check-equal? (at service 20) '(19 24 predicted))
    (check-equal? (at service 8) '(#f #f #f))
    (check-equal? (at service 25) '(#f #f #f)))
  (test-case "confirmation supersedes the same prediction in either callback order"
    (for ([order '((#f #t) (#t #f))])
      (define service (make-service))
      (for ([actual? order]) (arrow service actual?))
      (check-equal? (at service 20) '(#f #f #f))))
  (test-case "confirming another binding does not confirm a prediction"
    (define service (make-service))
    (arrow service #f)
    (arrow service #t 9)
    (check-equal? (at service 20) '(19 24 mixed)))
  (test-case "expansion phases retain distinct binding identities"
    (define service (make-service))
    (arrow service #f 8 0)
    (arrow service #t 8 1)
    (check-equal? (at service 20) '(19 24 mixed)))
  (test-case "overlapping source spans keep the uncertainty local"
    (define service (make-service))
    (arrow service #t 8 0 19 24)
    (arrow service #f 9 0 20 22)
    (check-equal? (at service 19) '(#f #f #f))
    (check-equal? (at service 20) '(20 22 mixed))
    (check-equal? (at service 23) '(#f #f #f)))
  (test-case "foreign, empty and invalid ranges cannot mark the document"
    (define service (make-service))
    (arrow service #f 8 0 19 24 'other)
    (arrow service #f 8 0 19 19)
    (arrow service #f 8 0 19 1000)
    (check-equal? (at service 20) '(#f #f #f)))
  (test-case "any edit or reset clears predictions"
    (define service (make-service))
    (arrow service #f)
    (send service text-replaced 0 0)
    (check-equal? (at service 20) '(#f #f #f))
    (arrow service #f)
    (send service reset)
    (check-equal? (at service 20) '(#f #f #f))))
