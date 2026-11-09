#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list
         racket/match
         setup/dirs
         syntax/modresolve
         syntax/id-table
         data/interval-map
         "expanded-core.rkt"
         "internal-types.rkt"
         "../common/source.rkt"
         "../common/path-util.rkt")

(provide collect-binding-facts identifier-module-binding confirmed-source-bindings)

;; Resolve in the namespace that expanded the identifier. Printed names and
;; source ranges are never binding keys.
(define (identifier-module-binding id phase file [space #f])
  (define binding (identifier-binding id phase))
  (and file (list? binding) (= (length binding) 7)
       (let ()
         (define module (resolve-module-path-index (car binding) file))
         (define-values (path submods)
           (match module
             [(? path? path) (values path '())]
             [`(submod ,(? path? path) ,submods ...) (values path submods)]
             [_ (values #f '())]))
         (and path
              (Module-Binding (normalize-source-path path) submods
                              (list-ref binding 4)
                              (cadr binding))))))

;; Keep scoped identifiers and structural binder anchors until declaration%
;; has consumed them. Metadata can retain evidence, but cannot create a binding.
(define (collect-binding-facts source expanded text [pre #f]
                               #:contribution-only? [contribution-only? #f])
  (define project? (not contribution-only?))
  (define file (source-file-path source))
  (define src (source-syntax-source source))
  ;; Original form extents are indexed by their head locations. Expanded forms
  ;; can point into a transformer template; their origins retain the invocation.
  (define source-forms (make-hash))
  (define source-enclosing (make-hash))
  (define written-templates (make-interval-map))
  (define (range-of stx)
    (and (syntax? stx) (equal? src (syntax-source stx))
         (syntax-position stx) (syntax-span stx)
         (cons (sub1 (syntax-position stx))
               (+ (sub1 (syntax-position stx)) (syntax-span stx)))))
  (define (index-source value [parents '()])
    (cond [(syntax? value)
           (define parts (syntax->list value))
           (define parent
             (and (pair? parts) (identifier? (car parts)) (range-of value)
                  (cons (car parts) (range-of value))))
           (when (and parent
                      (memq (syntax-e (car parts))
                            '(quote quote-syntax syntax quasisyntax define-syntax-rule)))
             (define template
               (if (and (eq? (syntax-e (car parts)) 'define-syntax-rule) (>= (length parts) 3))
                   (caddr parts) value))
             (define range (range-of template))
             (interval-map-set! written-templates (car range) (cdr range) #t))
           (when parent
             (hash-set! source-forms (range-of (car parts)) (cdr parent)))
           (when (identifier? value)
             (define enclosing
               (for/first ([parent (in-list parents)]
                           #:unless (equal? (range-of (car parent)) (range-of value))) parent))
             (when enclosing (hash-set! source-enclosing (range-of value) enclosing)))
           (index-source (syntax-e value) (if parent (cons parent parents) parents))]
          [(pair? value) (index-source (car value) parents) (index-source (cdr value) parents)]))
  (when (and project? pre) (index-source pre))
  (define (encloses? outer inner)
    (and outer inner (<= (car outer) (car inner) (cdr inner) (cdr outer))))
  (define (source-form value id [source-name? #t])
    (define candidates '())
    (define (origins origin)
      (cond [(identifier? origin)
             (define range (hash-ref source-forms (range-of origin) #f))
             (when (encloses? range (range-of id))
               (set! candidates (cons range candidates)))]
            [(pair? origin) (origins (car origin)) (origins (cdr origin))]))
    (origins (syntax-property value 'origin))
    (cond [(and source-name? (hash-ref source-enclosing (range-of id) #f))
           => cdr]
          [(pair? candidates)
           (argmin (lambda (range) (- (cdr range) (car range))) candidates)]
          [else
           (define parts (syntax->list value))
           (and (pair? parts) (encloses? (range-of value) (range-of id))
                (range-of value))]))
  (define template-ranges (make-interval-map))
  (define form-extents (make-hasheq))
  (define current-scope (make-parameter (cons 0 (string-length text))))
  (define installation-dirs
    (map normalize-source-path
         (filter values (list (find-collects-dir) (find-pkgs-dir) (find-user-pkgs-dir)))))
  (define current-qualifying-origin? (make-parameter #f))
  (define origin-cache (make-hasheqv))
  (define (qualifying-origins? origins phase)
    (and project?
         (let ([cache (hash-ref! origin-cache phase (lambda () (make-free-id-table #:phase phase)))])
           (for/or ([origin (in-list origins)] #:when (identifier? origin))
             (free-id-table-ref! cache origin
               (lambda ()
                 (or (eq? (identifier-binding origin phase) 'lexical)
                     (let ([binding (identifier-module-binding origin phase file)])
                       (and binding
                            (let ([path (Module-Binding-filepath binding)])
                              (or (equal? path file)
                                  (not (for/or ([dir (in-list installation-dirs)])
                                         (directory-contains? dir path))))))))))))))
  (define current-module (make-parameter '()))
  (define current-modules (make-parameter '(())))
  (define regions '())
  (define names '())
  (define occurrences '())
  (define structure '())
  (define edges '())
  (define target-factory
    (with-handlers ([exn:fail? (lambda (_) #f)]) (resolve-module-path 'lang/private/teachhelp #f)))
  (define core-binders '())
  (define components '())
  (define origin-links (make-hash))
  (define seen (make-hash))
  (define (record! id phase role anchor)
    (when (and (identifier? id) (equal? src (syntax-source id))
               (syntax-position id) (syntax-span id) (positive? (syntax-span id))
               (identifier-binding id phase))
      (define start (sub1 (syntax-position id)))
      (define binding (identifier-module-binding id phase file))
      (when (and (<= 0 start (+ start (syntax-span id)) (string-length text))
                 (or (eq? role 'definition)
                     (syntax-original? id)
                     (syntax-property id 'original-for-check-syntax)
                     (with-handlers ([exn:fail:read? (lambda (_) #f)])
                       (define read-id
                         (read-syntax #f (open-input-string
                                          (substring text start (+ start (syntax-span id))))))
                       (and (identifier? read-id)
                            (equal? (syntax-e read-id) (syntax-e id))
                            (= (syntax-position read-id) 1)
                            (= (syntax-span read-id) (syntax-span id)))))
                 (or (not (eq? role 'definition))
                     (not binding) (equal? file (Module-Binding-filepath binding))))
        (set! names
              (cons (hasheq 'range (cons start (+ start (syntax-span id)))
                            'identifier id 'phase phase
                            'space (let ([info (identifier-binding id phase)])
                                     (and (list? info) (pair? (list-ref info 6))
                                          (cdr (list-ref info 6))))
                            'role role
                            'certainty 'confirmed 'anchor anchor 'binding binding)
                    names)))))
  ;; A directive names a scoped generated binding and an authored component.
  ;; Keep its offsets; the generated identifier's own location may be coarse.
  (define (component-directives value phase)
    (cond
      [(pair? value)
       (component-directives (car value) phase)
       (component-directives (cdr value) phase)]
      [(and (vector? value) (memv (vector-length value) '(6 10)))
       (define target-index (if (= (vector-length value) 6) 3 5))
       (define id (vector-ref value 0))
       (define target (vector-ref value target-index))
       (define offset (vector-ref value 1))
       (define width (vector-ref value 2))
       (define target-offset (vector-ref value (add1 target-index)))
       (define target-width (vector-ref value (+ target-index 2)))
       (when (and (identifier? id) (identifier? target)
                  (identifier-binding id phase)
                  (equal? src (syntax-source target)) (syntax-position target)
                  (exact-nonnegative-integer? offset) (exact-positive-integer? width)
                  (exact-nonnegative-integer? target-offset) (= width target-width))
         (define start (+ (sub1 (syntax-position target)) target-offset))
         (when (<= 0 start (+ start width) (string-length text))
           (set! components
                 (cons (hasheq 'identifier id 'phase phase
                               'space (let ([info (identifier-binding id phase)])
                                        (and (list? info) (pair? (list-ref info 6)) (cdr (list-ref info 6))))
                               'target target 'offset offset 'width width
                               'range (cons start (+ start width))) components))))]))
  (define (metadata value phase role anchor)
    (cond [(identifier? value) (record! value phase role anchor)]
          [(syntax? value) (metadata (syntax-e value) phase role anchor)]
          [(pair? value)
           (metadata (car value) phase role anchor)
           (metadata (cdr value) phase role anchor)]))
  (define (binders value phase anchor role form [rhs #f] [exclusions '()])
    (cond
      [(identifier? value)
       ;; A generated storage identifier need not have an authored range.
       ;; Retain its anchor without manufacturing a source-name record.
       (define binding (identifier-module-binding value phase file))
       (define projection
         (if (not project?) (hasheq)
             (let ()
               (define extent
                 (source-form form value (not (memq role '(lambda #%plain-lambda case-lambda)))))
               (define body
                 (and (memq role '(let-values letrec-values letrec-syntaxes+values))
                      (cddr (syntax->list form))))
               (define scope
                 (if (and extent body
                          (for/and ([part (in-list body)])
                            (or (not (range-of part)) (encloses? extent (range-of part)))))
                     extent (current-scope)))
               (when extent (hash-set! form-extents form (if body scope extent)))
               (hasheq 'kind
                       (if (and rhs (memq (core-form rhs phase) '(lambda #%plain-lambda case-lambda)))
                           'function 'variable)
                       'extent extent
                       'declaration? (or (memq role '(define-values define-syntaxes))
                                         (and body (current-qualifying-origin?)))
                       'scope scope 'scope-exclusions exclusions
                       'module (current-module)))))
       (set! core-binders
             (cons (hash-set* projection 'identifier value 'phase phase 'role role 'anchor anchor
                              'space (let ([info (identifier-binding value phase)])
                                       (and (list? info) (pair? (list-ref info 6))
                                            (cdr (list-ref info 6))))
                              'binding binding)
                   core-binders))
       (record! value phase 'definition anchor)]
      [(syntax? value) (binders (syntax-e value) phase anchor role form rhs exclusions)]
      [(pair? value)
       (binders (car value) phase (cons 0 anchor) role form rhs exclusions)
       (binders (cdr value) phase (cons 1 anchor) role form rhs exclusions)]))
  (define (walk value phase anchor [export? #f])
    (define core (and (syntax? value) (core-form value phase)))
    (when (memq core '(#%require #%provide))
      (set! structure (cons (list anchor phase (list core (cdr (syntax->list value)))) structure)))
    (cond
      [(syntax? value)
       (define parts (syntax->list value))
       (define root-module? (and (memq core '(module module*)) (null? (current-module))))
       (define module
         (if (and project? (memq core '(module module*)))
             (append (current-module) (list (syntax-e (cadr parts)))) (current-module)))
       (define modules
         (cond [(or (not project?) (not (memq core '(module module*)))) (current-modules)]
               [(and (eq? core 'module*) (not (syntax-e (caddr parts))))
                (cons module (current-modules))]
               [else (list module)]))
       ;; Original forms start an authored expansion; generated descendants
       ;; inherit its origin evidence until another original form begins.
       (define origins (flatten (syntax-property value 'origin)))
       (parameterize ([current-module module] [current-modules modules]
                      [current-qualifying-origin?
                       (or (and (not (or (syntax-original? value)
                                         (ormap (lambda (id) (and (syntax? id) (syntax-original? id))) origins)))
                                (current-qualifying-origin?))
                           (qualifying-origins? origins phase))])
         (define seen-key (if export? (list value phase 'export) (cons value phase)))
         (unless (hash-ref seen seen-key #f)
           (hash-set! seen seen-key #t)
           (component-directives (syntax-property value 'sub-range-binders) phase)
           (metadata (syntax-property value 'disappeared-binding) phase 'definition anchor)
           (metadata (syntax-property value 'disappeared-use) phase 'use anchor)
           (metadata (syntax-property value 'origin) phase 'use anchor)
           (when (identifier? value)
             (record! value phase 'use anchor)
             ;; Export bindings are checked through unordered provide leaves.
             ;; Other generated uses keep their structural positions.
             (unless export?
               (set! occurrences
                     (cons (hasheq 'identifier value 'phase phase 'anchor anchor
                                   'binding (identifier-module-binding value phase file)
                                   'space (let ([info (identifier-binding value phase)])
                                            (and (list? info) (pair? (list-ref info 6))
                                                 (cdr (list-ref info 6)))))
                           occurrences))))
           (when (and project? (memq core '(module module* begin-for-syntax define-syntaxes)))
             (define range (range-of (if (eq? core 'define-syntaxes) (caddr parts) value)))
             (when range
               (set! regions
                     (cons (hasheq 'range (if root-module? (cons 0 (add1 (string-length text))) range)
                                   'module module 'modules modules
                                   'phase (cond [(memq core '(begin-for-syntax define-syntaxes))
                                                 (add1 phase)]
                                                [(syntax-e (caddr parts)) 0]
                                                [else phase])) regions))))
           (when (and project? (memq core '(quote quote-syntax)))
             (define range (range-of (cadr parts)))
             (when (and range (< (car range) (cdr range))
                        (interval-map-ref written-templates (car range) #f))
               (interval-map-set! template-ranges (car range) (cdr range) #t)))
           ;; An application can retain the scoped transformer it came from.
           ;; This is occurrence evidence, never a binding-family inference.
           (when (and (memq core '(#%app #%plain-app)) (pair? (cdr parts)) (identifier? (cadr parts)))
             (define callee (cadr parts))
             (let origins ([origin (syntax-property value 'origin)])
               (cond
                 [(identifier? origin)
                  (when (and (identifier-binding origin phase)
                             (equal? (syntax-source origin) (syntax-source callee))
                             (equal? (syntax-position origin) (syntax-position callee))
                             (equal? (syntax-span origin) (syntax-span callee))
                             (equal? (symbol->string (syntax-e origin)) (symbol->string (syntax-e callee))))
                    (hash-update! origin-links (list phase (syntax-position callee) (syntax-span callee))
                                  (lambda (ids) (cons (cons callee origin) ids)) '()))]
                 [(pair? origin) (origins (car origin)) (origins (cdr origin))])))
           (case core
             [(define-values define-syntaxes)
              (binders (cadr parts) phase (cons 'definition anchor) core value (caddr parts))
              ;; Pair declaration outputs with the scoped local binders they return.
              (when (eq? core 'define-values)
                (define locals (make-free-id-table #:phase phase))
                (define results
                  (let tail ([rhs (caddr parts)])
                    (define body (syntax->list rhs))
                    (case (core-form rhs phase)
                      [(let-values letrec-values)
                       (for* ([clause (in-list (syntax->list (cadr body)))]
                              [id (in-list (syntax->list (car (syntax->list clause))))])
                         (free-id-table-set! locals id #t))
                       (tail (last body))]
                      [(begin) (tail (last body))]
                      [(#%app #%plain-app)
                       (and (identifier? (cadr body)) (free-identifier=? (cadr body) #'values phase 0) (cddr body))]
                      [else #f])))
                (when (and results (= (length results) (length (syntax->list (cadr parts)))))
                  (for ([id (in-list (syntax->list (cadr parts)))] [result (in-list results)] [i (in-naturals)]
                        #:when (and (identifier? result) (free-id-table-ref locals result #f)))
                    (set! edges
                          (cons (hasheq 'key (list 'returned-binder anchor phase i) 'complete? #t
                                        'members (for/list ([member (in-list (list id result))])
                                                   (hasheq 'identifier member 'phase phase
                                                           'binding (identifier-module-binding member phase file))))
                                edges)))))
              ;; The scoped transformer factory supplies its value target explicitly.
              (when (eq? core 'define-syntaxes)
                (define rhs (caddr parts))
                (define call (and (memq (core-form rhs (add1 phase)) '(#%app #%plain-app)) (syntax->list rhs)))
                (define binding (and call (= (length call) 6) (identifier? (cadr call))
                                     (identifier-binding (cadr call) (add1 phase))))
                (define target (and binding (list? binding) (eq? (cadr binding) 'make-first-order-function)
                                    (equal? (resolved-module-path-name (module-path-index-resolve (car binding))) target-factory)
                                    (eq? (core-form (list-ref call 4) (add1 phase)) 'quote-syntax)
                                    (cadr (syntax->list (list-ref call 4)))))
                (define ids (syntax->list (cadr parts)))
                (when (and target (identifier? target) (= (length ids) 1) (identifier-binding target phase))
                  (set! edges
                        (cons (hasheq 'key (list 'transformer-target anchor phase) 'complete? #t
                                      'members (for/list ([id (in-list (list (car ids) target))])
                                                 (hasheq 'identifier id 'phase phase
                                                         'binding (identifier-module-binding id phase file))))
                              edges))))]
             [(#%plain-lambda lambda)
              (binders (cadr parts) phase (cons 'argument anchor) core value)]
             [(case-lambda)
              (for ([clause (in-list (cdr parts))] [i (in-naturals)])
                (binders (car (syntax->list clause)) phase (cons i (cons 'argument anchor)) core value))]
             [(let-values letrec-values letrec-syntaxes+values)
              (for ([group (in-list (if (eq? core 'letrec-syntaxes+values)
                                       (list (cadr parts) (caddr parts))
                                       (list (cadr parts))))]
                    [group-index (in-naturals)])
                (define exclusions
                  (if (and project? (eq? core 'let-values))
                      (filter-map (lambda (clause) (range-of (cadr (syntax->list clause))))
                                  (syntax->list group)) '()))
                (for ([clause (in-list (syntax->list group))] [i (in-naturals)])
                  (define origins (flatten (syntax-property clause 'origin)))
                  (parameterize ([current-qualifying-origin?
                                  (or (and (not (ormap (lambda (id) (and (syntax? id) (syntax-original? id))) origins))
                                           (current-qualifying-origin?))
                                      (qualifying-origins? origins phase))])
                    (binders (car (syntax->list clause)) phase
                             (list* 'local group-index i anchor) core value (cadr (syntax->list clause)) exclusions))))])
           (define scope
             (cond [(not project?) (current-scope)]
                   [(memq core '(module module*)) (or (range-of value) (current-scope))]
                   [(memq core '(lambda #%plain-lambda case-lambda let-values letrec-values
                                 letrec-syntaxes+values))
                    (hash-ref form-extents value (lambda () (current-scope)))]
                   [else (current-scope)]))
           (parameterize ([current-scope scope])
             (case core
               [(#%require) (void)]
               [(#%provide)
                (for ([spec (in-list (cdr parts))] [i (in-naturals)])
                  (for ([part (in-list (provide-parts spec phase (cons i anchor)))])
                    (walk (car part) (cadr part) (caddr part) #t)))]
               [else
                (unless (identifier? value)
                  (for ([part (in-list (code-parts value phase))] [i (in-naturals)])
                    (walk (car part) (cdr part) (cons i anchor))))]))))]
      [(pair? value)
       (walk (car value) phase (cons 0 anchor))
       (walk (cdr value) phase (cons 1 anchor))]))
  (when expanded (walk expanded 0 '()))
  (hasheq 'regions regions 'components (remove-duplicates components) 'binders
          (for/list ([binder (in-list (reverse core-binders))])
            (if project?
                (let ([range (range-of (hash-ref binder 'identifier))])
                  (hash-set binder 'authored?
                            (not (and range (interval-map-ref template-ranges (car range) #f)))))
                binder))
          'structure (append (reverse structure)
                             (for/list ([edge (in-list (reverse edges))])
                               (list (hash-ref edge 'key) 0 (list 'family edge))))
          'occurrences (reverse occurrences) 'names
          (for/list ([name (in-list (reverse names))])
            (define id (hash-ref name 'identifier))
            (define phase (hash-ref name 'phase))
            (hash-set name 'origins
                      (for/list ([entry (in-list (hash-ref origin-links
                                                          (list phase (syntax-position id) (syntax-span id)) '()))]
                                 #:when (free-identifier=? id (car entry) phase))
                        (cdr entry)))) 'families '() 'runtime '()
          'sites '() 'declarations '() 'snapshot #f))

;; Project only confirmed, authored names onto actual scoped core binders. A
;; helper may share a location with its public name without sharing its spelling.
(define (confirmed-source-bindings facts text identity)
  (define tables (make-hash))
  (define (table phase)
    (hash-ref! tables phase (lambda () (make-free-id-table #:phase phase))))
  (for ([binder (in-list (hash-ref facts 'binders '()))])
    (free-id-table-set! (table (hash-ref binder 'phase))
                       (hash-ref binder 'identifier) binder))
  (remove-duplicates
   (filter-map
    (lambda (name)
      (define range (hash-ref name 'range))
      (define id (hash-ref name 'identifier))
      (define binder
        (and (eq? (hash-ref name 'certainty 'confirmed) 'confirmed)
             (eq? (hash-ref name 'role) 'definition)
             (free-id-table-ref (table (hash-ref name 'phase 0)) id #f)))
      (and binder (hash-ref binder 'authored? #t)
           (with-handlers ([exn:fail:read? (lambda (_) #f)])
             (define written (read-syntax #f (open-input-string (substring text (car range) (cdr range)))))
             (and (identifier? written) (equal? (syntax-e written) (syntax-e id))
                  (= (syntax-position written) 1) (= (syntax-span written) (- (cdr range) (car range)))))
           (hash-set* (hash-remove (hash-remove (hash-remove binder 'identifier) 'anchor) 'binding)
                      'name (syntax-e id) 'identity (identity name)
                      'range range 'certainty 'confirmed)))
    (hash-ref facts 'names '()))))
