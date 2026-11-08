;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

;; Check the worked sequences and focus regions after every hiding policy.
(require rackunit racket/list racket/string
         "../racketdap/tools/macro-steps/expansion.rkt"
         "../racketdap/tools/macro-steps/policy.rkt"
         (only-in "support/macro-stepper.rkt" structural-focus))

(define local-label "Introduce scope for local bindings")
(define block-label "Introduce scope for internal definition context")
(define resolve-label "Resolve variable (remove extra scopes)")
(define direct "(let ([x 1]) x)")
(define primitive
  "(module demo '#%kernel (#%module-begin (define-values (f) (lambda () (define-values (x) 'seed) x))))")
(define direct-labels
  (list "Macro transformation" local-label "Add explicit #%datum" "Macro transformation" block-label resolve-label))
(define module-labels
  (list "Introduce scope for module" "Introduce scope for module body" local-label block-label
        "Transform block to letrec" "Finish block" "Shift the self module-path-index"))
(define open-custom
  (hasheq 'enabled #t 'racket #f 'library #f 'contracts #f 'phase #f 'rules null))

(define (example text hiding renaming? #:hide [hidden #f] #:schema [schema 1])
  (parameterize ([current-namespace (make-base-namespace)])
    (namespace-require 'racket)
    (eval '(define-syntax-rule (keep a) (let ([x a]) x)))
    (define custom
      (if hidden
          (hash-set open-custom 'rules
                    (list (make-hiding-rule (namespace-symbol->identifier hidden)
                                           (hasheq 'id "rule" 'action "hide") #f)))
          open-custom))
    (expansion-steps (read-syntax 'program (open-input-string text)) hiding
                     #:custom custom #:schema-version schema #:include-renaming? renaming?)))
(define (labels answer) (map (lambda (s) (hash-ref s 'label)) (hash-ref answer 'steps)))
(define (focus step side) (structural-focus (hash-ref step side)))

(module+ test
  (test-case "keep and direct let: exact expansion order and totals in both protocols"
    (for ([schema '(1 2)])
      (for ([program (list "(keep 1)" direct)]
            [expected (list (cons "Macro transformation" direct-labels) direct-labels)]
            [off '(5 4)] [on '(8 7)] [standard-off '(2 1)] [standard-on '(3 2)])
        (check-equal? (labels (example program "none" #t #:schema schema)) expected)
        (check-equal? (labels (example program "none" #f #:schema schema))
                      (append (if (equal? program direct) null '("Macro transformation"))
                              '("Macro transformation" "Add explicit #%datum" "Macro transformation")))
        (for ([renaming? '(#f #t)] [total (list off on)] [standard (list standard-off standard-on)])
          (check-equal? (add1 (length (labels (example program "none" renaming? #:schema schema)))) total)
          (check-equal? (labels (example program "standard" renaming? #:schema schema))
                        (append (if (equal? program direct) null '("Macro transformation"))
                                (if renaming? (list resolve-label) null)))
          (check-equal? (add1 (length (labels (example program "standard" renaming? #:schema schema)))) standard)
          (check-equal? (labels (example program "custom" renaming? #:schema schema))
                        (labels (example program "none" renaming? #:schema schema)))))))

  (test-case "Custom hiding keeps surviving arguments and resolution, without generated scopes"
    (for ([schema '(1 2)])
      (for ([renaming? '(#f #t)])
        (define keep (example "(keep 1)" "custom" renaming? #:hide 'keep #:schema schema))
        (check-equal? (labels keep) '("Add explicit #%datum" "Macro transformation"))
        (check-equal? (add1 (length (labels keep))) 3)
        (define let (example direct "custom" renaming? #:hide 'let #:schema schema))
        (check-equal? (labels let) (append '("Add explicit #%datum" "Macro transformation")
                                         (if renaming? (list resolve-label) null)))
        (check-equal? (add1 (length (labels let))) (if renaming? 4 3))))
    (define hidden (hash-ref (example "(keep 1)" "custom" #t #:hide 'keep) 'steps))
    (check-equal? (focus (car hidden) 'before) '("1"))
    (check-equal? (focus (car hidden) 'after) '("(#%datum . 1)")))

  (test-case "local scope focuses include operands, then only the body reference"
    (for ([program (list "(keep 1)" direct)])
      (define steps (hash-ref (example program "none" #t) 'steps))
      (define local (findf (lambda (s) (equal? (hash-ref s 'label) local-label)) steps))
      (check-equal? (focus local 'before) '("(x)" "1" "x"))
      (check-equal? (focus local 'after) '("x" "1" "x"))
      (for ([s (take-right steps 2)])
        (check-equal? (focus s 'before) '("x"))
        (check-equal? (focus s 'after) '("x")))))

  (test-case "primitive module: exact order, totals and Standard's surviving body"
    (for ([schema '(1 2)])
      (check-equal? (labels (example primitive "none" #t #:schema schema)) module-labels)
      (check-equal? (labels (example primitive "custom" #t #:schema schema)) module-labels)
      (check-equal? (labels (example primitive "standard" #t #:schema schema)) (take (cdr module-labels) 5))
      (for ([hiding '("none" "standard" "custom")])
        (define off (example primitive hiding #f #:schema schema))
        (check-equal? (labels off) '("Transform block to letrec" "Finish block"))
        (check-equal? (add1 (length (labels off))) 3))
      (check-equal? (add1 (length (labels (example primitive "none" #t #:schema schema)))) 8)
      (check-equal? (add1 (length (labels (example primitive "standard" #t #:schema schema)))) 6))
    (define steps (hash-ref (example primitive "none" #t) 'steps))
    (define body "(#%module-begin (define-values (f) (lambda () (define-values (x) 'seed) x)))")
    (for ([s (take steps 2)])
      (check-equal? (focus s 'before) (list body))
      (check-equal? (focus s 'after) (list body)))
    (for ([side '(before after)])
      (check-equal? (focus (list-ref steps 2) side) '("()" "(define-values (x) 'seed)" "x"))
      (check-equal? (focus (list-ref steps 3) side) '("(define-values (x) 'seed)" "x")))
    (check-equal? (focus (last steps) 'before)
                  '("module" "demo" "'#%kernel" "(#%module-begin (define-values (f) (lambda () (let-values (((x) 'seed)) x))))"))
    (check-equal? (focus (last steps) 'after)
                  '("(module demo '#%kernel (#%module-begin (define-values (f) (lambda () (let-values (((x) 'seed)) x)))))")))

  (test-case "a quoted identifier adds no scope step and event points survive the filter"
    (for ([hiding '("none" "standard" "custom")])
      (check-equal? (labels (example "'seed" hiding #t)) null))
    (define on (hash-ref (example direct "none" #t #:schema 2) 'steps))
    (define off (hash-ref (example direct "none" #f #:schema 2) 'steps))
    (check-equal? (map (lambda (s) (hash-ref s 'expansionPoint)) off)
                  (map (lambda (i) (hash-ref (list-ref on i) 'expansionPoint)) '(0 2 3)))))
