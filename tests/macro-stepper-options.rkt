;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

(require rackunit racket/list racket/string
         macro-debugger/model/steps
         "../racketdap/tools/macro-source.rkt"
         "../racketdap/tools/macro-steps/expansion.rkt"
         "../racketdap/tools/macro-steps/answer.rkt"
         "../racketdap/tools/macro-steps/policy.rkt"
         (only-in "support/macro-stepper.rkt" request))

(define (trace name body one? rename? [show-let? #f])
  (define inspect #f)
  (define answer
    (call-with-macro-source
     (request (string-append "#lang racket/base\n" body) #:mode "module" #:source (build-path (current-directory) (string-append name ".rkt")))
     (lambda (stx)
       (define custom
         (and show-let?
              (parameterize ([current-namespace (make-base-namespace)])
                (hash-set (hasheq 'enabled #t 'racket #t 'library #t 'contracts #t 'phase #t)
                          'rules (list (make-hiding-rule (namespace-symbol->identifier 'let)
                                                       (hasheq 'id "let" 'action "show") #f))))))
       (expansion-steps stx (if custom "custom" "standard") #:custom custom
                        #:schema-version 2 #:one-term? one? #:include-renaming? rename?
                        #:retain-inspector (lambda (query) (set! inspect query))))))
  (values answer (lambda (position factor?)
                   (inspect (hasheq 'mode "position" 'position position 'factorCommonContext factor? 'columns 160)))))
(define (text section) (if (eq? section 'null) "" (hash-ref section 'text)))
(define (view p)
  (define r (hash-ref p 'record))
  (if (eq? r 'null)
      (text (hash-ref p 'final))
      (string-append (text (hash-ref r 'before)) (text (hash-ref r 'after))
                     (if (hash-has-key? r 'commonContext)
                         (string-append "\nIn context:\n" (text (hash-ref r 'commonContext))) ""))))
(define own-definition "(define-syntax-rule (m x) (+ x 1))")
(define cases
  (list (list "own" (string-append own-definition "\n(m 2)")
              (list "(m 2)" "(+ 2 1)") (list "(m 2)") (list "(+ 2 1)") (list "[ HOLE ]") #f)
        (list "larger" "(define z 9)\n(+ z (let ([x 1]) x))"
              (list "(+ z (let ([x 1]) x))" "(+ z (let-values (((x) 1)) x))")
              (list "(let ([x 1]) x)") (list "(let-values (((x) 1)) x)") (list "(+ z [ HOLE ])") #t)
        (list "nested" (string-append own-definition "\n(m (m 2))")
              (list "(m (m 2))" "(+ (m 2) 1)" "(+ (+ 2 1) 1)")
              (list "(m (m 2))" "(m 2)") (list "(+ (m 2) 1)" "(+ 2 1)")
              (list "[ HOLE ]" "(+ [ HOLE ] 1)") #f)))
(define (module-text name expression)
  (format "(module ~a racket/base (#%module-begin ~a ~a))\n" name
          (if (equal? name "larger") "(define z 9)" own-definition) expression))

(module+ test
  (for ([example cases])
    (define name (list-ref example 0))
    (define states (list-ref example 2))
    (define total (length states))
    (for* ([one? '(#f #t)] [factor? '(#f #t)])
      (test-case (format "~a exact complete trace: split ~a, context ~a" name one? factor?)
        (define-values (summary get) (trace name (list-ref example 1) one? #f (list-ref example 6)))
        (check-equal? (hash-ref summary 'stepCount) (* (sub1 total) (if one? 2 1)))
        (for ([i (in-range (sub1 total))])
          (define label "")
          (cond [one?
                 (for ([offset '(1 2)] [side '(before after)] [value (list (list-ref states i) (list-ref states (add1 i)))])
                   (define p (get (+ (* 2 i) offset) factor?))
                   (define record (hash-ref p 'record))
                   (check-equal? (view p) (string-append label (module-text name value)))
                   (check-equal? (hash-ref record (if (eq? side 'before) 'after 'before)) 'null)
                   (check-equal? (hash-ref record 'commonContext 'null) 'null))]
                [else
                 (check-equal? (view (get (add1 i) factor?))
                   (if factor?
                     (string-append (list-ref (list-ref example 3) i) "\n" label
                                    (list-ref (list-ref example 4) i) "\n\nIn context:\n"
                                    (module-text name (list-ref (list-ref example 5) i)))
                     (string-append (module-text name (list-ref states i)) label
                                    (module-text name (list-ref states (add1 i))))))]))
        (define final (get (add1 (hash-ref summary 'stepCount)) factor?))
        (check-equal? (view final) (module-text name (last states)))
        (check-equal? (hash-ref final 'count) (add1 (* (sub1 total) (if one? 2 1)))))))

  (test-case "larger renamings have exact residual fragments, dotted tail, totals and split text"
    (for* ([one? '(#f #t)] [factor? '(#f #t)])
      (define-values (summary get) (trace "larger" (list-ref (cadr cases) 1) one? #t #t))
      (check-equal? (hash-ref summary 'stepCount) (if one? 8 4))
      (for ([index '(1 2 3)]
            [label '("Introduce scope for local bindings" "Introduce scope for internal definition context" "Resolve variable (remove extra scopes)")]
            [fragment '("(let-values (((x) 1)) x)" "(x)" "x")]
            [context '("(+ z [ HOLE ])" "(+ z (let-values (((x) 1)) . [ HOLE ]))" "(+ z (let-values (((x) 1)) [ HOLE ]))")])
        (define separator "")
        (define full (module-text "larger" "(+ z (let-values (((x) 1)) x))"))
        (if one?
            (for ([offset '(1 2)])
              (check-equal? (view (get (+ (* index 2) offset) factor?)) (string-append separator full)))
            (check-equal? (view (get (add1 index) factor?))
                          (if factor? (string-append fragment "\n" separator fragment "\n\nIn context:\n" (module-text "larger" context))
                              (string-append full separator full)))))))

  (test-case "preserved empty wrapper differs from no shared frame; nonshared wrappers remain in fragments"
    (define x #'x) (define y #'y)
    (define wrapper (lambda (e) e))
    (define outer (lambda (e) (datum->syntax #f (list #'list e))))
    (define left (lambda (e) (datum->syntax #f (list #'before e))))
    (define right (lambda (e) (datum->syntax #f (list #'after e))))
    (define (state* e ctx) (state e (list e) ctx null (hasheq) (hasheq) (hasheq) 1))
    (for ([contexts (list (list null null) (list (list wrapper) (list wrapper))
                         (list (list left outer) (list right outer))) ]
          [expected '(#f "[ HOLE ]\n" "(list [ HOLE ])\n")])
      (define inspect #f)
      (expansion-answer (list (step 'macro (state* x (car contexts)) (state* y (cadr contexts))))
                        (hasheq) (hasheq) y #f x (hasheq) null #:retain-inspector (lambda (q) (set! inspect q)))
      (define r (hash-ref (inspect (hasheq 'mode "position" 'position 1 'factorCommonContext #t)) 'record))
      (unless expected
        (check-equal? (hash-ref r 'commonContext 'null) 'null)
        (check-equal? r (hash-ref (inspect (hasheq 'mode "position" 'position 1 'factorCommonContext #f)) 'record)))
      (when expected (check-equal? (text (hash-ref r 'commonContext)) expected))
      (when (= (length (car contexts)) 2)
        (check-equal? (text (hash-ref r 'before)) "(before x)\n")
        (check-equal? (text (hash-ref r 'after)) "(after y)\n")))))

(module+ test
  (test-case "split halves retain their own progress, transformer contexts, focus and frontier; singles stay single"
    (define before #'(m x)) (define after #'(list x))
    (define transformer1 #'(outer-before x)) (define transformer2 #'(outer-after x))
    (define (state* e seq transformer)
      (state e (list e) null (list (bigframe null (list transformer) transformer))
             (hasheq) (hasheq) (hasheq e #t) seq))
    (define s1 (state* before 10 transformer1)) (define s2 (state* after 30 transformer2))
    (define remark (remarkstep 'remark s1 (list "note" #'(list 1))))
    (define error (misstep 'error s2 (exn:fail "stopped" (current-continuation-marks))))
    (for ([one? '(#f #t)])
      (define inspect #f)
      (define summary
        (expansion-answer (list remark (step 'macro s1 s2) error) (hasheq) (hasheq) #f
                          (misstep-exn error) before (hasheq) null #:one-term? one?
                          #:retain-inspector (lambda (q) (set! inspect q))))
      (check-equal? (hash-ref summary 'stepCount) (if one? 4 3))
      (check-equal? (map (lambda (s) (hash-ref s 'expansionPoint)) (hash-ref summary 'steps))
                    (if one? '(10 10 30 30) '(10 10 30)))
      (define (get n) (inspect (hasheq 'mode "position" 'position n 'factorCommonContext #t)))
      (define remark-record (hash-ref (get 1) 'record))
      (check-equal? (text (hash-ref remark-record 'before)) "note\n(list 1)\n\n")
      (check-equal? (hash-ref remark-record 'after) 'null)
      (when one?
        (for ([n '(2 3)] [side '(before after)] [expected (list transformer1 transformer2)])
          (define r (hash-ref (get n) 'record))
          (define width (if (eq? side 'before) 5 8))
          (check-equal? (hash-ref r 'side) (symbol->string side))
          (check-equal? (hash-ref (hash-ref r side) 'focus) (list (list 0 width)))
          (check-equal? (hash-ref (hash-ref r side) 'frontier) (list (list 0 width)))
          (check-equal? (string-trim (text (hash-ref (car (hash-ref r 'contexts)) 'section)))
                        (format "~s" (syntax->datum expected)))))
      (define terminal (get (add1 (hash-ref summary 'stepCount))))
      (check-equal? (hash-ref terminal 'final) 'null)
      (check-equal? (hash-ref (hash-ref (hash-ref terminal 'diagnostics) (string->symbol (hash-ref terminal 'error))) 'message) "stopped")))

  (test-case "binding endpoints must coexist within a printed fragment or context"
    (define binder #'x) (define use (datum->syntax binder 'x))
    (define term (datum->syntax #f (list #'let-values (list (list (list binder) #'1)) use)))
    (define wrapper (lambda (e) (datum->syntax #f (list #'list e))))
    (define context-binder (lambda (e) (datum->syntax #f (list #'let-values (list (list (list binder) #'1)) e))))
    (define (get e ctx)
      (define s (state e (list use) ctx null (hasheq binder 0) (hasheq use 0) (hasheq) 1))
      (define inspect #f)
      (expansion-answer (list (step 'macro s s)) (hasheq) (hasheq) e #f term (hasheq) null
                        #:retain-inspector (lambda (q) (set! inspect q)))
      (hash-ref (inspect (hasheq 'mode "position" 'position 1 'factorCommonContext #t)) 'record))
    (define inside (get term (list wrapper)))
    (check-true (pair? (hash-ref (hash-ref inside 'after) 'edges)))
    (define separated (get use (list context-binder)))
    (for ([key '(before after commonContext)])
      (check-equal? (hash-ref (hash-ref separated key) 'edges) null))
    (check-equal? (hash-ref (hash-ref separated 'commonContext) 'focus) null)
    (check-equal? (hash-ref (hash-ref separated 'commonContext) 'frontier null) null)))

(module+ test
  (test-case "factoring encounters Before, After, common context in order and preserves assigned suffixes on toggles"
    (define before ((make-syntax-introducer) #'before))
    (define after ((make-syntax-introducer) #'after))
    (define context ((make-syntax-introducer) #'context))
    (define wrapper (lambda (e) (datum->syntax #f (list #'list e context))))
    (define (s e) (state e (list e) (list wrapper) null (hasheq) (hasheq) (hasheq) 1))
    (for ([first-factored? '(#f #t)])
      (define inspect #f)
      (expansion-answer (list (step 'macro (s before) (s after))) (hasheq) (hasheq) after #f before (hasheq) null
                        #:retain-inspector (lambda (q) (set! inspect q)))
      (define (get factored?)
        (hash-ref (inspect (hasheq 'mode "position" 'position 1 'factorCommonContext factored? 'suffixOption "always")) 'record))
      (define initial (get first-factored?))
      (define factored (get #t))
      (check-equal? (text (hash-ref factored 'before)) "before:1\n")
      (check-equal? (text (hash-ref factored 'after)) (if first-factored? "after:2\n" "after:3\n"))
      (check-equal? (text (hash-ref factored 'commonContext))
                    (if first-factored? "(list [ HOLE ] context:3)\n" "(list [ HOLE ] context:2)\n"))
      (get #f)
      (check-equal? (get #t) factored))))
