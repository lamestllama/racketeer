#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list racket/string syntax/id-table syntax/kerncase)
(provide bindings lower-expression)

;; Only identifiers retained by expansion supply identities. The text verifies
;; their written components; it never supplies an identifier to look up.
(define (bindings request _data)
  (define text (hash-ref request 'text))
  (define pre (hash-ref request 'pre))
  (define src (and pre (syntax-source pre)))
  (define cancelled? (hash-ref request 'cancelled?))
  (define names '())
  (define definition-members (make-hash))
  (define core-binders (hash-ref (hash-ref request 'facts) 'binders '()))
  (define portal-count 0)
  (define interface-positions (make-hasheqv))
  (define unsupported-interface? #f)
  (define (extensions value)
    (cond [(syntax? value)
           (define parts (syntax->list value))
           (when (and parts (>= (length parts) 3)
                      (eq? (syntax-e (car parts)) 'group) (identifier? (cadr parts))
                      (or (eq? (syntax-e (caddr parts)) '#:extend)
                          (and (eq? (syntax-e (cadr parts)) 'export)
                               (let ([block (syntax->list (caddr parts))])
                                 (and block (eq? (syntax-e (car block)) 'block)
                                      (for/or ([group (in-list (cdr block))])
                                        (define terms (syntax->list group))
                                        (and terms (pair? (cdr terms))
                                             (eq? (syntax-e (cadr terms)) 'all_from))))))))
             (hash-set! interface-positions (syntax-position (cadr parts)) #t))
           (extensions (syntax-e value))]
          [(pair? value) (extensions (car value)) (extensions (cdr value))]))
  (extensions pre)
  ;; Compare defining bindings, so re-exporting a native transformer keeps its
  ;; ownership facts. Nominal import paths do not establish declaration identity.
  (define (binding-key id phase)
    (define info (identifier-binding id phase))
    (and (list? info)
         (cons (resolved-module-path-name (module-path-index-resolve (car info))) (cadr info))))
  (dynamic-require 'rhombus #f)
  (define definitions
    (parameterize ([current-namespace (make-base-namespace)])
      (namespace-require 'rhombus)
      (for/list ([name '(class fun def namespace export)])
        (define id ((make-interned-syntax-introducer (if (eq? name 'export) 'rhombus/decl 'rhombus/defn)) (namespace-symbol->identifier name) 'add))
        (define key (binding-key id (namespace-base-phase (current-namespace))))
        (unless key (error 'bindings "Cannot resolve native declaration transformer."))
        (cons key name))))
  (define (definition-origin value phase)
    (cond
      [(identifier? value)
       (define definition (assoc (binding-key value phase) definitions))
       (when (and definition (memq (cdr definition) '(namespace export))
                  (equal? (syntax-source value) src)
                  (hash-ref interface-positions (syntax-position value) #f))
         (set! unsupported-interface? #t))
       (and definition (syntax-original? value)
            (equal? (syntax-source value) src) (syntax-position value)
            (list* (cdr definition) (syntax-position value) (syntax-span value)))]
      [(pair? value) (or (definition-origin (cdr value) phase) (definition-origin (car value) phase))]
      [else #f]))

  (define mutable-targets (make-free-id-table))
  (define initialiser-names (make-free-id-table))
  (define copies '())
  ;; Storage initialised through a converter must not get a raw setter.
  (define converted-targets (make-free-id-table))
  (define identifiers '())
  (define dots (make-hash))
  (define seen (make-hash))
  (define seen-metadata (make-hash))
  (define (after-dot? start)
    (let loop ([i (sub1 start)])
      (and (>= i 0)
           (if (char-whitespace? (string-ref text i))
               (loop (sub1 i))
               (hash-ref dots (add1 i) #f)))))
  (define (record! id phase [selector? #f] [public #f])
    (when (and (or selector? (not (syntax-original? id)))
               (equal? src (syntax-source id))
               (syntax-position id) (syntax-span id)
               (positive? (syntax-span id))
               (identifier-binding id phase))
      (define start (sub1 (syntax-position id)))
      (define end (+ start (syntax-span id)))
      (when (<= 0 start end (string-length text))
        (define written (substring text start end))
        ;; Deliberately decline operator components and other token shapes
        ;; unless the complete syntax span can be verified by this grammar.
        (when (regexp-match? #px"^(?:\\p{L}|_)(?:\\p{L}|\\p{M}|\\p{Nd}|_)*(?:[ \t\r\n]*\\.[ \t\r\n]*(?:\\p{L}|_)(?:\\p{L}|\\p{M}|\\p{Nd}|_)*)*$"
                             written)
          (define dotted? (string-contains? written "."))
          (define component (car (regexp-match #px"(?:\\p{L}|_)(?:\\p{L}|\\p{M}|\\p{Nd}|_)*$" written)))
          (define symbol-name (symbol->string (syntax-e id)))
          (when (and (or selector? dotted? (after-dot? start))
                     (or (equal? (car (regexp-match #rx"[^.]*$" symbol-name)) component)
                         (regexp-match? (pregexp (string-append "^" (regexp-quote component)
                                                               "[0-9]+$"))
                                        symbol-name)))
            (define info (identifier-binding id phase))
            (set! names
                  (cons (hasheq 'range (cons (- end (string-length component)) end)
                                'identifier id 'role (if selector? 'export 'use) 'phase phase
                                'rename-complete? (or (not public) (eq? (syntax-e public) (string->symbol component)))
                                'space (and (list? info) (pair? (list-ref info 6))
                                            (cdr (list-ref info 6))))
                        names)))))))
  (define (metadata value phase [origin? #f])
    (unless (cancelled?)
      (cond
        [(syntax? value)
         (unless (hash-ref seen-metadata (list value phase origin?) #f)
           (hash-set! seen-metadata (list value phase origin?) #t)
           (cond
             [(identifier? value)
              (when (and origin? (eq? (syntax-e value) '|.|) (syntax-original? value)
                         (equal? src (syntax-source value))
                         (syntax-position value) (syntax-span value)
                         (identifier-binding value phase))
                (hash-set! dots (+ (sub1 (syntax-position value)) (syntax-span value)) #t))
              (set! identifiers (cons (cons value phase) identifiers))
              (metadata (syntax-property value 'origin) phase #t)]
             [else (metadata (syntax-e value) phase origin?)]))]
        [(pair? value)
         (metadata (car value) phase origin?) (metadata (cdr value) phase origin?)])))
  (define (walk-provide spec phase)
    (cond
      [(identifier? spec) (walk spec phase)]
      [else
       (define parts (syntax->list spec))
       (when (pair? parts)
         (case (syntax-e (car parts))
           [(rename) (walk (cadr parts) phase)]
           [(for-meta protect for-space)
            (define kind (syntax-e (car parts)))
            (define shift (if (eq? kind 'for-meta) (syntax-e (cadr parts)) 0))
            (for ([part (in-list (if (eq? kind 'protect) (cdr parts) (cddr parts)))])
              (walk-provide part (and phase shift (+ phase shift))))]))]))
  (define (walk value phase)
    (unless (cancelled?)
      (cond
        [(syntax? value)
         (unless (hash-ref seen (cons value phase) #f)
           (hash-set! seen (cons value phase) #t)
           (define origin (definition-origin (syntax-property value 'origin) phase))
           (define owner (and origin (memq (car origin) '(class fun def)) origin))
           (when (or owner
                     (kernel-syntax-case/phase value phase [(#%require . _) #t] [_ #f]))
             (kernel-syntax-case/phase value phase
               [(define-values (id ...) rhs)
                (when owner
                  (hash-update! definition-members owner
                    (lambda (prior) (append (map (lambda (id) (cons id phase)) (syntax->list #'(id ...))) prior)) '()))]
               [(define-syntaxes (id ...) rhs)
                (when owner
                  (hash-update! definition-members owner
                    (lambda (prior) (append (map (lambda (id) (cons id phase)) (syntax->list #'(id ...))) prior)) '()))]
               [(#%require spec ...)
                (let ()
                  (define (portals spec phase)
                    (define parts (syntax->list spec))
                    (when (pair? parts)
                      (case (syntax-e (car parts))
                        [(portal)
                         (define id (cadr parts))
                         (define info (identifier-binding id phase))
                         (define binder
                           (hasheq 'identifier id 'phase phase
                                   'space (and (list? info) (pair? (list-ref info 6)) (cdr (list-ref info 6)))
                                   'role 'definition 'anchor (list 'portal portal-count)))
                         (set! portal-count (add1 portal-count))
                         (set! core-binders (append core-binders (list binder)))
                         (when (and (equal? src (syntax-source id)) (syntax-position id) (syntax-span id)
                                    (positive? (syntax-span id)))
                           (set! names (cons (hash-set binder 'range
                                                       (cons (sub1 (syntax-position id))
                                                             (+ (sub1 (syntax-position id)) (syntax-span id)))) names)))
                         (cond
                           [owner
                            (hash-update! definition-members owner
                              (lambda (prior) (cons (cons (cadr parts) phase) prior)) '())]
                           [else
                            ;; A namespace portal retains scoped export selectors.
                            ;; Class portals keep their generated member rules.
                            (define content (syntax->list (caddr parts)))
                            (when (and content (eq? (syntax-e (car content)) 'nspace))
                              (for ([field (in-list (cdddr content))])
                                (define pair (syntax->list field))
                                (when (and pair (= (length pair) 2)
                                           (identifier? (car pair)) (identifier? (cadr pair)))
                                  (for ([space (in-list (remove-duplicates
                                                        (append '(#f rhombus/namespace rhombus/annot rhombus/bind)
                                                                (map (lambda (binder) (hash-ref binder 'space)) core-binders))))])
                                    (define id (if space ((make-interned-syntax-introducer space) (cadr pair) 'add) (cadr pair)))
                                    (when (identifier-binding id phase) (record! id phase #t (car pair)))))))])]
                        [(for-meta)
                         (define shift (syntax-e (cadr parts)))
                         (for ([part (in-list (cddr parts))]) (portals part (and phase shift (+ phase shift))))])))
                  (for ([spec (in-list (syntax->list #'(spec ...)))]) (portals spec phase)))]
               [_ (void)]))
           (when (identifier? value) (set! identifiers (cons (cons value phase) identifiers)))
           (unless (kernel-syntax-case/phase value phase [(quote . _) #t] [(quote-syntax . _) #t] [_ #f])
             (for ([property '(origin disappeared-use disappeared-binding)])
               (metadata (syntax-property value property) phase (eq? property 'origin))))
           (when (and (equal? phase 0) (kernel-syntax-case/phase value phase [(let-values . _) #t] [_ #f]))
             (define parts (syntax->list value))
             (for ([clause (in-list (syntax->list (cadr parts)))])
               (define pair (syntax->list clause))
               (define ids (syntax->list (car pair)))
               (define rhs (cadr pair))
               (when (= (length ids) 1)
                 (cond
                   [(identifier? rhs) (set! copies (cons (cons (car ids) rhs) copies))]
                   [(kernel-syntax-case/phase rhs phase [(#%plain-app . _) #t] [_ #f])
                    (define application (syntax->list rhs))
                    (when (and (= (length application) 3)
                               (identifier? (cadr application))
                               (identifier? (caddr application)))
                      (free-id-table-set! converted-targets (car ids) #t)
                      (set! copies (cons (cons (car ids) (caddr application)) copies)))]
                   [(kernel-syntax-case/phase rhs phase [(let-values . _) #t] [_ #f])
                    (define inner (syntax->list rhs))
                    (define clauses (syntax->list (cadr inner)))
                    (when (and (= (length inner) 3) (= (length clauses) 1))
                      (define bound (syntax->list (car (syntax->list (car clauses)))))
                      (when (and (= (length bound) 1) (identifier? (caddr inner))
                                 (or (syntax-original? (car bound))
                                     (and (syntax-transforming?)
                                          (syntax-original? (syntax-local-introduce (car bound)))))
                                 (equal? src (syntax-source (car bound)))
                                 (free-identifier=? (car bound) (caddr inner)))
                        (free-id-table-set! initialiser-names (car ids)
                                            (symbol->string (syntax-e (car bound))))))]))))
           (when (and (equal? phase 0) (kernel-syntax-case/phase value phase [(set! . _) #t] [_ #f]))
             (define parts (syntax->list value))
             (when (and (= (length parts) 3) (identifier? (caddr parts))
                        (free-identifier=? (cadr parts) (caddr parts)))
               (free-id-table-set! mutable-targets (cadr parts) #t)))
           (kernel-syntax-case/phase value phase
             [(#%require . _) (void)]
             [(quote . _) (void)]
             [(quote-syntax . _) (void)]
             [(#%provide spec ...)
              (for ([spec (in-list (syntax->list #'(spec ...)))])
                (walk-provide spec phase))]
             [(module name lang body ...)
              (walk #'(body ...) 0)]
             [(module* name lang body ...)
              (walk #'(body ...) (if (syntax-e #'lang) 0 phase))]
             [(begin-for-syntax body ...)
              (walk #'(body ...) (add1 phase))]
             [(define-syntaxes ids rhs)
              (begin (walk #'ids phase) (walk #'rhs (add1 phase)))]
             [_ (walk (syntax-e value) phase)]))]
        [(pair? value) (walk (car value) phase) (walk (cdr value) phase)])))
  (when (and text src (hash-ref request 'expanded))
    (walk (hash-ref request 'expanded) 0)
    (for ([entry (in-list (reverse identifiers))]) (record! (car entry) (cdr entry))))
  (when unsupported-interface?
    (set! names
          (for/list ([name (in-list names)])
            (if (eq? (hash-ref name 'role) 'export)
                (hash-set name 'rename-complete? #f) name))))
  ;; Mutable bindings retain their actual storage on references, separately
  ;; from the written transformer name. The self-assignment marks that storage;
  ;; dotted-access temporaries can have the same rename property but lack it.
  (define runtime '())
  (define (written-origins value)
    (cond [(identifier? value)
           (if (and (syntax-original? value) (equal? src (syntax-source value))
                    (syntax-position value) (syntax-span value)
                    (let* ([start (sub1 (syntax-position value))]
                           [end (+ start (syntax-span value))])
                      (and (<= 0 start end (string-length text))
                           (equal? (substring text start end) (symbol->string (syntax-e value))))))
               (list value) '())]
          [(syntax? value) (written-origins (syntax-e value))]
          [(pair? value) (append (written-origins (car value)) (written-origins (cdr value)))]
          [else '()]))
  (for ([entry (in-list identifiers)]
        #:when (and (equal? (cdr entry) 0)
                    (syntax-property (car entry) 'not-free-identifier=?)
                    (free-id-table-ref mutable-targets (car entry) #f)))
    (define id (car entry))
    (define origins (remove-duplicates (written-origins (syntax-property id 'origin))
                                      (lambda (a b) (eq? (syntax-e a) (syntax-e b)))))
    (when (= (length origins) 1)
      (set! runtime
            (cons (hasheq 'name (symbol->string (syntax-e (car origins))) 'identifier id
                          'scope (cons 0 (string-length text))
                          'mutable? (not (free-id-table-ref converted-targets id #f))) runtime))))
  ;; An unused mutable has no reference carrying its written origin. Its
  ;; initialiser still returns the original binder, then copies or converts that
  ;; value into the storage marked by the self-assignment. Follow those identities.
  (for ([copy (in-list copies)]
        #:when (free-id-table-ref mutable-targets (car copy) #f))
    (define name (free-id-table-ref initialiser-names (cdr copy) #f))
    (when name
      (set! runtime (cons (hasheq 'name name 'identifier (car copy)
                                  'scope (cons 0 (string-length text))
                                  'mutable? (not (free-id-table-ref converted-targets (car copy) #f))) runtime))))
  (define families
    (append-map
     (lambda (entry)
      (define owner (car entry))
      (define ids (cdr entry))
      (define members
        (for/list ([binder (in-list core-binders)]
                   #:when (for/or ([entry (in-list ids)])
                            (and (equal? (cdr entry) (hash-ref binder 'phase))
                                 (free-identifier=? (car entry) (hash-ref binder 'identifier) (cdr entry)))))
          (hash-set binder 'role 'definition)))
      (define canonicals
        (filter (lambda (member) (syntax-original? (hash-ref member 'identifier))) members))
      (for/list ([canonical (in-list (if (pair? canonicals) canonicals (take members (min 1 (length members)))))]
                 [i (in-naturals)])
        (hasheq 'key (list 'declaration (hash-ref (car members) 'anchor) i)
                'canonical (hash-ref canonical 'identifier)
                'members (for/list ([member (in-list members)])
                           (hash-set member 'by-name? (eq? (car owner) 'class)))
                'complete? #t)))
     (hash->list definition-members)))
  (hasheq 'names (remove-duplicates (reverse names))
          'families families
          'runtime (remove-duplicates runtime
                     (lambda (a b)
                       (and (equal? (hash-ref a 'name) (hash-ref b 'name))
                            (free-identifier=? (hash-ref a 'identifier) (hash-ref b 'identifier)))))))

;; Interaction reading produces shrubbery groups. Keep their scopes and replace
;; frame locals before the Rhombus expression parser resolves their bindings.
(define (lower-expression request _data)
  (define lexical (hash-ref (hash-ref request 'hooks) 'lexical-identifier))
  (define (dot? term)
    (define parts (and (syntax? term) (syntax->list term)))
    (and parts (= (length parts) 2)
         (eq? (syntax-e (car parts)) 'op)
         (eq? (syntax-e (cadr parts)) '|.|)))
  (define (walk term [after-dot? #f])
    (cond
      [(identifier? term)
       (or (and (not after-dot?) (lexical (symbol->string (syntax-e term)))) term)]
      [(syntax? term)
       (define parts (syntax->list term))
       (datum->syntax term
                      (if (and parts (pair? parts))
                          (cons (car parts) (walk (cdr parts)))
                          (walk (syntax-e term)))
                      term term)]
      [(pair? term)
       (let loop ([terms term] [after-dot? #f])
         (cond
           [(pair? terms)
            (cons (walk (car terms) after-dot?) (loop (cdr terms) (dot? (car terms))))]
           [(syntax? terms)
            (datum->syntax terms (loop (syntax-e terms) after-dot?) terms terms)]
           [else terms]))]
      [else term]))
  (define term (walk (namespace-syntax-introduce (hash-ref request 'term))))
  (define parts (syntax->list term))
  (define group
    (cond
      [(and parts (eq? (syntax-e (car parts)) 'multi))
       (unless (= (length parts) 2)
         (error 'rhombus "Enter one Rhombus expression."))
       (cadr parts)]
      [else term]))
  (dynamic-require 'rhombus/parse (void))
  (define head
    (syntax-binding-set->syntax
     (syntax-binding-set-extend (syntax-binding-set) 'rhombus-expression 0
                                (module-path-index-join 'rhombus/parse #f))
     'rhombus-expression))
  (datum->syntax #f (list head group) term))
