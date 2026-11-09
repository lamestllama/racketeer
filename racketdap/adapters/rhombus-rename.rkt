#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list syntax/kerncase shrubbery/parse
         (only-in rhombus))
(provide rename)

;; The native reader determines the token class and the complete token extent.
(define (name-class text)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (define parsed (parse-all (open-input-string text)))
    (define parts (syntax->list parsed))
    (define group (and (= (length parts) 2) (syntax->list (cadr parts))))
    (define term (and group (= (length group) 2) (cadr group)))
    (define operator (and term (syntax->list term)))
    (define id (if (and operator (= (length operator) 2)
                        (eq? (syntax-e (car operator)) 'op)) (cadr operator) term))
    (and (identifier? id) (equal? (syntax-position id) 1)
         (equal? (syntax-span id) (string-length text))
         (if operator 'operator 'identifier))))

;; Syntax exported by the language includes its reserved declaration forms,
;; annotations and operators. These names cannot be replacement binders.
(define-values (_variables forms) (module->exports 'rhombus))
(define reserved
  (remove-duplicates (for*/list ([group (in-list forms)] [entry (in-list (cdr group))]) (car entry))))

(define (same-owner? left right)
  (define (key record)
    (define binding (identifier-binding (hash-ref record 'identifier) (hash-ref record 'phase 0)))
    (and (list? binding)
         (list (resolved-module-path-name (module-path-index-resolve (car binding)))
               (cadr binding) (list-ref binding 4))))
  (if (and (hash-ref left 'binding #f) (hash-ref right 'binding #f))
      (equal? (hash-ref left 'binding) (hash-ref right 'binding))
      (let ([binding (key left)]) (and binding (equal? binding (key right))))))

;; Resolve the installed language's exports, then compare defining bindings at
;; each phase. An unavailable binding makes member completeness unprovable.
(define (scan request)
  (define names '())
  (define computed? #f)
  (define exports '())
  (define references
    (with-handlers ([exn:fail? (lambda (_) (set! computed? #t) '())])
      (for/list ([entry (in-list
                        '(((submod rhombus/private/amalgam dot) dot-lookup-by-name)
                          ((submod rhombus/private/amalgam dot) dot-assign-by-name)
                          (rhombus/dot dynamic-dot-ref)
                          (rhombus/dot dynamic-dot-set!)
                          (racket/base eval)
                          (racket/base eval-syntax)
                          (racket/base load)
                          (racket/base dynamic-require)
                          (racket/base namespace-require)
                          (racket/base namespace-variable-value)))])
        (define module (car entry))
        (define name (cadr entry))
        (dynamic-require module #f)
        (define id
          (parameterize ([current-namespace (module->namespace module)])
            (namespace-symbol->identifier name)))
        (define binding (identifier-binding id 0))
        (unless (list? binding) (error 'rename "Cannot resolve run-time member lookup."))
        (list (resolved-module-path-name (module-path-index-resolve (car binding))) (cadr binding) name))))
  (define (lookup id phase)
    (define binding (identifier-binding id phase))
    (and (list? binding)
         (for/or ([entry (in-list references)])
           (and (equal? (car entry) (resolved-module-path-name (module-path-index-resolve (car binding))))
                (eq? (cadr entry) (cadr binding)) (caddr entry)))))
  (define (portal spec phase)
    (define parts (syntax->list spec))
    (when (pair? parts)
      (case (syntax-e (car parts))
        [(portal)
         (define content (syntax->list (caddr parts)))
         (when (and content (eq? (syntax-e (car content)) 'nspace))
           (when (syntax-e (caddr content)) (error 'rename "Cannot inspect an extended namespace interface."))
           (for ([field (in-list (cdddr content))])
             (define pair (syntax->list field))
             (unless (and pair (= (length pair) 2) (identifier? (car pair)) (identifier? (cadr pair)))
               (error 'rename "Cannot inspect namespace exports."))
             (define owners
               (for/list ([space '(#f rhombus/namespace rhombus/annot rhombus/bind)]
                          #:do [(define id (if space ((make-interned-syntax-introducer space) (cadr pair) 'add) (cadr pair)))]
                          #:when (identifier-binding id phase))
                 (hasheq 'identifier id 'phase phase 'space space)))
             (unless (pair? owners) (error 'rename "Cannot resolve namespace export owner."))
             (set! exports (cons (hasheq 'name (syntax-e (car pair)) 'public (car pair)
                                         'interface (hasheq 'identifier (cadr parts) 'phase phase)
                                         'owners owners) exports))))]
        [(for-meta)
         (define shift (syntax-e (cadr parts)))
         (for ([part (in-list (cddr parts))]) (portal part (and phase shift (+ phase shift))))])))
  (define (module-export spec phase [space #f])
    (define (record id public)
      (define owner (hasheq 'identifier id 'phase phase 'space space))
      (set! exports (cons (hasheq 'name (syntax-e public) 'public public
                                  'interface owner 'owners (list owner)) exports)))
    (cond
      [(identifier? spec) (record spec spec)]
      [else
       (define parts (syntax->list spec))
       (unless (pair? parts) (error 'rename "Cannot inspect module export."))
       (case (syntax-e (car parts))
         [(rename) (record (cadr parts) (caddr parts))]
         [(protect) (for ([part (in-list (cdr parts))]) (module-export part phase space))]
         [(for-meta for-space)
          (define meta? (eq? (syntax-e (car parts)) 'for-meta))
          (define shift (syntax-e (cadr parts)))
          (for ([part (in-list (cddr parts))])
            (module-export part (if meta? (and phase shift (+ phase shift)) phase) (if meta? space shift)))]
         [else (error 'rename "Cannot inspect module export.")])]))
  (define seen (make-hash))
  (define (walk value phase)
    (cond
      [(syntax? value)
       (unless (hash-ref seen (cons value phase) #f)
         (hash-set! seen (cons value phase) #t)
         (when (identifier? value)
           (when (lookup value phase) (set! computed? #t)))
         (kernel-syntax-case/phase value phase
           [(quote . _) (void)]
           [(quote-syntax . _) (void)]
           [(#%provide spec ...) (for ([spec (in-list (syntax->list #'(spec ...)))]) (module-export spec phase))]
           [(#%require spec ...) (for ([spec (in-list (syntax->list #'(spec ...)))]) (portal spec phase))]
           [(module name lang body ...) (walk #'(body ...) 0)]
           [(module* name lang body ...) (walk #'(body ...) (if (syntax-e #'lang) 0 phase))]
           [(begin-for-syntax body ...) (walk #'(body ...) (add1 phase))]
           [(define-syntaxes ids rhs) (walk #'rhs (add1 phase))]
           [(#%plain-app proc arg ...)
            (let ([kind (and (identifier? #'proc) (lookup #'proc phase))]
                  [args (syntax->list #'(arg ...))])
            (when (memq kind '(dynamic-dot-ref dynamic-dot-set! eval eval-syntax load dynamic-require
                               namespace-require namespace-variable-value))
              (set! computed? #t))
            (when (memq kind '(dot-lookup-by-name dot-assign-by-name))
              (define name
                (and (>= (length args) 2)
                     (kernel-syntax-case/phase (cadr args) phase
                       [(quote name) (and (symbol? (syntax-e #'name)) (syntax-e #'name))]
                       [_ #f])))
              (if name (set! names (cons name names)) (set! computed? #t)))
            (if kind
                (walk #'(arg ...) phase)
                (walk (syntax-e value) phase)))]
           [_ (unless (identifier? value) (walk (syntax-e value) phase))]))]
      [(pair? value) (walk (car value) phase) (walk (cdr value) phase)]))
  (walk (hash-ref request 'expanded) 0)
  (hasheq 'names (remove-duplicates names) 'computed? computed? 'exports (reverse exports)))

(define (rename request _data)
  (cond
    [(eq? (hash-ref request 'stage) 'scan) (scan request)]
    [else
     (define target (hash-ref request 'target))
     (define range (hash-ref target 'range))
     (define text (hash-ref request 'text))
     (define old (and range (substring text (car range) (cdr range))))
     (define class (and old (name-class old)))
     (define name (hash-ref request 'new-name))
     (define reason
       (cond
         [(not class) "This location is not a complete Rhombus name."]
         [(and name (not (eq? class (name-class name))))
          "Enter one Rhombus name of the same token class as the original."]
         [(and name (memq (string->symbol name) reserved))
          "This name is a reserved Rhombus form or operator."]
         [else #f]))
     (define canonical-class?
       (for*/or ([family (in-list (hash-ref target 'families))]
                 #:when (ormap (lambda (member) (hash-ref member 'by-name? #f)) (hash-ref family 'members))
                 [name (in-list (hash-ref target 'names))])
         (same-owner? (hasheq 'identifier (hash-ref family 'canonical)) name)))
     (define by-name?
       (and (not canonical-class?)
            (or (for*/or ([export (in-list (hash-ref (hash-ref request 'facts) 'names))]
                          #:when (eq? (hash-ref export 'role) 'export)
                          [name (in-list (hash-ref target 'names))])
                  (same-owner? export name))
                (not (for*/or ([family (in-list (hash-ref target 'families))]
                               [member (in-list (hash-ref family 'members))]
                               #:unless (hash-ref member 'by-name? #t)
                               [name (in-list (hash-ref target 'names))])
                       (same-owner? member name))))))
     (define complete?
       (not (for*/or ([entry (in-list (hash-ref (hash-ref request 'facts) 'names))]
                      #:unless (hash-ref entry 'rename-complete? #t)
                      [name (in-list (hash-ref target 'names))])
              (same-owner? entry name))))
     (hasheq 'valid? (not reason) 'complete? (and (not reason) complete?)
             'reason (or reason (and (not complete?) "This namespace interface cannot be proved complete.")) 'by-name? by-name?)]))
