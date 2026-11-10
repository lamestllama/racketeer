#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list syntax/kerncase stepper/private/syntax-property)
(provide bindings)

;; First-order transformers and returned structure procedures retain explicit
;; scoped edges in generic facts. A structure's component directives identify
;; its generated procedures independently of their printed names.
(define (bindings request level)
  (define facts (or (hash-ref request 'facts #f) (hasheq)))
  (define pre (hash-ref request 'pre #f))
  (define src (and pre (syntax-source pre)))
  (define cancelled? (hash-ref request 'cancelled? (lambda () #f)))
  (define binders (hash-ref facts 'binders '()))
  (define components (hash-ref facts 'components '()))
  (define type-owners (make-hash))
  (define (range value)
    (and (syntax? value) (syntax-position value) (syntax-span value)
         (positive? (syntax-span value))
         (cons (sub1 (syntax-position value))
               (+ (sub1 (syntax-position value)) (syntax-span value)))))
  ;; Local expansion flattens away component directives. The fixed teaching
  ;; grammar still identifies each written structure declaration. Match only
  ;; its retained scoped definitions at that complete declaration, then apply
  ;; the installed structure form's constructor, predicate and field grammar.
  ;; A similarly spelt use or a definition elsewhere supplies no ownership.
  (define (local-components value)
    (define xs (and (syntax? value) (syntax->list value)))
    (when (pair? xs)
      (cond
        [(memq (syntax-e (car xs)) '(quote quasiquote)) (void)]
        [(and (eq? (syntax-e (car xs)) 'define-struct) (= (length xs) 3))
         (define type (cadr xs))
         (define fields (syntax->list (caddr xs)))
         (define type-owner
           (for/first ([entry (in-list (hash-ref facts 'names '()))]
                       #:when (and (eq? (hash-ref entry 'role) 'definition)
                                   (equal? (hash-ref entry 'range) (range type))
                                   (eq? (syntax-e (hash-ref entry 'identifier)) (syntax-e type))))
             (hash-ref entry 'identifier)))
         (when type-owner (hash-set! type-owners (range type) type-owner))
         (define type-text (symbol->string (syntax-e type)))
         (define (component! name target offset)
           (for ([entry (in-list (hash-ref facts 'names '()))]
                 #:when (and (eq? (hash-ref entry 'role) 'definition)
                             (equal? (hash-ref entry 'range) (range value))
                             (equal? (syntax-source (hash-ref entry 'identifier)) src)
                             (eq? (identifier-binding (hash-ref entry 'identifier)) 'lexical)
                             (eq? (syntax-e (hash-ref entry 'identifier)) name)))
             (set! components
                   (cons (hasheq 'identifier (hash-ref entry 'identifier)
                                 'target (if (and (eq? target type) type-owner) type-owner target)
                                 'range (range target) 'offset offset 'width (syntax-span target))
                         components))))
         (component! (string->symbol (string-append "make-" type-text)) type 5)
         (component! (string->symbol (string-append type-text "?")) type 0)
         (for ([field (in-list fields)])
           (define suffix (symbol->string (syntax-e field)))
           (define selector (string->symbol (string-append type-text "-" suffix)))
           (component! selector type 0)
           (component! selector field (add1 (string-length type-text)))
           (when (eq? level 'asl)
             (define setter (string->symbol (string-append "set-" type-text "-" suffix "!")))
             (component! setter type 4)
             (component! setter field (+ 5 (string-length type-text)))))]
        [else (for-each local-components xs)])))
  (when pre (local-components pre))
  (set! components (remove-duplicates components))
  (define groups '())
  (define (same? a b) (free-identifier=? a b 0))
  (define (join! ids)
    (define connected
      (filter (lambda (group)
                (for/or ([a (in-list group)]) (ormap (lambda (b) (same? a b)) ids))) groups))
    (unless (and (= (length connected) 1)
                 (andmap (lambda (id) (ormap (lambda (member) (same? id member)) (car connected))) ids))
      (set! groups (cons (remove-duplicates (append ids (append* connected)) same?)
                         (filter (lambda (g) (not (memq g connected))) groups)))))
  (for ([entry (in-list (hash-ref facts 'structure '()))]
        #:when (eq? (caaddr entry) 'family))
    (join! (map (lambda (m) (hash-ref m 'identifier))
                (hash-ref (cadr (caddr entry)) 'members))))
  (define bridges groups)
  (define (linked? a b)
    (or (same? a b)
        (for/or ([g (in-list bridges)])
          (and (ormap (lambda (id) (same? id a)) g)
               (ormap (lambda (id) (same? id b)) g)))))
  (for ([same-target (in-list (group-by (lambda (c) (hash-ref c 'range)) components))])
    (define owner (hash-ref type-owners (hash-ref (car same-target) 'range) #f))
    (join! (append (if owner (list owner) '())
                    (map (lambda (c) (hash-ref c 'identifier)) same-target))))
  ;; Returned structure values are emitted together. Follow those actual
  ;; output identifiers, then close the already retained returned-binder edges.
  (define tuples '())
  (define runtime '())
  (define redirected '())
  (define text (hash-ref request 'text))
  (define (storage! id scopes)
    (define original (stepper-syntax-property id 'stepper-orig-name))
    (define r (and (identifier? original) (range original)))
    (when (and r (equal? src (syntax-source original)) (<= 0 (car r) (cdr r) (string-length text))
               (equal? (substring text (car r) (cdr r)) (symbol->string (syntax-e original))))
      (define scope
        (or (findf (lambda (scope) (<= (car scope) (car r) (cdr r) (cdr scope))) scopes)
            (cons 0 (string-length text))))
      (set! runtime (cons (hasheq 'identifier id 'name (symbol->string (syntax-e original))
                                  'scope scope 'mutable? (eq? level 'asl)) runtime))
      (set! redirected (cons (hasheq 'identifier id 'range r 'role 'definition) redirected))))
  (define (walk value [scopes '()])
    (cond [(cancelled?) (void)]
          [(syntax? value)
           (define r (and (equal? src (syntax-source value)) (range value)))
           (define here (if (and r (<= 0 (car r) (cdr r) (string-length text))) (cons r scopes) scopes))
           (define quoted? #f)
           (kernel-syntax-case value #f
             [(quote . _) (set! quoted? #t)]
             [(quote-syntax . _) (set! quoted? #t)]
             [(define-values (id ...) rhs)
              (set! tuples (cons (syntax->list #'(id ...)) tuples))
              (for ([id (in-list (syntax->list #'(id ...)))]) (storage! id here))]
             [(let-values ([(id ...) rhs] ...) body ...)
              (for* ([ids (in-list (syntax->list #'((id ...) ...)))]
                     [id (in-list (syntax->list ids))]) (storage! id here))]
             [(letrec-values ([(id ...) rhs] ...) body ...)
              (for* ([ids (in-list (syntax->list #'((id ...) ...)))]
                     [id (in-list (syntax->list ids))]) (storage! id here))]
             [_ (void)])
           (unless quoted? (walk (syntax-e value) here))]
          [(pair? value) (walk (car value) scopes) (walk (cdr value) scopes)]))
  (when (hash-ref request 'expanded #f) (walk (hash-ref request 'expanded)))
  (let close ()
    (define before groups)
    (for ([tuple (in-list tuples)] #:when (pair? (cdr tuple)))
      (when (for/or ([c (in-list components)])
              (for/or ([group (in-list groups)]
                       #:when (ormap (lambda (id) (same? id (hash-ref c 'identifier))) group))
                (ormap (lambda (id) (ormap (lambda (other) (same? id other)) tuple)) group)))
        (join! tuple)))
    (unless (equal? before groups) (close)))
  (define families
    (append-map
     (lambda (group)
       (define members
         (for/list ([b (in-list binders)]
                    #:when (and (equal? (hash-ref b 'phase) 0)
                                (ormap (lambda (id) (same? id (hash-ref b 'identifier))) group)))
           (hash-set b 'role 'definition)))
       (if (null? members) '()
           (for/list ([canonical (in-list members)] [i (in-naturals)])
             (hasheq 'key (list 'teaching (hash-ref (car members) 'anchor) i)
                     'canonical (hash-ref canonical 'identifier)
                     'members members 'complete? #t)))) groups))
  (define names
    (for*/list ([name (in-list (hash-ref facts 'names '()))]
                #:when (eq? (hash-ref name 'role) 'use)
                [c (in-list components)]
                #:when (linked? (hash-ref name 'identifier) (hash-ref c 'identifier))
                #:do [(define range (hash-ref name 'range))
                      (define start (+ (car range) (hash-ref c 'offset)))
                      (define end (+ start (hash-ref c 'width)))
                      (define target (hash-ref c 'range))]
                #:when (and (<= end (cdr range))
                            (equal? (substring text start end)
                                    (substring text (car target) (cdr target)))))
      ;; Only the written type declaration supplies the type's scoped owner.
      ;; A field can share its spelling with an unrelated bound variable.
      (hash-set* name 'range (cons start end)
                 'identifier (hash-ref type-owners (hash-ref c 'range)
                                       (lambda () (hash-ref name 'identifier))))))
  (define definitions
    (for/list ([c (in-list components)]
               #:unless (for/or ([other (in-list components)])
                          (and (same? (hash-ref c 'identifier) (hash-ref other 'identifier))
                               (< (hash-ref other 'width) (hash-ref c 'width)))))
      (hasheq 'identifier (hash-ref c 'identifier) 'range (hash-ref c 'range) 'role 'definition)))
  (hasheq 'families families 'names (remove-duplicates (append names definitions redirected))
          'runtime (remove-duplicates runtime
                     (lambda (a b) (same? (hash-ref a 'identifier) (hash-ref b 'identifier))))))
