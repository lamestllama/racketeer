#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/list racket/path racket/port racket/string
         (submod "adapter-debugger.rkt" support)
         "../racketdap/worker/load.rkt"
         "../racketdap/worker/debug-cache.rkt"
         (only-in "../racketdap/instrumentation/instrument.rkt" site-expression))

(define available?
  (and (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
       (with-handlers ([exn:fail? (lambda (_) #f)])
         (collection-file-path "main.rkt" "rhombus") #t)))
(define text
  (string-append
   "#lang rhombus\nexport: run\nclass Point(x, y)\n"
   "fun inner(a):\n  def b = a + 1\n  def p = Point(a, b)\n"
   "  def items = [a, b, 3]\n  def x = 99\n  def length = 88\n"
   "  def unused = 17\n  def mutable count = 4; def mutable spare = 23\n  b * 2 + count - count\n"
   "fun run():\n  def a = 100\n  inner(20) + a\n"))
(define (session body #:text [source text] #:setup [setup void] #:cache [cached? #f]
                 #:result [expected 142] #:interactive? [interactive? #f])
  (collect-garbage)
  (define sites '())
  (with-session source
    (lambda (path ask event seen)
      (body path ask event seen)
      (when cached?
        (check-not-equal? sites '())
        ;; Replayed sites contain locations rather than expanded expressions.
        ;; This distinguishes a cache hit from a silent source fallback.
        (check-true (andmap (lambda (site) (not (site-expression site))) sites))))
    #:context #f #:cache-directory (and cached? 'project) #:timeout 120
    #:interactive? interactive? #:on-sites (lambda (added) (set! sites (append sites added)))
    #:setup
    (lambda (directory)
      (setup directory)
      (when cached?
        (define cache (build-path directory "cache"))
        (define outcome #f)
        ;; Runtime configuration belongs to the launched thread.
        (thread-wait
         (thread (lambda ()
                   (set! outcome
                         (with-handlers ([exn:fail? values])
                           (run-module (build-path directory "program.rkt") #:entry 'run
                                       #:source-roots (list directory) #:cache-directory cache))))))
        (if (procedure? expected) (check-pred expected outcome) (check-equal? outcome expected))
        (check-true (file-exists? (entry-path (cache-root cache) (string->path "compiled/debug")
                                             (build-path directory "program.rkt") #".zo")))))))
(define (pause path ask event [line 12] [column #f])
  (define stopped
    (start path ask event (list (if column (hasheq 'line line 'column column) (hasheq 'line line)))))
  (values stopped (car (frames ask stopped))))
(define (rows ask frame)
  (hash-ref (ask "variables" (hasheq 'variablesReference (locals ask frame))) 'variables))
(define (row table name)
  (or (findf (lambda (r) (equal? (hash-ref r 'name) name)) table)
      (error 'test "Missing local ~a in ~s" name table)))
(define (move ask event stopped command)
  (ask command (hasheq 'threadId (hash-ref stopped 'threadId)))
  (event "stopped"))
(define (position frame)
  (list (hash-ref frame 'line) (hash-ref frame 'column)))

(define model
  "#lang rhombus\nexport: inner\nfun inner(a):\n  def items = [a, a + 1, 3]\n  items.length() + a\n")
(define client
  "#lang rhombus\nimport: \"other.rhm\"\nexport: run\nfun run():\n  def a = 20\n  other.inner(a) + a\n")
(define (imports cached?)
  (session
   (lambda (path ask event seen)
     (define other (build-path (path-only path) "other.rhm"))
     (define-values (stopped caller) (pause path ask event 6))
     (define entered
       (let loop ([stopped stopped] [fuel 30])
         (define f (car (frames ask stopped)))
         (cond [(equal? (hash-ref (hash-ref f 'source) 'path) (path->string other)) stopped]
               [(zero? fuel) (error 'test "Did not enter the imported module")]
               [else (loop (move ask event stopped "stepIn") (sub1 fuel))])))
     (define fs (frames ask entered))
     (check-equal? (evaluate ask "a + 1" (car fs)) "21")
     (check-equal? (evaluate ask "a + 2" (cadr fs)) "22")
     (check-equal? (position (car fs)) '(4 3))
     (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string other))
                                  'breakpoints (list (hasheq 'line 5 'column 3))))
     (ask "continue" (hasheq 'threadId (hash-ref entered 'threadId)))
     (define at-break (event "stopped"))
     (define f (car (frames ask at-break)))
     (check-equal? (position f) '(5 3))
     (check-equal? (evaluate ask "items.length() + a" f) "23")
     (check-equal? (hash-ref (row (rows ask f) "items") 'value) "[20, 21, 3]")
     (check-equal? (evaluate ask "items" f "hover") "[20, 21, 3]"))
   #:text client #:cache cached? #:result 43
   #:setup (lambda (directory) (display-to-file model (build-path directory "other.rhm")))))

(module+ test
  (unless available?
    (displayln "Rhombus debugger tests skipped: install Rhombus and set RACKETDAP_TEST_RHOMBUS=1."))
  (for ([cached? '(#f #t)])
   (define (label name) (format "~a: ~a" (if cached? "compiled" "source") name))
   (test-case (label "native watches and console use selected locals and dotted members")
    (when available?
      (session #:cache cached?
       (lambda (path ask event seen)
         (define-values (stopped frame) (pause path ask event))
         (for* ([context '("watch" "repl")]
                [expression '("a + 1" "p.x" "p.y" "items.length()")])
           (define expected (cond [(equal? expression "a + 1") "21"]
                                  [(equal? expression "p.x") "20"]
                                  [(equal? expression "p.y") "21"] [else "3"]))
           (check-equal? (evaluate ask expression frame context) expected))
         (check-equal? (evaluate ask "a + 2" (cadr (frames ask stopped))) "102")))))
  (test-case (label "Variables, watches and hovers print native lists and class instances")
    (when available?
      (session #:cache cached?
       (lambda (path ask event seen)
         (define-values (_ frame) (pause path ask event))
         (for ([name '("items" "p")] [expected '("[20, 21, 3]" "Point(20, 21)")])
           (check-equal? (hash-ref (row (rows ask frame) name) 'value) expected)
           (check-equal? (evaluate ask name frame) expected)
           (check-equal? (evaluate ask name frame "hover") expected))))))
  (test-case (label "locals keep written names, unused storage and live mutable storage")
    (when available?
      (session #:cache cached?
       (lambda (path ask event seen)
         (define-values (_ frame) (pause path ask event))
         (define table (rows ask frame))
         (check-equal? (sort (map (lambda (r) (hash-ref r 'name)) table) string<?)
                       '("a" "b" "count" "items" "length" "p" "spare" "unused" "x"))
         (check-equal? (hash-ref (row table "unused") 'value) "17")
         (check-equal? (hash-ref (row table "spare") 'value) "23")
         (check-equal? (hash-ref (ask "setVariable" (hasheq 'variablesReference (locals ask frame)
                                                          'name "count" 'value "count + 3")) 'value) "7")
         (check-equal? (evaluate ask "count" frame) "7")))))
  (test-case (label "line and column breakpoints and In, Over and Out retain exact source positions")
    (when available?
      (session #:cache cached?
       (lambda (path ask event seen)
         (define-values (stopped frame) (pause path ask event 15))
         (check-equal? (position frame) '(15 3))
         (check-true (hash-ref frame 'racketdapNativeExpressions #f))
         (define entered
           (let loop ([stopped stopped] [fuel 20])
             (define f (car (frames ask stopped)))
             (cond [(equal? (position f) '(5 11)) stopped]
                   [(zero? fuel) (error 'test "Did not enter inner")]
                   [else (loop (move ask event stopped "stepIn") (sub1 fuel))])))
         (define f (car (frames ask entered)))
         (check-equal? (position f) '(5 11))
         (for ([command '("next" "stepOut")])
           (set! entered (move ask event entered command))
           (define f (car (frames ask entered)))
           (check-equal? (hash-ref (hash-ref f 'source) 'path) (path->string path))
           (check-equal? (position f) (if (equal? command "next") '(5 15) '(15 11))))))))
  (test-case (label "runtime errors retain native messages and source locations")
    (when available?
      (session #:cache cached?
       (lambda (path ask event seen)
         (ask "setExceptionBreakpoints" (hasheq 'filters '("uncaught")))
         (ask "configurationDone")
         (define stopped (event "stopped"))
         (check-equal? (hash-ref stopped 'reason) "exception")
         (define frame (car (frames ask stopped)))
         (check-equal? (hash-ref (hash-ref frame 'source) 'path) (path->string path))
         (check-equal? (position frame) '(4 3))
         (check-true (hash-ref frame 'racketdapNativeExpressions #f))
         (check-regexp-match #rx"value does not satisfy annotation\n  annotation: Number\n  value: \"bad\"" (hash-ref (ask "exceptionInfo" (hasheq 'threadId (hash-ref stopped 'threadId))) 'description)))
       #:text "#lang rhombus\nexport: run\nfun run():\n  1 + \"bad\"\n" #:result exn:fail?)))
  (test-case (label "imported frames support breakpoints, stepping and native expressions")
    (when available? (imports cached?)))
  (test-case (label "the meta variant uses the same native expression bridge")
    (when available?
      (session #:cache cached?
       (lambda (path ask event seen)
         (define-values (_ frame) (pause path ask event))
         (check-equal? (evaluate ask "p.x + items.length()" frame) "23"))
       #:text (string-replace text "#lang rhombus\n" "#lang rhombus/and_meta\n")))))
  (test-case "console without a selected frame retains the launch language"
    (when available?
      (for ([cached? '(#f #t)])
        (session #:cache cached? #:interactive? #t
          (lambda (path ask event seen)
            (ask "configurationDone")
            (event "racketdap/ready")
            (check-equal? (hash-ref (ask "evaluate" (hasheq 'context "repl" 'expression "Point(2, 3)")) 'result)
                          "Point(2, 3)"))))))
  (test-case "a Racket caller and an imported Rhombus frame retain separate grammars and printers"
    (when available?
      (for ([cached? '(#f #t)])
        (session #:cache cached? #:result 123
          #:text "#lang racket/base\n(require (only-in \"other.rhm\" inner))\n(provide run)\n(define (run)\n  (define a 100)\n  (+ (inner 20) a))\n"
          #:setup (lambda (directory) (display-to-file model (build-path directory "other.rhm")))
          (lambda (path ask event seen)
            (define other (build-path (path-only path) "other.rhm"))
            (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string other))
                                         'breakpoints (list (hasheq 'line 5))))
            (ask "configurationDone")
            (define stopped (event "stopped"))
            (define fs (frames ask stopped))
            (check-equal? (evaluate ask "items.length() + a" (car fs)) "23")
            (check-equal? (evaluate ask "(+ a 2)" (cadr fs)) "102")
            (check-equal? (evaluate ask "(list a 2)" (cadr fs)) "(100 2)")
            (check-false (hash-ref (cadr fs) 'racketdapNativeExpressions #f))))))))

(module+ test
  (test-case "annotated mutable locals cannot be corrupted by debugger assignment"
    (when available?
      (for ([cached? '(#f #t)])
       (session #:cache cached?
       #:text "#lang rhombus\nexport: run\nfun run():\n  def mutable count :: Int = 4\n  count + 1\n"
       #:result 5
       (lambda (path ask event seen)
         (define-values (stopped frame) (pause path ask event 5))
         (define entry (row (rows ask frame) "count"))
         (check-equal? (hash-ref entry 'value) "4")
         (ask "setVariable" (hasheq 'variablesReference (locals ask frame) 'name "count" 'value "\"bad\"") #f)
         (ask "racketdap/setBinding" (hasheq 'frameId (hash-ref frame 'id) 'name "count" 'expression "\"bad\"") #f)
         (check-not-false (member "readOnly" (hash-ref (hash-ref entry 'presentationHint (hasheq)) 'attributes '())))
         (check-equal? (evaluate ask "count" frame) "4")
         (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string path)) 'breakpoints '()))
         (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
         (check-equal? (hash-ref (event "workerExit") 'exitCode) 0))))))

  (test-case "unused annotated mutable locals retain their written names"
    (when available?
      (for ([cached? '(#f #t)])
        (session #:cache cached? #:result 10
         #:text "#lang rhombus\nexport: run\nfun run():\n  def mutable count :: Int = 4\n  9 + 1\n"
         (lambda (path ask event seen)
           (define-values (_ frame) (pause path ask event 5))
           (define entry (row (rows ask frame) "count"))
           (check-equal? (hash-ref entry 'value) "4")
           (check-equal? (evaluate ask "count" frame) "4")))))))
