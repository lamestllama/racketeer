#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Which stops a program has and where a press lands, read as source text.
(require rackunit racket/file racket/format racket/list racket/port racket/string
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt"
         "../racketdap/worker/stepping.rkt")

(define (with-program text use)
  (define directory (make-temporary-file "step-stops-~a" 'directory))
  (dynamic-wind
    void
    (lambda ()
      (define program (build-path directory "program.rkt"))
      (display-to-file text program)
      (use program))
    (lambda () (delete-directory/files directory))))

;; A stop as a person reads it: before and the source text, or after and the value.
(define ((stop-row text) stop)
  (define descriptor (stop-site stop))
  (define source
    (substring text (sub1 (site-position descriptor))
               (+ (sub1 (site-position descriptor)) (site-span descriptor))))
  (case (stop-kind stop)
    [(before) (list 'before source)]
    [else (list* 'after source (map shown (stop-results stop)))]))
;; A procedure's printed name holds the temporary file's path.
(define (shown value) (if (procedure? value) "#<procedure>" (~s value)))

;; Every stop a program reaches when each press is Step, with the program's results.
(define (stops text #:language [language #f])
  (with-program
   text
   (lambda (program)
     (define rows '())
     (define row (stop-row text))
     (parameterize ([current-output-port (open-output-nowhere)])
       (run-module program #:language language
                   #:on-event (lambda (stop) (set! rows (cons (row stop) rows)))))
     (reverse rows))))
;; What a program prints, run under the debugger or not.
(define (printed text #:instrument? instrument?)
  (with-program
   text
   (lambda (program)
     (define output (open-output-string))
     (parameterize ([current-output-port output])
       (run-module program #:instrument? instrument?
                   #:on-event (and instrument? void)))
     (get-output-string output))))
;; The stop at which the first stop matching at is reached, then where each press in
;; presses lands, starting from it.
(define (presses text at modes #:reasons? [reasons? #f])
  (with-program
   text
   (lambda (program)
     (define rows '())
     (define row (stop-row text))
     (define command #f)
     (define started? #f)
     (define remaining modes)
     (define (press! stop)
       (cond
         [(null? remaining) (set! command #f)]
         [else
          (set! command (make-step (car remaining) stop))
          (set! remaining (cdr remaining))]))
     (parameterize ([current-output-port (open-output-nowhere)])
       (run-module
        program
        #:on-event
        (lambda (stop)
          (cond
            [(not started?)
             (when (equal? (row stop) at)
               (set! started? #t)
               (press! stop))]
            [(and command (step-reason command stop))
             (set! rows (cons (if reasons? (step-reason command stop) (row stop)) rows))
             (press! stop)]))))
     (check-true started? (format "never reached ~s" at))
     (reverse rows))))

(module+ test
  (test-case "a function expression returned from a body is as atomic as any other"
    (check-equal?
     (stops (string-append
             "#lang racket/base\n"
             "(define (make) (lambda (x) x))\n"
             "(define (make-with) (define y 1) (lambda (x) (+ x y)))\n"
             "(define (make-case) (case-lambda [(x) x] [(x y) y]))\n"
             "(void (make) (make-with) (make-case))\n"))
     '((before "(void (make) (make-with) (make-case))")
       (before "(make)") (after "(make)" "#<procedure>")
       (before "(make-with)") (after "(make-with)" "#<procedure>")
       (before "(make-case)") (after "(make-case)" "#<procedure>")
       (after "(void (make) (make-with) (make-case))" "#<void>"))))
  (test-case "a function expression standing alone in a module body keeps its stops"
    (check-equal?
     (map car (stops "#lang racket/base\n(lambda (w) w)\n"))
     '(before after)))
  (test-case "a function called from the body still has its stops"
    (check-equal?
     (stops "#lang racket/base\n(define (make) (lambda (x) (add1 x)))\n(void ((make) 1))\n")
     '((before "(void ((make) 1))") (before "((make) 1)") (before "(make)")
       (after "(make)" "#<procedure>")
       (before "(add1 x)")
       (after "((make) 1)" "2")
       (after "(void ((make) 1))" "#<void>"))))
  (test-case "a definition has the same stops in a plain file as in a module"
    (define body
      (string-append
       "(define (v x) x)\n"
       "(define (f a)\n  (+ (v a) 1))\n"
       "(define g (lambda (y) y))\n"
       "(define c (case-lambda [(p) p] [(p q) q]))\n"
       "(define-values (m n) (values 1 2))\n"
       "(define o (let ([w 1]) (v w)))\n"
       "(f 1)\n"
       "(define z (f 2))\n"
       "(v z)\n"
       "(begin (v 1) (define k (v 2)) (v k))\n"
       "m\n"
       "(g 1)\n"))
    (define as-module (stops (string-append "#lang racket/base\n" body)))
    ;; The language line holds no code, so the two read the same text from line two.
    (define as-file (stops body #:language 'racket/base))
    (check-equal? as-file as-module)
    (check-false (findf (lambda (row) (string-prefix? (cadr row) "(define (")) as-file)))
  ;; Each row here is text the program holds and the value it has. Macros generate the
  ;; rest, and give some of it the location of an expression they were handed.
  (define f "#lang racket/base\n(define (f x) (* x 2))\n")
  (define f-stops '((before "(* x 2)")))
  ;; A for loop at module level is its loop followed by a separate (void), so it has no value.
  (define (program . lines) (string-append f (string-join lines "\n") "\n"))
  (test-case "the expression producing a for loop's sequence stops once, with its own value"
    (check-equal?
     (stops (program "(for ([i (list 1 2)])" "  (f i))"))
     `((before "(for ([i (list 1 2)])\n  (f i))")
       (before "(list 1 2)") (after "(list 1 2)" "(1 2)")
       (before "(f i)") ,@f-stops (after "(f i)" "2")
       (before "(f i)") ,@f-stops (after "(f i)" "4")
       (after "(for ([i (list 1 2)])\n  (f i))"))))
  (test-case "for/list stops at its name with the list it returns, not at the list it builds"
    (check-equal?
     (stops (program "(for/list ([i (list 1 2)])" "  (f i))"))
     `((before "for/list")
       (before "(list 1 2)") (after "(list 1 2)" "(1 2)")
       (before "(f i)") ,@f-stops (after "(f i)" "2")
       (before "(f i)") ,@f-stops (after "(f i)" "4")
       (after "for/list" "(2 4)"))))
  (test-case "for/fold stops for its accumulator's expressions and its result"
    (check-equal?
     (stops (program "(for/fold ([acc 0]) ([i (in-range 2)])" "  (+ acc (f i)))"))
     `((before "(for/fold ([acc 0]) ([i (in-range 2)])\n  (+ acc (f i)))")
       (before "(+ acc (f i))") (before "(f i)") ,@f-stops (after "(f i)" "0") (after "(+ acc (f i))" "0")
       (before "(+ acc (f i))") (before "(f i)") ,@f-stops (after "(f i)" "2") (after "(+ acc (f i))" "2")
       (after "(for/fold ([acc 0]) ([i (in-range 2)])\n  (+ acc (f i)))" "2"))))
  (for ([clause '("(in-list '(1))" "(in-range 1)" "(in-vector (vector 1))" "'(1)" "1")])
    (test-case (format "a for clause over ~a shows nothing that it does not evaluate" clause)
      (define rows
        (stops (program (format "(for ([i ~a]) (f i))" clause))))
      (define loop (format "(for ([i ~a]) (f i))" clause))
      (check-equal? (filter (lambda (row) (not (member (cadr row) (list loop "(f i)" "(* x 2)")))) rows)
                    (if (equal? clause "(in-vector (vector 1))")
                        '((before "(vector 1)") (after "(vector 1)" "#(1)"))
                        '()))
      (check-equal? (length (filter (lambda (row) (equal? (cadr row) loop)) rows)) 2)))
  (test-case "a for clause over a variable stops once for the sequence built from it"
    (define rows (stops (program "(define lst '(1 2))" "(for ([i lst]) (f i))")))
    (check-equal? (map car (filter (lambda (row) (equal? (cadr row) "lst")) rows))
                  '(before after)))
  (test-case "a for loop's body keeps every stop of its own expressions"
    (check-equal?
     (stops (program "(for ([i (list 1)] #:when (f i))" "  (+ i 1)" "  (f i))"))
     `((before "(for ([i (list 1)] #:when (f i))\n  (+ i 1)\n  (f i))")
       (before "(list 1)") (after "(list 1)" "(1)")
       (before "(f i)") ,@f-stops (after "(f i)" "2")
       (before "(+ i 1)") (after "(+ i 1)" "2")
       (before "(f i)") ,@f-stops (after "(f i)" "2")
       (after "(for ([i (list 1)] #:when (f i))\n  (+ i 1)\n  (f i))"))))
  (test-case "match stops for its expressions, not for the clauses it generates"
    (check-equal?
     (stops (program "(require racket/match)" "(match (list 1 2) [(list a b) (f a)] [_ (f 0)])"))
     `((before "(match (list 1 2) [(list a b) (f a)] [_ (f 0)])")
       (before "(list 1 2)") (after "(list 1 2)" "(1 2)")
       (before "(f a)") ,@f-stops
       (after "(match (list 1 2) [(list a b) (f a)] [_ (f 0)])" "2"))))
  (test-case "cond stops for each clause it reaches"
    (check-equal?
     (stops (program "(cond [#f (f 1)] [(f 2) (f 3)] [else (f 4)])"))
     `((before "(cond [#f (f 1)] [(f 2) (f 3)] [else (f 4)])")
       (before "(f 2)") ,@f-stops (after "(f 2)" "4")
       (before "(f 3)") ,@f-stops (after "(f 3)" "6")
       (after "(cond [#f (f 1)] [(f 2) (f 3)] [else (f 4)])" "6"))))
  (test-case "a keyword function's call stops for its arguments and body, not at its definition"
    (define definition "(define (kw a #:k [k (f 3)]) (+ a k))")
    (check-equal?
     (stops (program definition "(kw 1)" "(kw 1 #:k (f 1))"))
     `((before ,definition) (after ,definition "#<procedure>")
       (before "(kw 1)") (before "(f 3)") ,@f-stops (after "(f 3)" "6") (before "(+ a k)")
       (after "(kw 1)" "7")
       (before "(kw 1 #:k (f 1))") (before "(f 1)") ,@f-stops (after "(f 1)" "2") (before "(+ a k)")
       (after "(kw 1 #:k (f 1))" "3"))))
  (test-case "a function whose name is a macro stops at its name and at the whole call"
    (check-equal?
     (stops (program "(sort (list 2 1) <)"))
     '((before "sort") (before "(list 2 1)") (after "(list 2 1)" "(2 1)")
       (before "(sort (list 2 1) <)") (after "(sort (list 2 1) <)" "(1 2)")
       (after "sort" "(1 2)")))
    (check-equal?
     (map car (stops (program "(void (thread void))")))
     '(before before before after after after)))
  (test-case "a macro argument used twice stops at each use"
    (check-equal?
     (stops (program "(define-syntax-rule (twice e) (list e e))" "(twice (f 1))"))
     `((before "(twice (f 1))")
       (before "(f 1)") ,@f-stops (after "(f 1)" "2")
       (before "(f 1)") ,@f-stops (after "(f 1)" "2")
       (after "(twice (f 1))" "(2 2)"))))
  (test-case "the code in a macro's template keeps its stops"
    (check-equal?
     (stops (program "(define-syntax-rule (tmpl e) (let ([t e]) (+ t (f t))))" "(tmpl (f 8))"))
     `((before "(tmpl (f 8))")
       (before "(f 8)") ,@f-stops (after "(f 8)" "16")
       (before "(+ t (f t))") (before "(f t)") ,@f-stops (after "(f t)" "32") (after "(+ t (f t))" "48")
       (after "(tmpl (f 8))" "48"))))
  (test-case "a macro's generated call located at its argument leaves the range to the argument"
    (check-equal?
     (stops (program "(require (for-syntax racket/base))"
                     "(define-syntax (located stx)"
                     "  (syntax-case stx () [(_ e) (quasisyntax/loc #'e (f e))]))"
                     "(void (located (f 7)))"))
     `((before "(void (located (f 7)))")
       (before "(f 7)") ,@f-stops (after "(f 7)" "14")
       ,@f-stops
       (after "(void (located (f 7)))" "#<void>"))))
  (test-case "hiding generated stops changes nothing a program does"
    (define text
      (program
       "(require racket/match)"
       "(define lst '(1 2))"
       "(define (kw a #:k [k (f 3)]) (+ a k))"
       "(writeln (for/list ([i lst]) (f i)))"
       "(writeln (for/fold ([acc 0]) ([i (in-range 3)]) (+ acc i)))"
       "(for ([i (in-list lst)] [j '(3 4)]) (writeln (+ i j)))"
       "(writeln (match lst [(list a b) (+ a b)]))"
       "(writeln (cond [(assv 1 '((1 . 2))) => cdr] [else 0]))"
       "(writeln (list (kw 1) (kw 1 #:k 2)))"
       "(writeln (sort (list 2 1) <))"))
    (check-equal? (printed text #:instrument? #t) (printed text #:instrument? #f))
    (check-equal? (printed text #:instrument? #t)
                  "(2 4)\n3\n4\n6\n3\n2\n(7 3)\n(1 2)\n"))
  (define g "(define (g x) (+ x 1))\n")
  (test-case "Out in an argument at module level finishes the application, without entering it"
    (check-equal?
     (presses (string-append f g "(define (three a b c) (list a b c))\n(three 1 2 (g 3))\n(void)\n")
              '(before "(g 3)") '(stepOut stepOut))
     '((after "(three 1 2 (g 3))" "(1 2 4)") (before "(void)"))))
  (test-case "Out from an argument's return finishes the application around it"
    (check-equal?
     (presses (string-append f g "(list (f (g 3)) 9)\n")
              '(after "(g 3)" "4") '(stepOut stepOut))
     '((after "(f (g 3))" "8") (after "(list (f (g 3)) 9)" "(8 9)"))))
  (test-case "Out in nested applications leaves one level for each press"
    (check-equal?
     (presses (string-append f g "(list (f (g (f 1))))\n")
              '(before "(f 1)") '(stepOut stepOut stepOut))
     '((after "(g (f 1))" "3") (after "(f (g (f 1)))" "6") (after "(list (f (g (f 1))))" "(6)"))))
  (test-case "Out at a whole module-level application finishes it, without entering it"
    (check-equal?
     (presses (string-append f g "(g 3)\n(f 4)\n")
              '(before "(g 3)") '(stepOut stepOut stepOut))
     '((after "(g 3)" "4") (before "(f 4)") (after "(f 4)" "8"))))
  (test-case "Out in a macro use at module level finishes the use"
    (check-equal?
     (presses (string-append f "(define-syntax-rule (twice e) (list e e))\n(twice (f 1))\n")
              '(before "(f 1)") '(stepOut))
     '((after "(twice (f 1))" "(2 2)"))))
  (test-case "Out in a macro's template at module level finishes the use"
    (check-equal?
     (presses (string-append f "(define-syntax-rule (tmpl e) (+ e (f e)))\n(tmpl 1)\n")
              '(before "(f e)") '(stepOut))
     '((after "(tmpl 1)" "3"))))
  (test-case "Out in a begin inside an application finishes the begin, then the application"
    (check-equal?
     (presses (string-append f "(list (begin (f 1) (f 2)) 3)\n")
              '(before "(f 1)") '(stepOut stepOut))
     '((after "(begin (f 1) (f 2))" "4") (after "(list (begin (f 1) (f 2)) 3)" "(4 3)"))))
  (test-case "Out in a begin at module level finishes that form, which is a form of the module"
    (check-equal?
     (presses (string-append f "(begin (f 1) (f 2))\n")
              '(before "(f 1)") '(stepOut stepOut stepOut))
     '((after "(f 1)" "2") (before "(f 2)") (after "(f 2)" "4"))))
  (test-case "Out in a for loop's body at module level finishes the loop, past its hidden code"
    (check-equal?
     (presses (string-append f "(for ([i (list 1 2)]) (f i))\n")
              '(before "(f i)") '(stepOut))
     '((after "(for ([i (list 1 2)]) (f i))"))))
  (test-case "generated code that nothing stops at is not what a press waits for"
    (check-equal?
     (presses (string-append f "(for ([i (list 1 2)]) (f i))\n")
              '(before "(f i)") '(stepOut) #:reasons? #t)
     '("Expression returned"))
    (check-equal?
     (presses (string-append f "(for ([i (list 1 2)]) (f i))\n")
              '(before "(* x 2)") '(stepOut stepOut) #:reasons? #t)
     '("Expression returned" "Expression returned")))
  (test-case "Out in a thread's own function finishes the evaluation around it"
    (check-equal?
     (presses (string-append f "(thread-wait (thread (lambda () (list (list (f 1) 2) 3))))\n")
              '(before "(f 1)") '(stepOut))
     '((after "(list (f 1) 2)" "(2 2)"))))
  (test-case "Out in a function leaves the function, whatever is nested at the stop"
    (define text (string-append f g "(define (h x) (+ (f (g x)) 1))\n(list (h 1) 2)\n"))
    (for ([at '((before "(+ (f (g x)) 1)") (before "(f (g x))") (before "(g x)") (after "(g x)" "2"))])
      (check-equal? (presses text at '(stepOut)) '((after "(h 1)" "5")) (format "from ~s" at)))
    (check-equal? (presses text '(after "(h 1)" "5") '(stepOut))
                  '((after "(list (h 1) 2)" "(5 2)"))))
  (test-case "Over at module level is as it was"
    (define text (string-append f g "(list (g 3) 2)\n(void)\n"))
    (check-equal? (presses text '(before "(g 3)") '(next next next next))
                  '((after "(g 3)" "4") (after "(list (g 3) 2)" "(4 2)") (before "(void)")
                    (after "(void)" "#<void>"))))
  (test-case "a press from a stop inside generated code lands on a stop outside it"
    (check-equal?
     (presses (program "(for ([i (list 1)]) (f i))" "(void)")
              '(before "(f i)") '(next next next))
     '((after "(f i)" "2")
       (after "(for ([i (list 1)]) (f i))")
       (before "(void)")))))
