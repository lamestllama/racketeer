#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/port racket/string racket/list)
(provide read-expression resolve-expression (struct-out expression) (struct-out breakpoint-rule)
         compile-breakpoint-rule render-log-message)

(struct expression (form) #:transparent)
(struct breakpoint-rule (condition hit? log) #:transparent)
(struct pending-expression (text cache) #:transparent)
(define (with-safe-reader thunk)
  (parameterize ([read-accept-reader #f] [read-accept-lang #f] [read-accept-compiled #f])
    (thunk)))
(define (read-native text source choices)
  (define in (open-input-string text source))
  (port-count-lines! in)
  (define reader (hash-ref choices 'read-interaction))
  (with-safe-reader
   (lambda ()
     (define term (reader source in))
     (unless (and (syntax? term) (eof-object? (reader source in)))
       (error 'evaluate "Enter one language interaction."))
     term)))
(define (lower term choices lexical-identifier)
  (define bridge (hash-ref choices 'lower #f))
  (define form
    (if bridge
        (bridge (hasheq 'operation 'expression 'term term
                        'hooks (hasheq 'lexical-identifier lexical-identifier)))
        term))
  (unless (syntax? form) (error 'expressions "The expression provider must return syntax."))
  form)
(define (read-expression text #:source [source #f] #:expressions [choices #f]
                         #:lexical-identifier [lexical-identifier (lambda (_) #f)])
  (cond
    [choices (lower (read-native text source choices) choices lexical-identifier)]
    [else
     (with-safe-reader
      (lambda ()
        (define in (if source (open-input-string text source) (open-input-string text)))
        (when source (port-count-lines! in))
        (define form (read in))
        (when (or (eof-object? form) (not (eof-object? (read in))))
          (error 'evaluate "Enter one Racket expression."))
        form))]))
;; Cache only the read interaction in its module/adapter context. Lowering can
;; ask for identifiers from a different recursive activation on each hit.
(define (resolve-expression form #:expressions [choices #f]
                            #:context [context choices]
                            #:lexical-identifier [lexical-identifier (lambda (_) #f)])
  (cond
    [(pending-expression? form)
     (define term
       (hash-ref! (pending-expression-cache form) context
                  (lambda ()
                    (if choices
                        (read-native (pending-expression-text form) #f choices)
                        (read-expression (pending-expression-text form))))))
     (if choices (lower term choices lexical-identifier) term)]
    [else form]))
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
(define (compile-breakpoint-rule request #:defer? [defer? #f])
  (define (parse text)
    (if defer? (pending-expression text (make-hasheq)) (read-expression text)))
  (define condition (hash-ref request 'condition #f))
  (define log (hash-ref request 'logMessage #f))
  (define segments (hash-ref request 'logSegments #f))
  (when (and segments log) (error 'logpoint "Use logMessage or logSegments, not both."))
  (define parts
    (and segments
         (begin
           (unless (list? segments) (error 'logpoint "logSegments must be an array."))
           (for/list ([part (in-list segments)])
             (cond [(string? part) part]
                   [(and (hash? part) (= (hash-count part) 1)
                         (string? (hash-ref part 'expression #f)))
                    (expression (pending-expression (hash-ref part 'expression) (make-hasheq)))]
                   [else (error 'logpoint "Each segment must be text or an expression record.")])))))
  (breakpoint-rule (and (nonblank? condition) (expression (parse condition)))
                   (compile-hit (hash-ref request 'hitCondition #f))
                   (or parts (and log (parse-log log)))))
(define (render-log-message parts evaluate preview)
  (string-append
   (apply string-append
          (for/list ([part (in-list parts)])
            (if (string? part) part
                (let ([results (call-with-values (lambda () (evaluate (expression-form part))) list)])
                  (if (null? results) "#<zero values>"
                      (string-join (map preview (take results (min 10 (length results)))) ", "))))))
   "\n"))
