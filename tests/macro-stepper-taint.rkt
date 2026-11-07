;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

(require rackunit racket/class racket/list racket/string
         macro-debugger/model/stx-util
         "../racketdap/tools/macro-steps/printing.rkt"
         "../racketdap/tools/macro-steps/facts.rkt"
         (only-in "support/macro-stepper.rkt" view-of without-name-suffixes))

(define (read-term text) (read-syntax 'taint-test (open-input-string text)))
(define (part term #:contents [contents #f] #:suffix-option [suffix-option 'never])
  (define serial 0)
  (define (id _) (set! serial (add1 serial)) (number->string serial))
  ((make-section-renderer id (lambda (_term _phase _known) "syntax") (hasheq) (hasheq))
   term null (hasheq) (hasheq) #:partition (new-foreground-partition)
   #:contents contents #:suffix-option suffix-option #:columns 1000))
(define (marks section)
  (for/list ([o (hash-ref section 'occurrences)] #:when (hash-has-key? o 'taint))
    (list (car (hash-ref o 'range)) (hash-ref o 'taint) (hash-ref o 'taintCount))))
(define (check-render term text expected)
  (define section (part term))
  (check-equal? (hash-ref section 'text) text)
  (check-equal? (marks section) expected)
  section)
(define (opened term) (syntax-property term property:unlocked-by-expander #t))

(module+ test
  (test-case "exact taint, unlocked annotation, precedence and unchanged syntax extents"
    (define tainted (syntax-taint (read-term "(+ 1 2)")))
    (define s (check-render tainted "(+ 1 2)\n" '((0 "tainted" 1))))
    (check-equal? (hash-ref (car (hash-ref s 'occurrences)) 'range) '(0 7))
    (check-equal? (length (hash-ref s 'occurrences)) 4)
    (check-render (opened tainted) "(+ 1 2)\n" '((0 "tainted" 1)))
    (check-render (opened (read-term "x")) "x\n" '((0 "disarmed" 1)))
    (check-render (opened (read-term "(a b)")) "(a b)\n" '((0 "disarmed" 1)))
    (check-false (syntax-armed? (opened #'x)))
    (check-false (syntax-tainted? (opened #'x)))
    ;; Racket 9.1 protection is inert; it must not invent armed marks.
    (define protected (syntax-protect #'(+ 1 2)))
    (if (syntax-armed? protected)
        (check-render protected "(+ 1 2)\n" '((0 "armed" 1)))
        (check-render protected "(+ 1 2)\n" null))
    (void))

  (test-case "prefixes, dotted tails, brackets, suppression, sharing and fresh rendering"
    (define t (syntax-taint (read-term "(a b)")))
    (check-render (datum->syntax #f (list t t t)) "((a b) (a b) (a b))\n"
                  '((1 "tainted" 1) (7 "tainted" 2) (13 "tainted" 3)))
    (check-render t "(a b)\n" '((0 "tainted" 1)))
    (define u (opened (read-term "(a b)")))
    (check-render (datum->syntax #f (list u u u)) "((a b) (a b) (a b))\n"
                  '((1 "disarmed" 1) (7 "disarmed" 2) (13 "disarmed" 3)))
    (check-render (syntax-taint (read-term "'(a b)")) "'(a b)\n" '((0 "tainted" 1)))
    (define q (read-term "'(a b)"))
    (check-render (datum->syntax q (list (car (syntax-e q)) t) q q)
                  "'(a b)\n" '((1 "tainted" 1)))
    (check-render (datum->syntax #f (cons #'a (syntax-taint #'b))) "(a . b)\n" '((5 "tainted" 1)))
    ;; The window loses the mark during bracket restoration. Decorations must
    ;; retain that absence without reproducing the corrupted bracket text.
    (check-render (syntax-taint (read-term "[a b]")) "[a b]\n" null)
    (check-render (syntax-taint (read-term "{a b}")) "{a b}\n" null)
    (check-render (syntax-taint (read-term "\"hello\"")) "\"hello\"\n" '((0 "tainted" 1)))
    (check-render (syntax-taint (read-term "#(a b)")) "#(a b)\n" '((0 "tainted" 1)))
    (check-render (datum->syntax #f (vector t)) "#((a b))\n" '((2 "tainted" 1)))
    (check-render (datum->syntax #f (box t)) "#&(a b)\n" '((2 "tainted" 1)))
    (check-render (datum->syntax #f (make-prefab-struct 'p t)) "#s(p (a b))\n" '((5 "tainted" 1)))
    (check-render (datum->syntax #f (hasheq 'key t)) "#hasheq((key . (a b)))\n" '((15 "tainted" 1)))
    (check-render (datum->syntax #f (list #'a (opened #'()))) "(a ())\n" '((3 "disarmed" 1)))
    (define tail (datum->syntax #f (cons #'a (opened #'()))))
    (check-render tail "(a)\n" null)
    (check-render (syntax-property t 'macro-stepper-hole #t) "[ HOLE ]\n" null)
    (define remark (part #f #:contents (list "literal 💥" t)))
    (check-equal? (hash-ref remark 'text) "literal 💥\n(a b)\n\n")
    ;; Protocol offsets count the literal emoji as two UTF-16 units.
    (check-equal? (marks remark) '((11 "tainted" 1)))
    (define intro (make-syntax-introducer))
    (define suffixed (part (datum->syntax #f (list #'x (intro (opened #'x)))) #:suffix-option 'always))
    (check-equal? (hash-ref suffixed 'text) "(x x:1)\n")
    (check-equal? (marks suffixed) '((3 "disarmed" 1))))

  (define prefix "#lang racket/base\n(require (for-syntax racket/base))\n")
  (test-case "verified transformations, attached error syntax, remarks and successful final syntax"
    (define bad (view-of (string-append prefix "(define-syntax (bad stx)\n  (syntax-taint #'(+ 1 2)))\n(bad)\n") #:hiding "none"))
    (define afters (for/list ([s (hash-ref bad 'steps)] #:when (and (hash-has-key? s 'after) (hash? (hash-ref s 'after)))) (hash-ref s 'after)))
    (check-true (for/or ([s afters])
                  (and (pair? (marks s))
                       (equal? (marks s) (list (list (caar (marks s)) "tainted" 1)))
                       (string-prefix? (substring (hash-ref s 'text) (caar (marks s))) "(+ 1 2)"))))
    (define error-sections (append-map (lambda (d) (hash-ref d 'syntax)) (hash-values (hash-ref bad 'diagnostics))))
    (check-true (for/or ([s error-sections]) (and (equal? (hash-ref s 'text) "+\n") (equal? (marks s) '((0 "tainted" 1))))))
    (define note (view-of "#lang racket/base\n(require (for-syntax racket/base macro-debugger/emit))\n(define-syntax (note stx)\n  (emit-remark \"tainted example\" (syntax-taint #'(list 1 2)))\n  #'0)\n(note)\n" #:hiding "none"))
    (define remark (hash-ref (findf (lambda (s) (and (equal? (hash-ref s 'kind) "remark") (string-prefix? (hash-ref (hash-ref s 'before) 'text) "tainted example"))) (hash-ref note 'steps)) 'before))
    (check-equal? (without-name-suffixes (hash-ref remark 'text)) "tainted example\n(list 1 2)\n\n")
    (check-equal? (marks remark) '((16 "tainted" 1)))
    (define finished (view-of (string-append prefix "(define-syntax (literal stx)\n  #`(quote #,(syntax-taint #'(a b))))\n(literal)\n") #:hiding "none"))
    (define final (hash-ref finished 'final))
    (define text (hash-ref final 'text))
    (check-true (string-contains? (without-name-suffixes text) "(quote (a b))"))
    (define operand-start
      (car (last (regexp-match-positions* #px"\\(a(?::[0-9]+)? b(?::[0-9]+)?\\)" text))))
    (check-equal? (marks final) (list (list operand-start "tainted" 1))))

  (test-case "verified ordinary, protection and opened protection controls have no marks"
    (for ([program (list "#lang racket/base\n(struct point (x y))\n"
                         (string-append prefix "(define-syntax (protected stx)\n  (syntax-protect #'(+ 1 2)))\n(protected)\n")
                         (string-append prefix "(define-syntax (take-apart stx)\n  (syntax-case stx ()\n    [(_ arg) (car (syntax-e #'arg))]))\n(define-syntax (protected stx)\n  #`(take-apart #,(syntax-protect #'(car 1))))\n(protected)\n"))])
      (define answer (view-of program #:hiding "none"))
      (for* ([s (hash-ref answer 'steps)] [key '(before after)]
             #:when (hash? (hash-ref s key #f)))
        (check-equal? (marks (hash-ref s key)) null))
      (check-equal? (marks (hash-ref answer 'final)) null))))
