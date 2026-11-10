#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list syntax/modresolve)
(provide declarations calls completion)

(define (parts value) (or (and (syntax? value) (syntax->list value)) '()))
(define (range value)
  (and (syntax? value) (syntax-position value) (syntax-span value)
       (cons (sub1 (syntax-position value))
             (+ (sub1 (syntax-position value)) (syntax-span value)))))
(define (declarations request _level)
  (define text (hash-ref request 'text))
  (define known
    (map (lambda (b) (hash-ref b 'range)) (hash-ref (hash-ref request 'facts) 'bindings '())))
  (define (written value)
    (define r (range value))
    (string->immutable-string (substring text (car r) (cdr r))))
  (define (record name kind form children [parameters #f] [signature-label #f])
    (hasheq 'name (written name) 'kind kind 'selection (range name) 'range (range form)
            'certainty (if (member (range name) known) 'confirmed 'predicted)
            'children children
            'signatures
            (if parameters
                (list (hasheq 'label (or signature-label
                                    (string->immutable-string
                                     (string-append "(" (written name)
                                                    (apply string-append
                                                           (map (lambda (p) (string-append " " (written p))) parameters))
                                                    ")")))
                              'parameters (map (lambda (p) (hasheq 'label (written p))) parameters)))
                '())))
  (define (walk value)
    (define xs (parts value))
    (cond [(or (null? xs) ((hash-ref request 'cancelled?))) '()]
          [(memq (syntax-e (car xs)) '(quote quasiquote)) '()]
          [(and (eq? (syntax-e (car xs)) 'define) (= (length xs) 3))
           (define header (parts (cadr xs)))
           (define name (if (pair? header) (car header) (cadr xs)))
           (define rhs (parts (caddr xs)))
           (define function? (or (pair? header) (and (pair? rhs) (memq (syntax-e (car rhs)) '(lambda λ)))))
           (if (and (identifier? name) (range name) (range value))
               (list (record name (if function? 'function 'variable) value (walk (caddr xs))
                             (cond [(pair? header) (cdr header)]
                                   [(and function? (>= (length rhs) 3)) (parts (cadr rhs))]
                                   [else #f])
                             (and (pair? header) (written (cadr xs))))) '())]
          [(and (eq? (syntax-e (car xs)) 'define-struct) (= (length xs) 3))
           (list (record (cadr xs) 'struct value
                         (map (lambda (f) (record f 'field f '())) (parts (caddr xs)))))]
          [else (append-map walk xs)]))
  (walk (hash-ref request 'pre)))

(define (calls request _level)
  (define pre (hash-ref request 'pre #f))
  (cond [pre
         (define (walk value)
           (define xs (parts value))
           (cond [(or (null? xs) (memq (syntax-e (car xs)) '(quote quasiquote))) '()]
                 [else
                  (append (if (and (identifier? (car xs)) (range value) (range (car xs)))
                              (list (hasheq 'range (range value) 'callee (range (car xs))
                                            'arguments (filter-map range (cdr xs)))) '())
                          (append-map walk xs))]))
         (walk pre)]
        [else
         (define pos (hash-ref request 'position))
         (define candidates
           (filter (lambda (c) (define r (hash-ref c 'range)) (< (car r) pos (cdr r)))
                   (hash-ref (hash-ref request 'facts) 'calls '())))
         (define call (and (pair? candidates) (argmin (lambda (c) (define r (hash-ref c 'range)) (- (cdr r) (car r))) candidates)))
         (define declaration
           (and call ((hash-ref (hash-ref request 'hooks) 'declaration-at) (car (hash-ref call 'callee)))))
         (and declaration
              (hasheq 'callee (hash-ref call 'callee)
                      'argument (count (lambda (r) (< (cdr r) pos)) (hash-ref call 'arguments))
                      'signatures (hash-ref declaration 'signatures '())))]))

;; Completion is derived once from the current reader tree. Redirected storage
;; has coarse expanded scopes, so retain the written lexical regions here.
(define (completion request level)
  (define pre (hash-ref request 'pre #f))
  (cond
    [pre
     (define text (hash-ref request 'text))
     (define pos (hash-ref request 'position))
     (define candidates '())
     (define scopes (make-hash))
     (define imports '())
     (define in-require? #f)
     (define (add! id scope)
       (when (and (identifier? id) (range id))
         (hash-set! scopes (range id) scope)
         (set! candidates (cons (cons (symbol->string (syntax-e id)) scope) candidates))))
     (define (walk value scope)
       (define xs (parts value))
       (unless (or (null? xs) ((hash-ref request 'cancelled?)))
         (case (syntax-e (car xs))
           [(quote quasiquote) (void)]
           [(require)
            (define r (range value))
            (when (and r (<= (car r) pos (cdr r))) (set! in-require? #t))
            (when (= (length xs) 2) (set! imports (cons (syntax->datum (cadr xs)) imports)))]
           [(define)
            (when (= (length xs) 3)
              (define header (parts (cadr xs)))
              (add! (if (pair? header) (car header) (cadr xs)) scope)
              (for ([p (in-list (if (pair? header) (cdr header) '()))])
                (add! p (range (caddr xs))))
              (walk (caddr xs) scope))]
           [(define-struct)
            (when (= (length xs) 3)
              (add! (cadr xs) scope)
              (for ([p (in-list (parts (caddr xs)))])
                (hash-set! scopes (range p) scope)))]
           [(local)
            (for ([part (in-list (cdr xs))]) (walk part (range value)))]
           [(lambda λ)
            (when (>= (length xs) 3)
              (for ([p (in-list (parts (cadr xs)))]) (add! p (range value)))
            (for ([part (in-list (cddr xs))]) (walk part scope)))]
           [(let let* letrec)
            (when (>= (length xs) 3)
              (define bindings (parts (cadr xs)))
              (for ([clause (in-list bindings)])
                (define pair (parts clause))
                (when (= (length pair) 2)
                  (define visibility
                    (case (syntax-e (car xs))
                      [(letrec) (range value)]
                      [(let*) (cons (cdr (range (cadr pair))) (cdr (range value)))]
                      [else (cons (car (range (caddr xs))) (cdr (range value)))]))
                  (add! (car pair) visibility)
                  (walk (cadr pair) scope)))
              (for ([body (in-list (cddr xs))]) (walk body scope)))]
           [else (for ([part (in-list xs)]) (walk part scope))])))
     (walk pre (cons 0 (string-length text)))
     ;; Component facts retain the actual public procedure names, including
     ;; constructors and selectors, at their written declaration ranges.
     (for ([name (in-list (hash-ref (hash-ref request 'facts) 'names '()))]
           #:when (and (eq? (hash-ref name 'role) 'definition)
                       (hash-has-key? scopes (hash-ref name 'range))))
       (define id (hash-ref name 'identifier #f))
       (define label (if id (syntax-e id) (hash-ref name 'name #f)))
       (when (symbol? label)
         (set! candidates (cons (cons (symbol->string label) (hash-ref scopes (hash-ref name 'range))) candidates))))
     (define language
       (case level [(bsl) 'lang/htdp-beginner]
             [(bsl+) 'lang/htdp-beginner-abbr] [(isl) 'lang/htdp-intermediate]
             [(isl+) 'lang/htdp-intermediate-lambda]
             [(asl) 'lang/htdp-advanced]
         [else (error 'completion "Unknown teaching level: ~a" level)]))
     (define (exports-from module)
       (define-values (values syntax) (module->exports module))
       (append-map (lambda (g) (map (lambda (entry) (symbol->string (car entry))) (cdr g)))
                   (filter (lambda (g) (equal? (car g) 0)) (append values syntax))))
     (dynamic-require language (void))
     (define exports
       (append (exports-from language)
               ;; Declare dependencies in a fresh registry, without running
               ;; their bodies or retaining an older document's exports.
               (parameterize ([current-namespace (make-base-namespace)])
                 (append-map
                  (lambda (spec)
                    (define module (resolve-module-path spec (syntax-source pre)))
                    (unless (module-declared? module #t) (error 'completion "Unavailable import: ~s" spec))
                    (exports-from module)) imports))))
     (define labels
       (sort (remove-duplicates
              (append exports (for/list ([entry (in-list candidates)]
                                         #:when (<= (cadr entry) pos (cddr entry))) (car entry)))) string<?))
     (define start
       (let loop ([i pos])
         (if (and (positive? i) (not (or (char-whitespace? (string-ref text (sub1 i)))
                       (memv (string-ref text (sub1 i)) '(#\( #\) #\[ #\] #\{ #\})))))
             (loop (sub1 i)) i)))
     (and (not in-require?)
          (hasheq 'range (cons start pos) 'prefix (substring text start pos)
             'items (map (lambda (label) (hasheq 'label (string->immutable-string label))) labels)
                  'incomplete? #f))]
    [else
     (define pos (hash-ref request 'position))
     (for/first ([cached (in-list (hash-ref (hash-ref request 'facts) 'completion '()))]
                 #:when (= pos (cdr (hash-ref cached 'range)))) cached)]))
