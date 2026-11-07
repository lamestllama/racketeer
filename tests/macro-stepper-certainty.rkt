#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/list racket/promise
         macro-debugger/model/deriv macro-debugger/model/steps
         macro-debugger/model/trace macro-debugger/model/reductions
         macro-debugger/model/reductions-util macro-debugger/model/hiding-policies
         "../racketdap/tools/macro-steps/facts.rkt"
         "../racketdap/tools/macro-steps/answer.rkt"
         "../racketdap/tools/macro-steps/printing.rkt"
         "../racketdap/tools/macro-source.rkt"
         (only-in "support/macro-stepper.rkt" request))

(define (identifier name) (datum->syntax #f name))
(define (tree . terms) (datum->syntax #f terms))
(define (render term binders uses [relocations (hasheq)])
  (define serial 0)
  (define (fresh prefix) (set! serial (add1 serial)) (format "~a~a" prefix serial))
  ((make-section-renderer fresh (lambda (term phase phases) (format "~s" (syntax-e term)))
                          relocations (hasheq))
   term null binders uses #:partition (new-foreground-partition)))
(define (incoming section ordinal)
  (define occurrence (list-ref (cdr (hash-ref section 'occurrences)) ordinal))
  (filter (lambda (e) (equal? (hash-ref e 'reference) (hash-ref occurrence 'id)))
          (hash-ref section 'edges)))
(define (certainty section ordinal)
  (map (lambda (e) (list (hash-ref e 'certainty) (hash-ref e 'phase))) (incoming section ordinal)))

(module+ test
  (test-case "a distinct scope-equivalent recorded sibling supplies no certainty"
    (define binder (identifier 'x))
    (define destination (identifier 'x))
    (define sibling (syntax-property destination 'copy #t))
    (check-false (eq? destination sibling))
    (for ([phase '(-1 0 1 8)])
      (check-true (bound-identifier=? destination sibling phase))
      (define section (render (tree binder destination sibling destination)
                              (hasheq binder phase) (hasheq sibling phase)))
      (check-equal? (certainty section 1) `(("possible" ,phase)))
      (check-equal? (certainty section 2) `(("definite" ,phase)))
      (check-equal? (certainty section 3) `(("possible" ,phase)))))

  (test-case "a relocated destination cannot inherit its predecessor's recorded use"
    (define binder (identifier 'x))
    (define predecessor (identifier 'x))
    (define destination (syntax-property predecessor 'relocated #t))
    (for ([phase '(0 1)])
      (define section (render (tree binder destination) (hasheq binder phase)
                              (hasheq predecessor phase) (hasheq predecessor (list destination))))
      (check-equal? (certainty section 1) `(("possible" ,phase)))))

  (test-case "exact lookup precedes forward targets, whose recorded order is respected"
    (define binder (identifier 'x))
    (define destination (identifier 'x))
    (define first (identifier 'x))
    (define second (identifier 'x))
    (define remote (identifier 'x))
    (define relocations (hasheq destination (list first second) first (list remote)))
    (define (check uses phase expected)
      (check-equal? (certainty (render (tree binder destination) (hasheq binder phase) uses relocations) 1)
                    (list (list expected phase))))
    (check (hasheq first 0 second 1) 0 "definite")
    (check (hasheq first #f second 1) 1 "definite")
    (check (hasheq destination -1 first 0 second 1) -1 "definite")
    (check (hasheq remote 0) 0 "possible")
    (check (hasheq destination #f) 0 "possible")
    (check (hasheq destination #f second 1) 1 "definite"))

  (test-case "a definite destination without a binder at its established phase has no arrow"
    (define binder (identifier 'x))
    (define destination (identifier 'x))
    (check-equal? (incoming (render (tree binder destination) (hasheq binder 0)
                                   (hasheq destination 1)) 1) null))

  (test-case "origins include only the representative and its direct displayed forward targets"
    (define binder (identifier 'x))
    (define relocated (identifier 'x))
    (define remote (identifier 'x))
    (define destination (identifier 'x))
    (define section (render (tree relocated relocated destination remote)
                            (hasheq binder 1) (hasheq destination 1)
                            (hasheq binder (list relocated) relocated (list remote))))
    (check-equal? (length (incoming section 2)) 2)
    (check-equal? (length (hash-ref section 'binderOccurrences)) 2)
    (for ([e (hash-ref section 'edges)])
      (check-not-equal? (hash-ref e 'binder) (hash-ref e 'reference))))

  (test-case "relocations pair only identifier leaves in lists, latest first, and stop at modules"
    (define original (identifier 'x))
    (define first (identifier 'x))
    (define second (identifier 'x))
    (define boxed (identifier 'boxed))
    (define boxed-target (identifier 'boxed))
    (define completed (tree original original (vector boxed)))
    (define shifted (tree first second (vector boxed-target)))
    (define (module-node body result)
      (p:module #f #f null #f #f #f #f #f body (tree (identifier 'module) (identifier 'm) (identifier 'lang) result)))
    (define inner (module-node (p:variable #f (tree boxed) null #f #f) (tree boxed-target)))
    ;; The nested module is deliberately present as the outer body derivation.
    (define outer (module-node (struct-copy p:module inner [z2 #:parent node completed]) shifted))
    (define relocations (module-relocations outer))
    (check-equal? (hash-ref relocations original) (list second first))
    (check-false (hash-has-key? relocations boxed))
    (check-false (hash-has-key? relocations first)))

  (test-case "each side uses its own table and suspended contexts use the first state's table"
    (define binder0 (identifier 'x))
    (define binder1 (identifier 'x))
    (define use (identifier 'x))
    (define term (tree binder0 binder1 use))
    (define binders (hasheq binder0 0 binder1 1))
    (define frame (bigframe null null term))
    (define (at uses) (state term null null (list frame) binders uses (hasheq) 0))
    (define before (at (hasheq use 1)))
    (define after (at (hasheq use 0)))
    (define query #f)
    (expansion-answer (list (step 'macro before after)) binders (hasheq use 8)
                      term #f term 'null null #:retain-inspector (lambda (q) (set! query q)))
    (define record (hash-ref (query (hasheq 'mode "position" 'position 1)) 'record))
    (check-equal? (certainty (hash-ref record 'before) 2) '(("definite" 1)))
    (check-equal? (certainty (hash-ref record 'after) 2) '(("definite" 0)))
    (check-equal? (certainty (hash-ref (car (hash-ref record 'contexts)) 'section) 2) '(("definite" 1)))
    (check-equal? (incoming (hash-ref (query (hasheq 'mode "position" 'position 2)) 'final) 2) null))

  (test-case "finished objects and completion facts replace the last After objects and facts"
    (define binder (identifier 'x))
    (define after-use (identifier 'x))
    (define finished-use (syntax-property after-use 'finished #t))
    (define after (tree binder after-use))
    (define finished (tree binder finished-use))
    (define s (state after null null null (hasheq binder 0) (hasheq after-use 0) (hasheq) 0))
    (define query #f)
    (expansion-answer (list (step 'macro s s)) (hasheq binder 0) (hasheq after-use 0)
                      finished #f after 'null null #:retain-inspector (lambda (q) (set! query q)))
    (define section (hash-ref (query (hasheq 'mode "position" 'position 2)) 'final))
    (check-equal? (certainty section 1) '(("possible" 0)))
    ;; A fact retained only on the After snapshot must not leak into completion.
    (expansion-answer (list (step 'macro s s)) (hasheq binder 0) (hasheq)
                      after #f after 'null null #:retain-inspector (lambda (q) (set! query q)))
    (check-equal? (certainty (hash-ref (query (hasheq 'mode "position" 'position 2)) 'final) 1)
                  '(("possible" 0))))

  (test-case "Standard hiding final uses finished relocated objects at phases zero and one"
    (for ([program (list "#lang racket/base\n(define-syntax-rule (keep e) e)\n(let ([x 1]) (list x (keep x)))\n"
                         "#lang racket/base\n(require (for-syntax racket/base))\n(define-syntax-rule (keep e) e)\n(begin-for-syntax (define phase-value 1) (define phase-local phase-value) phase-local)\n(keep 1)\n")]
          [name '(x phase-value)] [phase '(0 1)])
      (call-with-macro-source
       (request program #:mode "module")
       (lambda (stx)
         (define-values (_result _events derivation) (trace* stx))
         (define-values (steps binders uses expanded failure)
           (parameterize ([macro-policy standard-policy]) (reductions+ (force derivation))))
         (check-false failure)
         (define after (for/last ([step steps] #:when (step? step)) (step-s2 step)))
         (define (ids value)
           (cond [(identifier? value) (list value)]
                 [(syntax? value) (ids (syntax-e value))]
                 [(pair? value) (append (ids (car value)) (ids (cdr value)))]
                 [else null]))
         (check-true (for/or ([id (ids (state-term after))])
                       (and (eq? (syntax-e id) name) (equal? (hash-ref (state-uses after) id #f) phase))))
         (define query #f)
         (expansion-answer steps binders uses expanded failure stx 'null null
                           #:relocations (module-relocations (force derivation))
                           #:retain-inspector (lambda (q) (set! query q)))
         (define final (hash-ref (query (hasheq 'mode "position" 'position (add1 (count (lambda (s) (visible-step? s)) steps)))) 'final))
         (define occurrences (filter (lambda (o) (equal? (substring (hash-ref final 'text)
                                                                 (car (hash-ref o 'range)) (cadr (hash-ref o 'range)))
                                                        (symbol->string name))) (hash-ref final 'occurrences)))
         (check-true (>= (length occurrences) 2))
         (define use-ids (map (lambda (o) (hash-ref o 'id)) (cdr occurrences)))
         (define edges (filter (lambda (e) (member (hash-ref e 'reference) use-ids)) (hash-ref final 'edges)))
         (check-true (pair? edges))
         (for ([edge edges]) (check-equal? (hash-ref edge 'certainty) "possible")))))))
