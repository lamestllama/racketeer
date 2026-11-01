#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/port racket/string racket/list)
(provide read-expression (struct-out expression) (struct-out breakpoint-rule)
         compile-breakpoint-rule render-log-message)

(struct expression (form) #:transparent)
(struct breakpoint-rule (condition hit? log) #:transparent)
(define (with-safe-reader thunk)
  (parameterize ([read-accept-reader #f] [read-accept-lang #f] [read-accept-compiled #f])
    (thunk)))
(define (read-expression text #:source [source #f])
  (with-safe-reader
   (lambda ()
     (define in (if source (open-input-string text source) (open-input-string text)))
     (when source (port-count-lines! in))
     (define form (read in))
     (when (or (eof-object? form) (not (eof-object? (read in))))
       (error 'evaluate "Enter one Racket expression."))
     form)))
(define (nonblank? text) (and text (not (string=? (string-trim text) ""))))
(define (compile-hit text)
  (cond
    [(not (nonblank? text)) (lambda (_) #t)]
    [else
     (define match (regexp-match #px"^\\s*(>=|<=|==|=|>|<|%)?\\s*([1-9][0-9]*)\\s*$" text))
     (unless match (error 'hit-count "Use N, =N, >=N, >N, <=N, <N, or %N with a positive integer."))
     (define n (string->number (caddr match)))
     (define op (cadr match))
     (cond [(equal? op ">=") (lambda (hits) (>= hits n))]
           [(equal? op ">") (lambda (hits) (> hits n))]
           [(equal? op "<=") (lambda (hits) (<= hits n))]
           [(equal? op "<") (lambda (hits) (< hits n))]
           [(equal? op "%") (lambda (hits) (zero? (remainder hits n)))]
           [else (lambda (hits) (= hits n))])]))
(define (parse-log text)
  (with-safe-reader
   (lambda ()
     (define in (open-input-string text))
     (define out (open-output-string))
     (let loop ([parts '()])
       (define char (read-char in))
       (cond
         [(eof-object? char) (reverse (cons (get-output-string out) parts))]
         [(and (memv char '(#\{ #\})) (eqv? char (peek-char in)))
          (read-char in) (write-char char out) (loop parts)]
         [(eqv? char #\{)
          (define form (read in))
          (let whitespace ()
            (when (and (char? (peek-char in)) (char-whitespace? (peek-char in)))
              (read-char in) (whitespace)))
          (unless (and (not (eof-object? form)) (eqv? (read-char in) #\}))
            (error 'logpoint "Each {…} must contain one Racket expression."))
          (define literal (get-output-string out))
          (set! out (open-output-string))
          (loop (cons (expression form) (cons literal parts)))]
         [(eqv? char #\}) (error 'logpoint "Use }} for a literal closing brace.")]
         [else (write-char char out) (loop parts)])))))
(define (compile-breakpoint-rule request)
  (define condition (hash-ref request 'condition #f))
  (define log (hash-ref request 'logMessage #f))
  (breakpoint-rule (and (nonblank? condition) (expression (read-expression condition)))
                   (compile-hit (hash-ref request 'hitCondition #f))
                   (and log (parse-log log))))
(define (render-log-message parts evaluate preview)
  (string-append
   (apply string-append
          (for/list ([part (in-list parts)])
            (if (string? part) part
                (let ([results (call-with-values (lambda () (evaluate (expression-form part))) list)])
                  (if (null? results) "#<zero values>"
                      (string-join (map preview (take results (min 10 (length results)))) ", "))))))
   "\n"))
