#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; What the instrumenter hands back to the expander decides how long a program
;; takes to load. Its shape is checked here, without timing anything.
(require racket/list rackunit
         "../racketdap/instrumentation/instrument.rkt")

(define-namespace-anchor anchor)
(define namespace (namespace-anchor->namespace anchor))
(define (definition-rhs text)
  (parameterize ([current-namespace namespace])
    (define input (open-input-string (string-append "(module generated racket/base\n" text ")")))
    (port-count-lines! input)
    (define expanded (expand (read-syntax (string->path "/tmp/generated.rkt") input)))
    (for/or ([form (in-list (syntax->list (cadddr (syntax->list expanded))))])
      (syntax-case form (define-values)
        [(define-values (id) rhs) (eq? (syntax-e #'id) 'subject) #'rhs]
        [_ #f]))))
(define (instrumented text #:coverage? [coverage? #f])
  (parameterize ([current-namespace namespace])
    (define next 0)
    (define-values (annotated sites table)
      (instrument-module (definition-rhs text) (string->path "/tmp/generated.rkt")
                         (lambda () (set! next (add1 next)) next)
                         #:coverage? coverage?
                         #:module-context (make-module-binding-context)))
    annotated))
(define (nodes v)
  (cond [(syntax? v) (nodes (syntax-e v))]
        [(pair? v) (+ 1 (nodes (car v)) (nodes (cdr v)))]
        [else 1]))
;; Whether a generated expression is written entirely in core forms, so the
;; expander has no macro to apply to it. Reports the first form that is not.
(define (non-core expression)
  (define (each . expressions)
    (for/or ([e (in-list (flatten expressions))]) (non-core e)))
  (define (clauses groups bodies)
    (apply each (append (for/list ([group (in-list (syntax->list groups))])
                          (syntax-case group () [[ids rhs] #'rhs]))
                        (syntax->list bodies))))
  (define (lambda-clause clause)
    (syntax-case clause () [[formals body ...] (apply each (syntax->list #'(body ...)))]))
  (syntax-case* expression
    (quote quote-syntax #%variable-reference #%top #%plain-lambda case-lambda if begin begin0
           let-values letrec-values set! with-continuation-mark #%plain-app #%expression)
    free-identifier=?
    [id (identifier? #'id) #f]
    [(quote . _) #f]
    [(quote-syntax . _) #f]
    [(#%variable-reference . _) #f]
    [(#%top . _) #f]
    [(#%plain-lambda formals body ...) (apply each (syntax->list #'(body ...)))]
    [(case-lambda clause ...) (for/or ([c (in-list (syntax->list #'(clause ...)))]) (lambda-clause c))]
    [(if a b c) (each #'a #'b #'c)]
    [(begin e ...) (apply each (syntax->list #'(e ...)))]
    [(begin0 e ...) (apply each (syntax->list #'(e ...)))]
    [(let-values groups body ...) (clauses #'groups #'(body ...))]
    [(letrec-values groups body ...) (clauses #'groups #'(body ...))]
    [(set! id e) (non-core #'e)]
    [(with-continuation-mark a b c) (each #'a #'b #'c)]
    [(#%plain-app e ...) (apply each (syntax->list #'(e ...)))]
    [(#%expression e) (non-core #'e)]
    [_ expression]))
(define (long-function count)
  (string-append
   "(define (subject x)\n"
   (apply string-append
          (for/list ([j count]) (format "  (define v~a (+ x ~a (if (even? x) 1 2)))\n" j j)))
   (format "  (+ x v0 v~a))\n" (sub1 count))))
(define (nested-calls depth)
  (string-append
   "(define (f x) x)\n(define (subject y) "
   (apply string-append (make-list depth "(f "))
   "y" (make-string depth #\)) ")\n"))

(module+ test
  (test-case "generated code is written in core forms, so it has no macro to expand"
    (for ([text (list (long-function 5) (nested-calls 3)
                      "(define subject (let loop ([i 0]) (if (< i 3) (loop (add1 i)) (lambda (a [b 1]) (+ a b)))))"
                      "(define subject (with-handlers ([void void]) (for/list ([x '(1 2)]) (values x))))")])
      (check-false (non-core (instrumented text)) text)))
  (test-case "code grows in proportion to the depth of nested applications"
    (define (size depth) (nodes (instrumented (nested-calls depth))))
    (check-true (< (size 20) (* 3 (size 10)))))
  (test-case "code grows in proportion to the length of a body"
    (define (size count) (nodes (instrumented (long-function count))))
    (check-true (< (size 200) (* 2.2 (size 100))))))
