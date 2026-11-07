#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Select hiding policies and preserve binding identities in transported rules.
(require net/base64 racket/fasl
         macro-debugger/model/hiding-policies macro-debugger/model/reductions-util
         (only-in macro-debugger/model/deriv node? node-z1 node-z2)
         (only-in macro-debugger/model/deriv-util for-subnodes)
         "limits.rkt")
(provide prepare-hiding-policy custom-policy derivation-rule-context make-hiding-rule rule-identifier)

;; Rules carry a complete syntax context, plus a deterministic derivation
;; identity for restoring lexical scopes in a replacement worker. Neither
;; spelling nor source coordinates are used to reconstruct a binding.
(struct rule-context (origin root-name ids terms) #:transparent)
(define (derivation-rule-context derivation origin)
  (define ids (make-hasheq))
  (define terms null)
  (define root-name #f)
  (define (walk value)
    (cond [(syntax? value)
           (unless (hash-has-key? ids value)
             (hash-set! ids value (hash-count ids))
             (define source (syntax-source value))
             (define source-module (syntax-source-module value))
             (when (and (not root-name) (pair? origin)
                        (equal? (if (path? source) (path->string source) source) (car origin))
                        (module-path-index? source-module))
               (define-values (path base) (module-path-index-split source-module))
               (unless path
                 (define name (resolved-module-path-name (module-path-index-resolve source-module)))
                 (set! root-name (if (pair? name) (car name) name))))
             (set! terms (cons value terms))
             (walk (syntax-e value)))]
          [(pair? value) (walk (car value)) (walk (cdr value))]
          [(vector? value) (for-each walk (vector->list value))]
          [(box? value) (walk (unbox value))]))
  (let visit ([node derivation])
    (when node
      (when (node? node)
        (walk (node-z1 node)) (walk (node-z2 node)))
      (for-subnodes node #:recur visit #:recur/phase-up visit)))
  (rule-context origin root-name ids (list->vector (reverse terms))))
(define (rule-identifier rule context)
  (define index (hash-ref rule 'index #f))
  (cond [(and context (equal? (hash-ref rule 'origin #f) (rule-context-origin context))
              (exact-nonnegative-integer? index) (< index (vector-length (rule-context-terms context))))
         (vector-ref (rule-context-terms context) index)]
        [else
         (define base (hash-ref rule 'base #f))
         (define root
           (and (pair? base)
                (if (complete-path? (car base)) `(file ,(car base)) `(quote ,(string->symbol (car base))))))
         (syntax-deserialize
          (fasl->s-exp (base64-decode (string->bytes/utf-8 (hash-ref rule 'syntax))))
          #:base-module-path-index
          (and root (module-path-index-join
                     (if (null? (cadr base)) root `(submod ,root ,@(map string->symbol (cadr base)))) #f)))]))
(define (source-module-index source [submodules null])
  (define root (if (complete-path? source) `(file ,source) `(quote ,(string->symbol source))))
  (module-path-index-join (if (null? submodules) root `(submod ,root ,@submodules)) #f))
(define (context-self? mpi context)
  (define name (resolved-module-path-name (module-path-index-resolve mpi)))
  (and context (eq? (if (pair? name) (car name) name) (rule-context-root-name context))))
(define (context-module mpi context)
  (if (and context (pair? (rule-context-origin context)))
      (let replace ([mpi mpi])
        (define-values (path base) (module-path-index-split mpi))
        (cond [(not path)
               (define name (resolved-module-path-name (module-path-index-resolve mpi)))
               (if (context-self? mpi context)
                   (source-module-index (car (rule-context-origin context)) (if (pair? name) (cdr name) null)) mpi)]
              [(module-path-index? base) (module-path-index-join path (replace base))]
              [else mpi]))
      mpi))
(define (rule-binding=? identifier rule context phase [target (rule-identifier rule context)])
  (or (free-identifier=? identifier target phase)
      ;; File imports in another view and this view's self index denote the
      ;; same source module. Compare them after giving self its source identity.
      ;; The full selected syntax still supplies every phase's binding facts.
      (let ([a (identifier-binding identifier phase)] [b (identifier-binding target phase)])
        (and (list? a) (>= (length a) 5) (list? b) (>= (length b) 5)
             (eq? (cadr a) (cadr b)) (equal? (list-ref a 4) (list-ref b 4))
             (equal? (module-path-index-resolve (context-module (car a) context))
                     (module-path-index-resolve
                      (if (and context (equal? (hash-ref rule 'origin #f) (rule-context-origin context))
                               (exact-nonnegative-integer? (hash-ref rule 'index #f)))
                          (context-module (car b) context) (car b))))))))
(define (custom-policy settings context)
  (unless (and (hash? settings)
               (andmap (lambda (key) (boolean? (hash-ref settings key 'missing)))
                       '(enabled racket library contracts phase))
               (list? (hash-ref settings 'rules #f)))
    (incompatible "Invalid Custom hiding policy."))
  (define rules (hash-ref settings 'rules))
  (define targets (map (lambda (rule) (rule-identifier rule context)) rules))
  (for ([rule rules] [target targets])
    (unless (and (identifier? target) (member (hash-ref rule 'action) '("show" "hide")))
      (incompatible "Invalid macro hiding rule.")))
  (define base
    (policy->predicate (list 'custom (hash-ref settings 'racket) (hash-ref settings 'library)
                            (hash-ref settings 'contracts) (hash-ref settings 'phase) null)))
  (if (not (hash-ref settings 'enabled)) hide-none-policy
      (lambda (identifier)
        (let loop ([rules rules] [targets targets])
          (cond [(null? rules) (base identifier)]
                [(rule-binding=? identifier (car rules) context (the-phase) (car targets))
                 (equal? (hash-ref (car rules) 'action) "show")]
                [else (loop (cdr rules) (cdr targets))])))))
(define (make-hiding-rule identifier query context)
  (define binding (identifier-binding identifier 0))
  ;; An expansion's anonymous self module is meaningful only in its namespace.
  ;; Give that base the captured source identity when syntax crosses workers;
  ;; imported bindings keep their original definition and complete import chain.
  (define source-module (syntax-source-module identifier))
  (define self-module
    (and context (pair? (rule-context-origin context)) (module-path-index? source-module)
         (let-values ([(path base) (module-path-index-split source-module)])
           (and (not path) (context-self? source-module context) source-module))))
  (define base
    (and self-module
         (let ([name (resolved-module-path-name (module-path-index-resolve self-module))])
           (list (car (rule-context-origin context))
                 (if (pair? name) (map symbol->string (cdr name)) null)))))
  (define description
    (if (and (list? binding) (>= (length binding) 4))
        (let-values ([(path base) (module-path-index-split (list-ref binding 2))])
          (format "'~a' ~a" (list-ref binding 3)
                  (if path (string-append "imported from " (format "~s" path))
                      "defined in this module")))
        (symbol->string (syntax-e identifier))))
  (define label (string-append (hash-ref query 'action) " " description))
  (hasheq 'id (hash-ref query 'id) 'action (hash-ref query 'action)
          'label (if (> (string-length label) 200) (string-append (substring label 0 197) "...") label)
          'origin (and context (rule-context-origin context))
          'index (if context (hash-ref (rule-context-ids context) identifier 'null) 'null)
          'base (or base 'null)
          'syntax (bytes->string/utf-8
                   (base64-encode (s-exp->fasl (syntax-serialize identifier #:provides-namespace #f
                                                               #:base-module-path-index self-module)) #""))
          'replaces (for/list ([rule (hash-ref query 'rules null)]
                              #:when (rule-binding=? identifier rule context 0))
                      (hash-ref rule 'id))))

(define (prepare-hiding-policy stx hiding lines)
  ;; Implicit identifiers such as #%datum can inherit a literal's source location.
  (define written (make-hasheqv))
  (when (equal? hiding "line")
    (let collect ([term stx])
      (cond [(identifier? term) (hash-set! written (syntax-position term) (syntax-e term))]
            [(syntax? term) (collect (syntax-e term))]
            [(pair? term) (collect (car term)) (collect (cdr term))]
            [(vector? term) (for-each collect (vector->list term))]
            [(box? term) (collect (unbox term))])))
  (lambda (custom context)
    (cond [(equal? hiding "none") hide-none-policy]
          [(equal? hiding "custom") (custom-policy custom context)]
          [(equal? hiding "line")
           (lambda (id)
             (or (standard-policy id)
                 (and lines (equal? (syntax-source id) (syntax-source stx))
                      (syntax-line id)
                      (<= (car lines) (syntax-line id) (cadr lines))
                      (eq? (syntax-e id) (hash-ref written (syntax-position id) #f)))))]
          [else standard-policy])))
