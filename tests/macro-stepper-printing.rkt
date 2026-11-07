#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Macro steps printing tests.
(require racket/class
         racket/pretty
         macro-debugger/syntax-browser/partition
         racket/list
         racket/string
         rackunit
         (only-in "../racketdap/tools/macro-source.rkt" call-with-macro-source)
         (only-in "../racketdap/tools/macro-steps/printing.rkt" layout new-foreground-partition)
         (only-in "../racketdap/tools/macro-steps/expansion.rkt" expansion-steps)
         (only-in "support/macro-stepper.rkt" request steps-of sample text-of focused-text structural-focus
                  model-fixture syntax-objects view-of appearance-text term-named))

(module+ test
  (define (read-display text)
    (define in (open-input-string text))
    (port-count-lines! in)
    (read-syntax 'display-test in))

  (define (printed-text term #:partition [partition (new-foreground-partition)]
                        #:suffix-option [option 'over-limit] #:pretty-abbrev? [abbrev? #t]
                        #:color-count [count 17])
    (define-values (text _) (layout term #:partition partition #:suffix-option option
                                    #:pretty-abbrev? abbrev? #:color-count count #:columns 1000))
    (string-trim text #:left? #f))

  (define (numbered-fixture)
    (define partition (new-foreground-partition))
    (define introducers (list->vector (cons values (for/list ([_ (in-range 44)]) (make-syntax-introducer)))))
    (for ([i (in-range 1 45)])
      ;; Nonidentifiers allocate groups too, in display order.
      (printed-text ((vector-ref introducers i) (datum->syntax #f i)) #:partition partition))
    (values partition (lambda (group term) ((vector-ref introducers group) term))))

  (test-case "exact suffix table and names share a foreground number"
    (define-values (partition at) (numbered-fixture))
    (for ([group '(0 1 16 17 18 44)]
          [needed '("x" "x" "x" "x" "x:18" "x:44")]
          [always '("x" "x:1" "x:16" "x:17" "x:18" "x:44")])
      (define x (at group (datum->syntax #f 'x)))
      (check-equal? (printed-text x #:partition partition #:suffix-option 'never) "x")
      (check-equal? (printed-text x #:partition partition) needed)
      (check-equal? (printed-text x #:partition partition #:suffix-option 'always) always))
    (define (id group name) (at group (datum->syntax #f name)))
    (define small (datum->syntax #f (list 'list (id 1 'x) (id 2 'x))))
    (check-equal? (printed-text small #:partition partition) "(list x x)")
    (check-equal? (printed-text small #:partition partition #:suffix-option 'always) "(list x:1 x:2)")
    (check-equal? (printed-text (id 18 'fresh) #:partition partition) "fresh:18")
    (check-equal? (printed-text (datum->syntax #f (list 'list (id 18 'left) (id 18 'right)))
                                #:partition partition) "(list left:18 right:18)")
    (check-equal? (printed-text (id 31 'define-values) #:partition partition) "define-values:31")
    (check-equal? (printed-text (id 42 '#%app) #:partition partition) "#%app:42")
    (check-equal? (printed-text (id 18 'x:9) #:partition partition) "x:9:18")
    (check-equal? (printed-text (id 18 '|two words|) #:partition partition) "|two words:18|")
    (check-equal? (printed-text (id 17 'x) #:partition partition #:color-count 16) "x:17")
    (check-equal? (printed-text (id 18 'x) #:partition partition #:color-count 18) "x")
    (check-equal? (printed-text (vector 'fresh 5 "fresh" '#:fresh) #:partition partition)
                  "#(fresh 5 \"fresh\" #:fresh)"))

  (test-case "escaped suffixed names retain valid full token ranges"
    (define-values (partition at) (numbered-fixture))
    (define term (at 18 (datum->syntax #f '|two words|)))
    (define-values (text ranges) (layout term #:partition partition))
    (check-equal? text "|two words:18|\n")
    (check-equal? (map (lambda (span) (apply substring text span)) (hash-ref ranges term))
                  '("|two words:18|")))

  (test-case "numbered swap! follows the per-identifier threshold"
    (define-values (partition at) (numbered-fixture))
    (define (made name) (at 2 (datum->syntax #f name)))
    (define source (datum->syntax #f 'tmp))
    (define other (datum->syntax #f 'other))
    (define binding (syntax-property (datum->syntax #f (list (made 'tmp) source)) 'paren-shape #\[))
    (define term (datum->syntax #f (list (made 'let) (list binding)
                                       (list (made 'set!) source other)
                                       (list (made 'set!) other (made 'tmp)))))
    (check-equal? (printed-text term #:partition partition)
                  "(let ([tmp tmp]) (set! tmp other) (set! other tmp))")
    (check-equal? (printed-text term #:partition partition #:suffix-option 'always)
                  "(let:2 ([tmp:2 tmp]) (set!:2 tmp other) (set!:2 other tmp:2))"))

  (test-case "all eight abbreviations precede suffixes, including group 44"
    (define-values (partition at) (numbered-fixture))
    (for ([head '(quote quasiquote unquote unquote-splicing syntax quasisyntax unsyntax unsyntax-splicing)]
          [prefix '("'" "`" "," ",@" "#'" "#`" "#," "#,@")])
      (define form (read-display (string-append prefix "x")))
      (check-equal? (printed-text form) (string-append prefix "x"))
      (define marked (at 44 form))
      (for ([option '(over-limit always never)])
        (check-equal? (printed-text marked #:partition partition #:suffix-option option)
                      (string-append prefix (if (eq? option 'never) "x" "x:44")))
        (check-equal? (printed-text marked #:partition partition #:suffix-option option #:pretty-abbrev? #f)
                      (if (eq? option 'never) (format "(~a x)" head) (format "(~a:44 x:44)" head))))))

  (test-case "exact reader and explicit quote examples"
    (for ([source '("'5" "'()" "(quote ())" "''x" "(quote x extra)" "(quote . x)"
                        "'#%kernel" "'syntax/loc" "(quote d)" "(quote 5)")]
          [expected '("'5" "'()" "(quote ())" "''x" "(quote x extra)" "(quote . x)"
                          "'#%kernel" "'syntax/loc" "(quote d)" "(quote 5)")])
      (check-equal? (printed-text (read-display source)) expected))
    (check-equal? (printed-text (datum->syntax #f '(quote x))) "'x")
    ;; A locally bound same-spelled keyword can qualify; a renamed one cannot.
    (let ([quote #f])
      (check-equal? (printed-text (datum->syntax #'quote (list (string->symbol "quote") (string->symbol "x")))) "'x"))
    (check-equal? (printed-text (datum->syntax #'quote '(q x))) "(q x)"))

  (test-case "quote metadata compares every required field and ignores span"
    (define original (read-display "'x"))
    (define parts (syntax->list original))
    (define head (car parts))
    (define operand (cadr parts))
    (for ([location (list (list 'other-source 1 0 1 1)
                          (list 'display-test 2 0 1 1)
                          (list 'display-test 1 1 1 1)
                          (list 'display-test 1 0 2 1))])
      (define changed (datum->syntax head 'quote location head))
      (check-equal? (printed-text (datum->syntax original (list changed operand) original original))
                    "(quote x)"))
    (define changed-span (datum->syntax head 'quote (list 'display-test 1 0 1 99) head))
    (check-equal? (printed-text (datum->syntax original (list changed-span operand) original original)) "'x")
    (define nonoriginal (datum->syntax head 'quote head))
    (check-equal? (printed-text (datum->syntax original (list nonoriginal operand) original original)) "(quote x)")
    (define different-context ((make-syntax-introducer) head))
    (check-equal? (printed-text (datum->syntax original (list different-context operand) original original)
                                #:suffix-option 'never) "(quote x)")
    (define-values (partition at) (numbered-fixture))
    ;; The expanded form has the use location; its head retains the template location.
    (define moved (at 44 (datum->syntax original (syntax-e (read-display "'a"))
                                        (list 'use-location 2 0 10 2) original)))
    (check-equal? (printed-text moved #:partition partition) "(quote:44 a:44)")
    (check-equal? (printed-text moved #:partition partition #:suffix-option 'never) "(quote a)"))

  (test-case "render traversal allocates compounds and atoms before identifiers and skips list tails"
    (define partition (new-foreground-partition))
    (define (fresh value) ((make-syntax-introducer) (datum->syntax #f value)))
    (define root (fresh 'root))
    (define first (fresh 'first))
    (define number (fresh 5))
    (define empty (fresh '()))
    (define last-id (fresh 'last))
    (define skipped (fresh '()))
    (define term (datum->syntax root (cons first (datum->syntax #f (list number empty last-id)))))
    (check-equal? (printed-text term #:partition partition #:suffix-option 'always)
                  "(first:2 5 () last:5)")
    (check-equal? (send partition get-partition root) 1)
    (define tail-term (datum->syntax #f (cons 'x skipped)))
    (check-equal? (printed-text tail-term #:partition partition) "(x)")
    (check-equal? (send partition get-partition skipped) 6)
    (define never-partition (new-foreground-partition))
    (define appearances (box null))
    (define-values (_text _ranges) (layout term #:partition never-partition #:suffix-option 'never
                                          #:appearances appearances))
    (check-equal? (send never-partition get-partition root) 1)
    (check-equal? (send never-partition get-partition number) 2)
    (check-equal? (send never-partition get-partition empty) 3)
    (check-equal? (send never-partition get-partition first) 4)
    (check-equal? (send never-partition get-partition last-id) 5))

  (test-case "abbreviation traversal omits its head and tail and visits its operand"
    (define enclosing ((make-syntax-introducer) (datum->syntax #f 'context)))
    (define operand ((make-syntax-introducer) (datum->syntax #f 'x)))
    (define tail-context ((make-syntax-introducer) (datum->syntax #f 'tail)))
    (define tail (datum->syntax tail-context (list operand)))
    (define form (datum->syntax enclosing (cons (datum->syntax enclosing 'quote) tail)))
    (define partition (new-foreground-partition))
    (check-equal? (printed-text form #:partition partition #:suffix-option 'always) "'x:2")
    (check-equal? (send partition get-partition tail-context) 3))

  (test-case "worked list traversal numbers the nonempty spine and literal, but not its terminator"
    (define (fresh value) ((make-syntax-introducer) (datum->syntax #f value)))
    (define outer (fresh 'outer))
    (define x (fresh 'x))
    (define spine (fresh 'spine))
    (define y (fresh 'y))
    (define number (fresh 7))
    (define end (fresh null))
    (define term
      (datum->syntax outer
                     (cons x (datum->syntax spine (cons y (cons number end))))))
    (define partition (new-foreground-partition))
    (check-equal? (printed-text term #:partition partition #:suffix-option 'always) "(x:2 y:4 7)")
    (check-equal? (send partition next-number) 6)
    (check-equal? (printed-text (datum->syntax number 'z) #:partition partition #:suffix-option 'always) "z:5")
    (check-equal? (send partition get-partition end) 6)
    (define suppressed (new-foreground-partition))
    (check-equal? (printed-text term #:partition suppressed #:suffix-option 'never) "(x y 7)")
    (check-equal? (printed-text term #:partition suppressed #:suffix-option 'always) "(x:4 y:5 7)")
    (check-equal? (send suppressed get-partition number) 3))

  (test-case "worked threshold counts enclosing syntax before core identifiers"
    (define partition (new-foreground-partition))
    (define (fresh value) ((make-syntax-introducer) (datum->syntax #f value)))
    (for ([i (in-range 1 17)]) (printed-text (fresh i) #:partition partition))
    (define outer (fresh 'outer))
    (define let-id (fresh 'let-values))
    (define inner (fresh 'inner))
    (define term (datum->syntax outer
                               (list let-id (datum->syntax #f null)
                                     (datum->syntax inner
                                                    (list (datum->syntax inner '#%expression)
                                                          (datum->syntax #f 7))))))
    (check-equal? (printed-text term #:partition partition) "(let-values:18 () (#%expression:19 7))")
    (check-equal? (send partition get-partition outer) 17)
    (check-equal? (send partition next-number) 20))

  (test-case "foreground grouping uses scope lists independently of binding comparisons"
    (define macro-partition (new-foreground-partition))
    (define all-partition (new-foreground-partition 'all))
    (define source (datum->syntax #f 'x))
    (define local (let ([x 1]) #'x))
    (check-equal? (send macro-partition get-partition local) 0)
    (check-true (positive? (send all-partition get-partition local)))
    (define introduce (make-syntax-introducer))
    (define a (introduce source))
    (define b (introduce (datum->syntax local 'other)))
    (check-equal? (send macro-partition get-partition a) (send macro-partition get-partition b))
    (check-false (bound-identifier=? a b))
    (check-equal? (send macro-partition get-partition ((make-syntax-introducer) source)) 2))

  (test-case "compound field traversal preserves vector box prefab and hash encounter order"
    (define (fresh value) ((make-syntax-introducer) (datum->syntax #f value)))
    (define a (fresh 'a))
    (define b (fresh 'b))
    (define c (fresh 'c))
    (check-equal? (printed-text (vector a (box b) (make-prefab-struct 'cell c a)) #:suffix-option 'always)
                  "#(a:1 #&b:2 #s(cell c:3 a:1))")
    (define key (fresh 'key))
    (define value (fresh 'value))
    (define hash-partition (new-foreground-partition))
    (check-equal? (printed-text (hasheq key value) #:partition hash-partition #:suffix-option 'always)
                  "#hasheq((#<syntax key> . value:1))")
    (check-equal? (send hash-partition next-number) 2)
    (define tail-context (fresh 'tail))
    (define tail (datum->syntax tail-context (list a b)))
    (check-equal? (printed-text (datum->syntax #f (cons c tail)) #:suffix-option 'always)
                  "(c:1 a:3 b:4)"))

  (test-case "default suffix and quotation worked examples"
    (define x (datum->syntax #f 'x))
    (define x1 ((make-syntax-introducer) x))
    (define x2 ((make-syntax-introducer) x))
    (define-values (text _) (layout (datum->syntax #f (list 'list x1 x2))))
    (check-equal? text "(list x x)\n")
    (define-values (quote-text _quote-ranges) (layout (datum->syntax #f '(quote x))))
    (check-equal? quote-text "'x\n"))

  (test-case "Standard swap! exact focused text has no suffix"
    (for ([answer (list (steps-of sample) (view-of sample))])
      (define after (hash-ref (cadr (hash-ref answer 'steps)) 'after))
      (check-equal? (map (lambda (s) (regexp-replace* #px"\\s+" s " ")) (focused-text after))
                    '("(let ([tmp tmp]) (set! tmp other) (set! other tmp))"))))

  (test-case "small foreground groups keep original spellings and name ranges"
    (define introduce (make-syntax-introducer))
    (define written (datum->syntax #f 'same))
    (define made (introduce written))
    (define lone (introduce (datum->syntax #f 'unique)))
    (define term (datum->syntax #f (list written made made lone)))
    (define partition (new-macro-scopes-partition))
    (define-values (text ranges) (layout term #:partition partition))
    (define group (send partition get-partition made))
    (check-equal? text "(same same same unique)\n")
    (check-true (positive? group))
    (check-equal? (map (lambda (r) (apply substring text r)) (hash-ref ranges made)) '("same" "same"))
    (define-values (alone _) (layout (datum->syntax #f (list made lone))))
    (check-equal? alone "(same unique)\n")
    (define another ((make-syntax-introducer) written))
    (define-values (both _both-ranges) (layout (datum->syntax #f (list made another))))
    (check-equal? both "(same same)\n"))

  (test-case "small marked reader forms retain abbreviations and omit their heads"
    (for ([prefix '("'" "`" "," ",@" "#'" "#`" "#," "#,@")])
      (define in (open-input-string (string-append prefix "x")))
      (port-count-lines! in)
      (define form (read-syntax 'reader-test in))
      (define head (car (syntax->list form)))
      (define introduced ((make-syntax-introducer) form))
      (define term (datum->syntax #f (list head introduced)))
      (define-values (text ranges) (layout term))
      (define made-head (car (syntax->list introduced)))
      (define name (symbol->string (syntax-e head)))
      (check-equal? text (format "(~a ~ax)\n" name prefix))
      (check-equal? (map (lambda (r) (apply substring text r)) (hash-ref ranges made-head null))
                    null)))

  (test-case "expanded false is printed as a full quote form in both schemas"
    (define program
      "#lang racket/base\n(define-syntax-rule (false-value) (quote #f))\n(false-value)\n")
    (for ([answer (list (steps-of program) (view-of program))])
      (define final (hash-ref answer 'final))
      (define final-text (if (string? final) final (hash-ref final 'text)))
      (check-regexp-match #px"[(]quote(?::[0-9]+)? #f[)]" final-text)
      (check-false (string-contains? final-text "'#f"))
      (define step (car (hash-ref answer 'steps)))
      (check-equal? (structural-focus (hash-ref step 'after)) '("(quote #f)"))
      (for ([key '(before after)])
        (define part (hash-ref step key))
        (check-regexp-match #px"[(]quote(?::[0-9]+)? #f[)]" (hash-ref part 'text))
        (check-false (string-contains? (hash-ref part 'text) "'#f")))
      (when (hash? final)
        (for ([part (list (hash-ref step 'before) (hash-ref step 'after) final)])
          (for ([occurrence (term-named answer part "quote")])
            (check-equal? (appearance-text part occurrence) "quote"))))))

  (for ([version '(1 2)])
    (test-case (format "schema ~a distinguishes source and macro-produced quotes" version)
      (define program
        "#lang racket/base\n(define-syntax-rule (made) (quote 3))\n(list '(1 2) (made))\n")
      (define answer ((if (= version 1) steps-of view-of) program))
      (define step (car (hash-ref answer 'steps)))
      (check-equal? (structural-focus (hash-ref step 'after)) '("(quote 3)"))
      (define final (hash-ref answer 'final))
      (for ([text (list (text-of step 'before) (text-of step 'after)
                        (if (string? final) final (hash-ref final 'text)))])
        (check-true (string-contains? text "'(1 2)"))
        (check-regexp-match #px"[(]quote(?::[0-9]+)? 3[)]" text)
        (check-false (string-contains? text "'3")))))

  (for ([version '(1 2)])
    (test-case (format "schema ~a preserves a source-written configure-runtime reader quote" version)
      (call-with-macro-source
       ;; An explicit submodule keeps this fixture independent of how the
       ;; installed language constructs its default runtime configuration.
       (request "#lang racket/base\n(module configure-runtime '#%kernel (#%module-begin))\n" #:mode "module")
       (lambda (stx)
         (define query #f)
         (define answer
           (expansion-steps stx "none" #:schema-version version
                            #:retain-inspector (lambda (q) (set! query q))))
         (define final
           (if (= version 1) (hash-ref answer 'final)
               (hash-ref (query (hasheq 'mode "position" 'position (add1 (hash-ref answer 'stepCount))))
                         'final)))
         (define text (if (string? final) final (hash-ref final 'text)))
         (check-true (string-contains? text "configure-runtime"))
         (check-true (string-contains? text "'#%kernel"))
         (check-false (string-contains? text "(quote #%kernel)"))))))

  (test-case "the default configure-runtime quote keeps its reader abbreviation"
    ;; Some language versions introduce this form through a macro, whose head
    ;; is no longer original even though it retains the abbreviation's span.
    (define expanded (list-ref (model-fixture "#lang racket/base\n") 3))
    (define quotes
      (filter (lambda (form) (equal? (syntax->datum form) '(quote #%kernel)))
              (syntax-objects expanded)))
    (check-true (pair? quotes))
    (for ([form quotes])
      (define-values (text ranges) (layout form))
      (define head (car (syntax->list form)))
      (check-equal? text "'#%kernel\n")
      (check-false (hash-has-key? ranges head))))

  (test-case "layout abbreviates matching generated forms and retains operand ranges"
    (for ([head '(quote quasiquote unquote unquote-splicing
                       syntax quasisyntax unsyntax unsyntax-splicing)]
          [prefix '("'" "`" "," ",@" "#'" "#`" "#," "#,@")])
      (define term (datum->syntax #f (list head 'x)))
      (define-values (text ranges)
        (parameterize ([pretty-print-abbreviate-read-macros #t]) (layout term)))
      (check-equal? text (string-append prefix "x\n"))
      (check-false (hash-has-key? ranges (car (syntax->list term))))
      (for ([identifier (cdr (syntax->list term))])
        (check-equal? (map (lambda (range) (apply substring text range))
                           (hash-ref ranges identifier))
                      (list (symbol->string (syntax-e identifier)))))))

  (test-case "layout compares reader context and source starts without comparing spans"
    (for ([head '(quote quasiquote unquote unquote-splicing
                       syntax quasisyntax unsyntax unsyntax-splicing)]
          [prefix '("'" "`" "," ",@" "#'" "#`" "#," "#,@")])
      (define (read-term text)
        (define in (open-input-string text))
        (port-count-lines! in)
        (read-syntax 'reader-test in))
      (define abbreviated (read-term (string-append prefix "x")))
      (define original-head (car (syntax->list abbreviated)))
      (check-true (syntax-original? original-head))
      (check-equal? (syntax-span original-head) (string-length prefix))
      (define (check-layout term expected)
        (define-values (text ranges) (layout term))
        (check-equal? text (string-append expected "\n"))
        (check-equal? (map (lambda (range) (apply substring text range)) (hash-ref ranges term))
                      (list expected))
        (define argument (cadr (syntax->list term)))
        (check-equal? (map (lambda (range) (apply substring text range)) (hash-ref ranges argument))
                      '("x"))
        (define id (car (syntax->list term)))
        (if (string=? expected (string-append prefix "x"))
            (check-false (hash-has-key? ranges id))
            (check-equal? (map (lambda (range) (apply substring text range)) (hash-ref ranges id))
                          (list (symbol->string head)))))
      (check-layout abbreviated (string-append prefix "x"))
      (check-layout (read-term (format "(~a x)" head)) (format "(~a x)" head))
      ;; Losing original status does not erase a reader abbreviation.
      (define generated-head (datum->syntax #f head original-head))
      (check-false (syntax-original? generated-head))
      (check-layout (datum->syntax #f (list generated-head (cadr (syntax->list abbreviated))) abbreviated)
                    (string-append prefix "x"))
      ;; Retaining the original head alone is insufficient if the form moved.
      (define moved
        (datum->syntax #f (syntax-e abbreviated)
                       (list 'reader-test 1 1 2 (syntax-span abbreviated))))
      (check-layout moved (format "(~a x)" head))
      (define wrong-span
        (datum->syntax original-head head
                       (list 'reader-test 1 0 1 (add1 (string-length prefix))) original-head))
      (check-true (syntax-original? wrong-span))
      (check-layout (datum->syntax #f (list wrong-span (cadr (syntax->list abbreviated))) abbreviated abbreviated)
                    (string-append prefix "x"))))
)
