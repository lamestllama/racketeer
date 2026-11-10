#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require htdp/bsl/runtime)
(provide interactions)

;; Use the installed reader's options, including the distinction between
;; constructor lists and list abbreviations. Configuration supplies conversion
;; and pretty-printing parameters as well as the global port handler.
(define (interactions request level)
  (define options
    (dynamic-require
     (case level
       [(bsl) 'htdp/bsl/lang/reader]
       [(bsl+) 'htdp/bsl+/lang/reader]
       [(isl) 'htdp/isl/lang/reader]
       [(isl+) 'htdp/isl+/lang/reader]
       [(asl) 'htdp/asl/lang/reader]
       [else (error 'bootstrap "Unknown teaching level: ~a" level)])
     'options))
  ;; Module configuration adds procedure-printing flags beyond reader grammar.
  ;; Keep those installed level defaults in the isolated preview context too.
  (define print-options
    (append options
            (if (memq level '(bsl bsl+ isl)) '(output-function-instead-of-lambda) '())
            (if (memq level '(isl asl)) '(use-function-output-syntax) '())))
  (define enter (hash-ref (hash-ref request 'hooks) 'call-with-interaction-context))
  (hasheq
   ;; The configured REPL reader sets a mutable flag whose evaluator resets
   ;; programme tests. Reading syntax directly preserves its reader grammar
   ;; without entering that REPL protocol.
   'read-interaction
   (lambda (source in)
     (parameterize ([read-decimal-as-inexact #f]
                    [read-accept-dot #f]
                    [read-accept-quasiquote (and (memq 'read-accept-quasiquote options) #t)])
       (read-syntax source in)))
   'call-with-interaction-context enter
   'print
   (lambda (value out)
     (configure print-options)
     ((global-port-print-handler) value out))))
