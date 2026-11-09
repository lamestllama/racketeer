#lang racket/base

(provide walk
         walk-online
         binding-completions)

;; powered by https://github.com/yjqww6/drcomplete

(require racket/set
         racket/list
         (prefix-in user-defined: "autocomplete/user-defined.rkt")
         (prefix-in required: "autocomplete/required.rkt")
         (prefix-in module-name: "autocomplete/module.rkt"))

;; Get completions that will be cached for every successful expand.
;; Syntax -> (Listof Symbol)
(define (walk stx)
  (append
    (set->list (user-defined:walk stx))
    (with-handlers ([exn:fail? (λ (_) '())])
      (set->list (required:walk-module stx)))))

;; Get completions that will be computed for every text change.
;; String -> (Listof Symbol)
(define (walk-online str-before-cursor)
  (map string->symbol (set->list (module-name:get-completions str-before-cursor))))

;; Keep scoped confirmed candidates until visibility has been checked. Existing
;; export and module-path completions retain their order.
(define (binding-completions facts declarations source-bindings pos legacy)
  (cond
    [(not facts) legacy]
    [else
     (define ranges (for/hash ([binding (in-list declarations)])
                      (values (hash-ref binding 'range) #t)))
     (define replaced (make-hasheq))
     (for ([binder (in-list (hash-ref facts 'binders '()))]
           #:unless (hash-ref binder 'authored? #t))
       (hash-set! replaced (hash-ref binder 'name) #t))
     (for ([name (in-list (hash-ref facts 'names '()))]
           #:when (and (eq? (hash-ref name 'certainty 'confirmed) 'confirmed)
                       (eq? (hash-ref name 'role) 'definition)
                       (hash-has-key? ranges (hash-ref name 'range))))
       (hash-set! replaced (hash-ref name 'name) #t))
     (define retained
       (for/hasheq ([binding (in-list source-bindings)]
                    #:unless (hash-has-key? ranges (hash-ref binding 'range)))
         (values (hash-ref binding 'name) #t)))
     (define candidates
       (filter (lambda (name) (or (not (hash-has-key? replaced name))
                                 (hash-has-key? retained name))) legacy))
     (define present (for/hasheq ([name (in-list candidates)]) (values name #t)))
     (define added (make-hasheq))
     (define context
       (for/fold ([context #f]) ([region (in-list (hash-ref facts 'regions '()))])
         (define range (hash-ref region 'range))
         (if (and (<= (car range) pos) (< pos (cdr range))
                  (or (not context)
                      (< (- (cdr range) (car range))
                         (- (cdr (hash-ref context 'range)) (car (hash-ref context 'range))))))
             region context)))
     (define additions
       (for/fold ([additions '()]) ([binding (in-list declarations)])
         (define scope (hash-ref binding 'scope))
         (define name (hash-ref binding 'name))
         (if (or (not (<= (car scope) pos (cdr scope)))
                 (and context
                      (or (not (equal? (hash-ref binding 'phase) (hash-ref context 'phase)))
                          (not (member (hash-ref binding 'module) (hash-ref context 'modules)))))
                 (for/or ([excluded (in-list (hash-ref binding 'scope-exclusions '()))])
                   (<= (car excluded) pos (cdr excluded)))
                 (hash-has-key? present name) (hash-has-key? added name)) additions
             (begin (hash-set! added name #t) (cons name additions)))))
     (append candidates (reverse additions))]))
