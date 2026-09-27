#lang racket/base
;; Copyright Neil Van Dyke.  See file "info.rkt".

(require (for-syntax racket/base
                     syntax/parse)
         racket/port
         mcfly)

(doc (section "Introduction")

     (para "Overeasy is a software test engine for the Racket programming
language.  It designed for all of:")

     (itemize
      (item "interspersing unit tests in-line with implementation code, using
the Racket "
            (tt "test")
            " submodule, or in separate files;")
      (item "unit testing of individual modules, either from within DrRacket,
or from the command line or Emacs;")
      (item "rapid interactive testing of expressions in the REPL; and")
      (item "running hierarchical sets of individual module unit tests at
once."))

     (para "An individual test case, or "
           (italic "test")
           ", is specified by the programmer with the "
           (racket test)
           " syntax, and evaluation of that syntax causes the test to be
run.  Properties that are checked by tests are:")

     (itemize
      (item "values of expressions (single value, or multiple value);")
      (item "exceptions raised; and")
      (item "output to "
            (racket current-output-port)
            " and "
            (racket current-error-port)
            "."))

     (para "Tests can also be marked as expected to fail.  Tests can be
organized into hierarchically-nested sections.")

     (para "Some checking is also done to help protect test suites from
crashing due to errors in the setup of the test itself, such as errors in
evaluating an expression that provides an expected value for a test.")

     ;;      (para "For the properties checked by tests, in most cases, the programmer
     ;; can specify both an expected value and a predicate, or "
     ;;            (italic "checker")
     ;;            ", for comparing expected and actual values.  Note that, if the
     ;; predicate is not an equality predicate of some kind, then the ``expected''
     ;; would be a misnomer, and ``argument to the predicate'' would be more accurate.
     ;; The actual "
     ;;            (racket test)
     ;;            " syntax does not include the word ``expected.''  Specification of
     ;; expected exceptions is different from values and output ports, in that only the
     ;; predicate is specified, with no separate expected or argument value.  All these
     ;; have have reasonable defaults whenever possible.")
     )

(doc (subsection "Simple Examples")

     (para "Here's a simple test, with the first argument the expression under
test, and the other argument the expected value.")

     (racketinput (test (+ 1 2 3) 6))

     (para "How the results of tests are reported varies depending on how the
tests are run.  For purposes of these examples, we will pretend we are running
tests in the simplest way.  In this way, tests that fail produce one-line
error-messages to "
           (racket current-error-port)
           ", which in DrRacket show up as red italic text by default.  Tests
that pass in this way do not produce any message at all.  So, our first example
above, does not produce any message.")

     (para "Now, for a test that fails:")

     (racketinput
      (test (+ 1 2 3) 7))
     (nested #:style 'inset
             (racketerror "TEST FAILED [???] Value 6 did not match expected
value 7 by equal?."))

     (para "That's a quick way to do a test in a REPL or when you're otherwise
in a hurry, but if you're reviewing a report of failed tests for one or more
modules, you'd probably like a more descriptive way of seeing which tests
failed.  That's what the "
           (italic "test ID")
           " is for, and to specify it, we can use a three-argument form of "
           (racket test)
           ":")

     (racketinput
      (test 'simple-addition
            (+ 1 2 3)
            7))
     (nested #:style 'inset
             (racketerror "TEST FAILED [simple-addition] Value 6 did not match
expected value 7 by equal?."))

     (para "Quick note on syntax.  The above is actually shorthand syntax.  In
the non-shorthand syntax, every argument to "
           (racket test)
           " has a keyword, so the above is actually shorthand for:")

     (racketblock
      (test #:id   'simple-addition
            #:code (+ 1 2 3)
            #:val  7))

     (para "This three-argument form is used so often that the keywords can be
left off.")

     (para "In the rest of these examples, we'll use the shorthand syntax,
because it's quicker to type."))

(doc (subsection "Exceptions")

     (para "So far, we've been checking the values of code, and we haven't yet
dealt in exceptions.  Exceptions, such as due to programming errors in the code
being tested, can also be reported:")

     (racketinput
      (test (+ 1 (error "help!") 3)
            3))
     (nested #:style 'inset
             (racketerror "TEST FAILED [???] Got exception #(struct:exn:fail
\"help!\"), but expected value 3."))

     (para "And if an exception is the correct behavior, instead of specifying
an expected value, we can use "
           (racket #:exn)
           " to specify predicate just like for "
           (racket with-handlers)
           ":")

     (racketinput
      (test (+ 1 (error "help!") 3)
            #:exn exn:fail?))

     (para "That test passed.  But if our code under test doesn't throw an
exception matched by our "
           (racket #:exn)
           " predicate, that's a test failure:")

     (racketinput
      (test (+ 1 2 3)
            #:exn exn:fail?))
     (nested #:style 'inset
             (racketerror "TEST FAILED [???] Got value 6, but expected
exception matched by predicate exn:fail?."))

     (para "Of course, when you want finer discrimination of exceptions than,
say,"
           (racket exn:fail?)
           " or "
           (racket exn:fail:filesystem?)
           ", you can write a custom predicate that uses "
           (racket exn-message)
           " or other information, and supply it to "
           (racket test)
           "'s "
           (racket #:exn)
           "."))

(doc (subsection "Multiple Values")

     (para "Multiple values are supported:")

     (racketinput
      (test (begin 1 2 3)
            (values 1 2 3)))
     (nested #:style 'inset
             (racketerror "TEST FAILED [???] Value 3 did not match expected
values (1 2 3) by equal?.")))

(doc (subsection "Custom Value Checks")

     (para "You might have noticed that a lot of the test failure messages say
``by equal?''.  That's referring to the default predicate, so, the following
test passes:")

     (racketinput
      (test (string-append "a" "b" "c")
            "abc"))

     (para "But we let's say we wanted the expected and actual values to not
necessarily be "
           (racket equal?)
           " but to be numbers within 3 decimal places of being equal:")

     (racketinput
      (define (close-enough-val-check a-values b-values)
        (and (null? (cdr a-values))
             (null? (cdr b-values))
             (let ((a (car a-values))
                   (b (car b-values)))
               (and (number? a)
                    (number? b)
                    (equal? (round (* 1000 a))
                            (round (* 1000 b))))))))
     (racketinput
      (test 3.142
            3.14159
            #:val-check close-enough-val-check))

     (para "Note that, since expressions can produce multiple values, the "
           (racket #:val-check)
           " predicate receives lists of values instead of single values.")

     (para "As mentioned earlier, the checker does not have to be an equality
predicate, and it can use whatever reasoning you like in rendering its verdict
on whether the actual value should be considered OK."))

(doc (subsection "Output Ports")

     (para "In addition to values and exceptions, "
           (racket test)
           " also intercepts and permits checking of "
           (racket current-output-port)
           " and "
           (racket current-error-port)
           ".  By default, it assumes no output to either of those ports, which
is especially good for catching programming errors like neglecting to specify
an output port to a procedure for which the port is optional:")

     (racketinput
      (test (let ((o (open-output-string)))
              (display 'a o) (display 'b) (display 'c o)
              (get-output-string o))
            "abc"))
     (nested #:style 'inset
             (racketerror "TEST FAILED [???] Value \"ac\" did not match
expected value \"abc\" by equal?. Out bytes #\"b\" did not match expected #\"\"
by equal?."))

     (para "Likewise, messages to "
           (racket current-error-port)
           ", such as warnings and errors from legacy code, are also caught by
default:")

     (racketinput
      (test (begin (fprintf (current-error-port)
                            "%W%SYS$FROBINATOR_OVERHEAT\n")
                   0)
            42))
     (nested #:style 'inset
             (racketerror "TEST FAILED [???] Value 0 did not match expected
value 42 by equal?. Err bytes #\"%W%SYS$FROBINATOR_OVERHEAT\\n\" did not match
expected #\"\" by equal?."))

     (para "Now we know why we've started getting 0, which information might
have gone unnoticed had our test engine not captured error port output: the
frobinator is failing, after all these years of valiant service.")

     (para "With the "
           (racket #:out-check)
           " and "
           (racket #:err-check)
           " keyword arguments to "
           (racket test)
           ", you can specify predicates other than "
           (racket equal?)
           ".  Also, by setting one of these predicates to "
           (racket #f)
           ", you can cause the output to be consumed but not stored and
checked.  This is useful if, for example, the code produces large amounts of
debugging message output.")

     (racketinput
      (test (begin (display "blah")
                   (display "blah")
                   (display "blah")
                   (* 44 2))
            88
            #:out-check #f)))

;; TODO: This old text commented-out because we don't want to talk about the
;; test-context stuff until it's finalized, and also it changed in version 3:0.
;;
;; (doc (subsection "Report Backends")
;;
;;      (para "The architecture of Overeasy is designed to permit different
;; backends for reporting test results to be plugged in.  Currently implemented
;; backends are for:")
;;
;;      (itemize
;;       (item "quick one-line error messages for tests that fail; and")
;;       (item "more verbose textual report of all test cases run."))
;;
;;      (para "In the future, Web front-end and GUI backends might also be
;; implemented.  The backend is dynamic context, so no changes to the files
;; containing test code is required to run the tests with a different backend."))

;; (doc (subsection "Test Contexts and Test Sections")
;;
;;      (para "The architectural notion that permits the backends to be plugged in is
;; called the "
;;            (italic "test context")
;;            ".  Test context are nested dynamically, with each introduced
;; context having the previous context as a parent.  The same test context notion
;; that permits backends for reporting to be introduced also permits "
;;            (italic "test sections")
;;            " for grouping tests to be nested dynamically.
;; The dynamic nesting of test sections facilitates reporting of test results when
;; running unit tests for multiple modules together.  Plugging in a backend for
;; reporting simply means establishing it as the first or topmost test context.")
;;
;;      (para "By default, if a test is run without a test context, then the one-line
;; error messages are used.  If a test section context is introduced without a
;; parent context, such as would usually be the case for an individual
;; module's unit tests, then the text report backend is plugged in by default.")
;;
;;      (para "One place you'll want to use a section is for the unit tests for a
;; particular module.  This groups the tests together if the module's unit tests
;; are run in the context of a larger test suite, and it also provides a default
;; report context when the unit tests are run by themselves.  You might want to
;; package the module's unit tests in a procedure, for ease of use as part of a
;; test suite.  (Unless you have rigged up something different, like by having "
;;            (racket require)
;;            " or "
;;            (racket dynamic-require)
;;            " simply run the tests, without needing to then invoke a provided
;; procedure.  For illustration in this document, we'll use procedures.)  For
;; example, if you have a "
;;            (racket fruits)
;;            " module, in file "
;;            (racket fruits.rkt)
;;            ", then you might want to put its unit tests in a procedure in
;; file "
;;            (racket test-fruits.rkt)
;;            ", like so:")
;;
;;      (racketblock
;;       (define (test-fruits)
;;         (test-section
;;             #:id 'fruits
;;             (test #:id 'apple  #:code (+ 1 2 3) #:val 6)
;;             (test #:id 'banana #:code (+ 4 5 6) #:val 6)
;;             (test #:id 'cherry #:code (+ 7 8 9) #:val 24))))
;;
;;      (para "Notice that we put all the tests for module in "
;;            (racket fruits)
;;            " in "
;;            (racket test-section)
;;            " here, and gave it an ID.  The ID didn't have to be "
;;            (racket fruits)
;;            " like the module name; we could have called it "
;;            (racket fruity-unit-tests)
;;            ", "
;;            (racket fructose)
;;            ", or any other symbol.")
;;
;;      (para "Then let's say we have a "
;;            (racket cars)
;;            " module, so in file "
;;            (racket some-cars-tests.rkt)
;;            ", we put this procedure:")
;;
;;      (racketblock
;;       (define (test-drive-cars)
;;         (test-section
;;             #:id 'cars
;;             (test 'delorean (+ 77 11)                      88)
;;             (test 'ferrari  (or (and #f 'i-cant-drive) 55) 55)
;;             (test 'magnum   (+ 300 8)                      308))))
;;
;;      (para "Those unit test suites are used independently.  Later, those
;; modules are integrated into a larger system, COLOSSUS.  For running all the
;; unit tests for the modules of COLOSSUS, we add another module, which "
;;            (racket require)
;;            "s the other test modules, and invokes the each unit test procedure
;; within its own test section:")
;;
;;      (racketblock
;;       (test-section
;;           #:id 'colossus-components
;;           (test-fruits)
;;           (test-drive-cars)))
;;
;;      (para "Unless this is done within another test context, the result will be
;; to execute the tests in the default text report context.  This produces a
;; report like:")
;;
;;
;;      (verbatim
;;       ";; START-TESTS\n"
;;       ";;\n"
;;       ";; START-TEST-SECTION colossus-components\n"
;;       ";;\n"
;;       ";; START-TEST-SECTION fruits\n"
;;       ";;\n"
;;       ";; TEST apple\n"
;;       ";; (+ 1 2 3)\n"
;;       ";; OK\n"
;;       ";;\n"
;;       ";; TEST banana\n"
;;       ";; (+ 4 5 6)\n"
;;       ";; *FAIL* Value 15 did not match expected value 6 by equal?.\n"
;;       ";;\n"
;;       ";; TEST cherry\n"
;;       ";; (+ 7 8 9)\n"
;;       ";; OK\n"
;;       ";;\n"
;;       ";; END-TEST-SECTION fruits\n"
;;       ";;\n"
;;       ";; START-TEST-SECTION cars\n"
;;       ";;\n"
;;       ";; TEST delorean\n"
;;       ";; (+ 77 11)\n"
;;       ";; OK\n"
;;       ";;\n"
;;       ";; TEST ferrari\n"
;;       ";; (or (and #f (quote i-cant-drive)) 55)\n"
;;       ";; OK\n"
;;       ";;\n"
;;       ";; TEST magnum\n"
;;       ";; (+ 300 8)\n"
;;       ";; OK\n"
;;       ";;\n"
;;       ";; END-TEST-SECTION cars\n"
;;       ";;\n"
;;       ";; END-TEST-SECTION colossus-components\n"
;;       ";;\n"
;;       ";; END-TESTS\n"
;;       ";;     OK: 5  FAIL: 1  BROKEN: 0\n"
;;       ";;     SOME TESTS *FAILED*!\n")
;;
;;      (para "The test sections here are nested only two deep, but test sections may
;; be nested to arbitrary depth.  You can use test sections at each nested
;; subsystem, to organize the unit tests for a module into groups, to group
;; variations of generated test cases (e.g., if evaluating the same "
;;            (racket test)
;;            " form multiple times, with different values or state each time),
;; or other purposes.")

(doc (subsection "Test Sections")

     (para "Sequences of tests can be nested in a "
           (deftech "test section")
           ", and the test section given an ID.  Test sections can be nested
within each other.")

     (para "For example:")

     (racketinput
      (test-section 'fundamentals

        (test-section 'writing

          (test 'abcs
                (string-append "a" "b" "c")
                "abc"))

        (test-section 'arithmetic

          (test 'one-two-three
                (+ 1 2 3)
                6)

          (test 'for-fife-sax
                (+ 4 5 6)
                666))))
     (nested #:style 'inset
             (racketerror "TEST FAILED [fundamentals arithmetic for-fife-sax]
Value 15 did not match expected value 666 by equal?."))

     (para "Note that the reference to test ID "
           (tt "for-fife-sax")
           " in the error message is qualified with the path through the test
sections: section "
           (tt "fundamentals")
           " and its child section, "
           (tt "arithmetic")
           ".  In large test suites, this can help to locate the test.")

     (para "Note that a given instance "
           (racket test-section)
           " syntax may appear inside procedures and loops.  This can be very
useful for testing code with different arguments or context, when the behavior
is the same or similar for many of the combinations.  When doing this, note
that a "
           (racket test-section)
           " ID need not be a constant symbol like "
           (racket 'for-fife-sax)
           ", but can also be a Racket expression, so it could be used to
indicate one or more of the arguments.  For example, suppose that there is a
case for three-argument procedure "
           (racket foo)
           " in which, if the third argument is "
           (racket 0)
           ", the answer should be "
           (racket 42)
           ":")

     (racketinput
      (test-section 'foo-constant-with-z-arg-zero

        (for ((bar? (in-list '(#true #false))))

          (test-section bar?

            (for ((power (in-range 1 9)))

              (test #:id   power
                    #:code (foo bar? power 0)
                    #:val  42))))))

     (para "When this test code is run, Racket logger entries starting with the
following should be made (and can be viewed in the DrRacket Log window, and
elsewhere):")

     (nested #:style 'inset
             (verbatim
              "overeasy: Start Test Section [foo-constant-with-z-arg-zero]\n"
              "overeasy: Start Test Section [foo-constant-with-z-arg-zero #t]\n"
              "overeasy: Test Passed [foo-constant-with-z-arg-zero #t 1]\n"
              "overeasy: Test Passed [foo-constant-with-z-arg-zero #t 2]\n"
              "overeasy: Test Passed [foo-constant-with-z-arg-zero #t 3]")))

(doc (subsection "Expected Failures")

     (para "Sometimes, you'll have a test case that is known to fail, but that
you are deferring fixing, and that you don't want distracting you from other
test cases at this time.  Rather than commenting-out the test case code, which
might result in being lost or forgotten, you can instead mark the test case
with "
           (racket #:fail)
           ".  For example:")

     (racketinput
      (test 'basic-arithmetic
            (plussy 1 2 3)
            6
            #:fail "bug til move to new library"))

     (para "In this example, the string "
           (racket "bug til move to new library")
           " gives the rationale for expecting the test to fail but deferring
corrective action on it.  When this "
           (racket test)
           " syntax is evaluated, instead of an exception being raised, instead a "
           (tt "warning")
           " level message is sent to the Racket logger:")

     (nested #:style 'inset
             (tt "overeasy: Test Failed Expectedly [basic-arithmetic] Value 5.9
did not match expected value 6 by equal?. (#:fail \"bug til move to new
library\")"))

     (para "Note that if "
           (racket (plussy 1 2 3))
           " "
           (italic "does")
           " produce the correct "
           (racket 6)
           " value, but the "
           (racket #:fail)
           " argument is still present, then the test will actually be
considered to fail:")

     (nested #:style 'inset
             (racketerror "TEST FAILED [basic-arithmetic] Passed
unexpectedly. (#:fail \"bug til move to new library\")")))

(doc (subsection "Intermixed Racket Code")

     (para "There are some more tricks you can do with "
           (racket test)
           ".  Most notably,
you'll sometimes want to set up state in the system -- Racket parameters, test
input files, whatever.  Because the "
           (racket test)
           " syntax can appear anywhere normal Racket code can, you can set up
this state using normal Racket code.  No special forms for setup and tear-down
are required, nor are they provided."))

;; TODO: Document programmatic generation of test cases and test sections, such
;; as for handling combinations.

;; TODO: Document how to test macro expansion.  Such as what we do in
;; "test-html-template.rkt", with "define-namespace-anchor" and such.

;; TODO: Discuss related projects, including RackUnit, eli-tester, and DrDr.

(doc (section "Interface"))

(define-logger overeasy)

(struct exn:fail:test exn:fail
        ()
        #:transparent)

(struct exn:fail:test:broken exn:fail:test
        (id)
        #:transparent)

(struct exn:fail:test:failure exn:fail:test
        (result)
        #:transparent)

;; @section Test Specs

;; TODO: Maybe rename "spec" to "decl" or "defn" or something, to avoid
;; confusion with software test specification documents.

(define (%overasy:test-spec-custom-write spec out mode)
  (fprintf out "#<test-spec:~S>" (test-spec-id spec)))

(struct test-spec
  ;; TODO: Maybe code-sexp should be code-stx?
  ;;
  ;; TODO: add value-sexp and exception-sexp?
  ;;
  ;; TODO: Include stx of the "test" form?
  (stx
   id
   code-sexp
   code-thunk
   expected-exn
   expected-vals
   vals-check
   expected-out
   expected-err
   out-check
   err-check
   notes
   fail)
  #:property prop:custom-write %overasy:test-spec-custom-write)

(define-syntax %make-test-spec/kw
  (syntax-rules ()
    ((_ #:stx           stx
        #:id            id
        #:code-sexp     code-sexp
        #:code-thunk    code-thunk
        #:expected-exn  expected-exn
        #:expected-vals expected-vals
        #:vals-check    vals-check
        #:expected-out  expected-out
        #:expected-err  expected-err
        #:out-check     out-check
        #:err-check     err-check
        #:notes         notes
        #:fail         fail)
     (test-spec stx
                id
                code-sexp
                code-thunk
                expected-exn
                expected-vals
                vals-check
                expected-out
                expected-err
                out-check
                err-check
                notes
                fail))))

;; @section Test Results

(struct test-result
  (spec
   actual-exn
   actual-vals
   actual-out
   actual-err
   exn-ok?
   vals-ok?
   out-ok?
   err-ok?
   ok?))

(define (%make-test-result/kw
         #:spec        spec
         #:actual-exn  actual-exn
         #:actual-vals actual-vals
         #:actual-out  actual-out
         #:actual-err  actual-err
         #:exn-ok?     exn-ok?
         #:vals-ok?    vals-ok?
         #:out-ok?     out-ok?
         #:err-ok?     err-ok?
         #:ok?         ok?)
  (test-result spec
               actual-exn
               actual-vals
               actual-out
               actual-err
               exn-ok?
               vals-ok?
               out-ok?
               err-ok?
               ok?))

;;(define %syntax->srcloc
;;
;;  (list/c any/c
;;              (or/c exact-positive-integer? #f)
;;              (or/c exact-nonnegative-integer? #f)
;;              (or/c exact-positive-integer? #f)
;;              (or/c exact-nonnegative-integer? #f))

(define (%pretty-proc-name-string proc)
  (let ((name (cond ((object-name proc) => symbol->string)
                    (else
                     (let ((name (call-with-output-string
                                  (lambda (out)
                                    (write proc out)))))
                       (cond ((regexp-match #rx"^#<procedure:(.*)>$" name)
                              => cadr)
                             (else name)))))))
    (cond ((regexp-match-positions #rx"\\.(?:rkt|ss|scm):[0-9]+:[0-9]$" name)
           => (lambda (m)
                (string-append "#<procedure:" name ">")))
          (else name))))

(define (%pretty-exn-string exn)
  (let ((str (format "~S" exn)))
    (cond ((regexp-match "^(#\\(struct:.*) #<continuation-mark-set>\\)$"
                         str)
           => (lambda (m)
                (string-append (cadr m) ")")))
          (else str))))

(define (%pretty-vals vals #:capitalized? (capitalized? #false))
  (if (null? (cdr vals))
      (format (if capitalized?
                  "Value ~S"
                  "value ~S")
              (car vals))
      (format (if capitalized?
                  "Values ~S"
                  "values ~S")
              vals)))

(define (%get-test-result-failure-summary result)
  (let* ((spec (test-result-spec result))
         (summary
          (call-with-output-string
           (lambda (out)
             (let* (
                    (expected-exn (test-spec-expected-exn spec))
                    (actual-exn   (test-result-actual-exn result)))
               (if expected-exn
                   (or (test-result-exn-ok? result)
                       (if actual-exn
                           (fprintf out
                                    " Exception ~A was not matched by expected exception predicate ~A."
                                    (%pretty-exn-string actual-exn)
                                    (%pretty-proc-name-string expected-exn))
                           (fprintf out
                                    " Got ~A, but expected exception matched by predicate ~A."
                                    (%pretty-vals (test-result-actual-vals result))
                                    (%pretty-proc-name-string expected-exn))))
                   (or (test-result-vals-ok? result)
                       (let ((expected-vals (test-spec-expected-vals spec)))
                         (if actual-exn
                             (fprintf out
                                      " Got exception ~A, but expected ~A."
                                      (%pretty-exn-string actual-exn)
                                      (%pretty-vals expected-vals))
                             (fprintf out
                                      " ~A did not match expected ~A by ~A."
                                      (%pretty-vals (test-result-actual-vals result)
                                                    #:capitalized? #t)
                                      (%pretty-vals expected-vals)
                                      (%pretty-proc-name-string
                                       (test-spec-vals-check spec)))))))
               (let-syntax
                   ((do-err/out
                     (syntax-rules ()
                       ((_ STR SPEC-CHECK RESULT-OK? RESULT-ACTUAL SPEC-EXPECTED)
                        (cond ((SPEC-CHECK spec)
                               => (lambda (check)
                                    (or (RESULT-OK? result)
                                        (fprintf out
                                                 " ~A bytes ~S did not match expected ~S by ~A."
                                                 STR
                                                 (RESULT-ACTUAL result)
                                                 (SPEC-EXPECTED spec)
                                                 (%pretty-proc-name-string check)))))
                              ;; TODO: !!! Need an "else" clause here.
                              )))))
                 (do-err/out "Out"
                             test-spec-out-check
                             test-result-out-ok?
                             test-result-actual-out
                             test-spec-expected-out)
                 (do-err/out "Err"
                             test-spec-err-check
                             test-result-err-ok?
                             test-result-actual-err
                             test-spec-expected-err)))))))
    (if (equal? "" summary)
        (cond ((test-spec-fail spec)
               => (lambda (fail-val)
                    (format " Passed unexpectedly. (#:fail ~S)"
                            fail-val)))
              ;; TODO: Handle this internal error differently.
              (else " Unknown why we thought this failed! (internal error in Overeasy)"))
        summary)))

;; @section Test Contexts

(struct test-context
  (get-raise-exn?
   ;;   handle-start
   ;;   handle-end
   handle-section-start
   handle-section-end
   handle-test-start
   handle-test-end
   handle-test-broken))

(define (make-test-context/kw #:get-raise-exn?       get-raise-exn?
                              ;;                              #:handle-start         handle-start
                              ;;                              #:handle-end           handle-end
                              #:handle-section-start handle-section-start
                              #:handle-section-end   handle-section-end
                              #:handle-test-start    handle-test-start
                              #:handle-test-end      handle-test-end
                              #:handle-test-broken   handle-test-broken)
  (test-context get-raise-exn?
                ;;                handle-start
                ;;                handle-end
                handle-section-start
                handle-section-end
                handle-test-start
                handle-test-end
                handle-test-broken))

(define %current-test-context (make-parameter #f))

(define (%get-valid-test-context)
  (or (%current-test-context)
      (let ((tc (make-logger-test-context)))
        (%current-test-context tc)
        ;; ((test-context-handle-start tc))
        tc)))

(define (%call-with-valid-test-context proc)
  (proc (%get-valid-test-context)))

(define (%call-with-test-section id proc)
  (%call-with-valid-test-context (lambda (tc)
                                   ((test-context-handle-section-start tc) id)
                                   (proc)
                                   ((test-context-handle-section-end tc) id))))

;; @subsection Logger Test Context

(define (%format-test-id/id section-string id)
  (cond ((not id) (if section-string
                      (string-append section-string " ???")
                      "???"))
        (else (if section-string
                  (format "~A ~S" section-string id)
                  (format "~S"                   id)))))

(define (%format-test-id/result section-string result)
  (%format-test-id/id section-string (test-spec-id (test-result-spec result))))

(define (make-logger-test-context)
  ;; TODO: maybe make the pass/fail/broken count info be a struct on a section
  ;; stack.  then we can report it on a per-section basis, and also get rid of
  ;; this handle-start and handle-end stuff?  this is moot when
  ;; "get-raise-exn?" is always true.
  (let* ((pass-count           0)
         (fail-count           0)
         (broken-count         0)
         (section-prefix-stack '())
         (get-section-string   (lambda ()
                                 (if (null? section-prefix-stack)
                                     #f
                                     (car section-prefix-stack))))
         (get-raise-exn?       (lambda ()
                                 ;; TODO: We might want to make this dependent
                                 ;; on a parameter, even just for testing
                                 ;; overeasy itself.
                                 #true)))
    (make-test-context/kw
     #:get-raise-exn?
     get-raise-exn?
     ;;     #:handle-start
     ;;     (lambda ()
     ;;       (log-overeasy-info "Start Tests"))
     ;;     #:handle-end
     ;;     (lambda ()
     ;;       (log-overeasy-info "End Tests (~S  Passed: ~S  Failed: ~S  Broken: ~S)"
     ;;                          (if (zero? broken-count)
     ;;                              (if (zero? fail-count)
     ;;                                  (if (zero? pass-count)
     ;;                                      "NO TESTS"
     ;;                                      "All Tests Passed")
     ;;                                  (if (zero? pass-count)
     ;;                                      "ALL TESTS FAILED"
     ;;                                      "SOME TESTS FAILED"))
     ;;                              "BROKEN TESTS")
     ;;                          pass-count
     ;;                          fail-count
     ;;                          broken-count))
     #:handle-section-start
     (lambda (section-id)
       (let ((full-string (if (null? section-prefix-stack)
                              (format "~S"   section-id)
                              (format "~A ~S" (car section-prefix-stack) section-id))))
         (log-overeasy-info (string-append "Start Test Section [" full-string "]"))
         (set! section-prefix-stack (cons full-string
                                          section-prefix-stack))))
     #:handle-section-end
     (lambda (section-id)
       (if (null? section-prefix-stack)
           (error '|<make-logger-text-context handle-section-end>|
                  "internal error: no section to end")
           (let ((str (car section-prefix-stack)))
             (set! section-prefix-stack (cdr section-prefix-stack))
             (log-overeasy-info (string-append "End Test Section ["
                                               str
                                               "]")))))
     #:handle-test-start
     (lambda (spec)
       #f)
     #:handle-test-end
     (lambda (result)
       (if (test-result-ok? result)
           (let ((spec (test-result-spec result)))
             (cond ((test-spec-fail spec)
                    => (lambda (fail-val)
                         (let ((summary (%get-test-result-failure-summary result)))
                           ;; TODO: !!! count expected failures in different variable.
                           ;; (set! expected-fail-count (+ 1 expected-fail-count))
                           (log-overeasy-warning (string-append "Test Failed Expectedly ["
                                                                (%format-test-id/result (get-section-string)
                                                                                        result)
                                                                "]"
                                                                summary
                                                                " (#:fail "
                                                                (format "~S" fail-val)
                                                                ")")))))
                   (else
                    (set! pass-count (+ 1 pass-count))
                    (log-overeasy-info (string-append "Test Passed ["
                                                      (%format-test-id/result (get-section-string)
                                                                              result)
                                                      "]")))))
           (let ((summary (%get-test-result-failure-summary result)))
             (set! fail-count (+ 1 fail-count))
             (let ((msg (string-append "TEST FAILED ["
                                       (%format-test-id/result (get-section-string)
                                                               result)
                                       "]"
                                       summary)))

               ;; TODO: Output full filename and location info on line, for
               ;; Emacs compile mode.
               (log-overeasy-error msg)
               (and (get-raise-exn?)
                    ;; TODO: Make continuation-marks have source location for
                    ;; the test.  maybe for the expression being evaluated.
                    (raise (exn:fail:test:failure msg
                                                  (current-continuation-marks)
                                                  result)))))))
     #:handle-test-broken
     (lambda (exn)
       (set! broken-count (+ 1 broken-count))
       (let ((msg (string-append "TEST BROKEN ["
                                 (%format-test-id/id (get-section-string)
                                                     (exn:fail:test:broken-id exn))
                                 "] "
                                 (exn-message exn))))

         (log-overeasy-error msg)
         (and (get-raise-exn?)
              ;; TODO: We are conflating the purpose of "exn:fail:test:broken"
              ;; to be both the internal catching exception, and the external
              ;; one, so we actually catch and then re-raise.
              ;;
              ;; TODO: Can we modify the continuation marks to add a test
              ;; expression syntax one to the top?
              (raise (exn:fail:test:broken msg
                                           (exn-continuation-marks exn)
                                           (exn:fail:test:broken-id exn)
                                           ))))))))

(doc (defform/subs (test-section maybe-id-kw id body ...+)
         ((maybe-id-kw code:blank
                       #:id))

       "See above."))
(provide test-section)
(define-syntax (test-section stx)
  (syntax-parse stx
    ((_ ID:expr BODYn ...)
     #'(test-section #:id ID BODYn ...))
    ((_ #:id ID:expr BODYn ...)
     #'(%call-with-test-section ID
                                (lambda ()
                                  BODYn ...)))))

;; @section Tests

(define-syntax %test-setup-values
  (syntax-rules ()
    ;; TODO: Can put the WHAT-STRING in at syntax expansion time.
    ((_ ID WHAT-STRING EXPR)
     (with-handlers
         ((exn:fail?
           (lambda (orig-exn)
             (raise (exn:fail:test:broken
                     (format "Exception from ~A during test setup: ~S"
                             WHAT-STRING
                             (exn-message orig-exn))
                     (exn-continuation-marks orig-exn)
                     ID)))))
       EXPR))))

;; TODO: !!! make %test-setup-value/proc and use it for "expected-exn" and for
;; some of the checkers.  And "/proc-or-false" for out/err checkers.

(define-syntax %test-setup-value/non-false
  (syntax-rules ()
    ((_ ID WHAT-STRING EXPR)
     ;; TODO: Can put the WHAT-STRING in at syntax expansion time.
     ;;
     ;; TODO: Error-check that it's not multiple-value.
     (or (%test-setup-values ID WHAT-STRING EXPR)
         (raise (exn:fail:test:broken
                 (format "Invalid ~A during test setup: #f"
                         WHAT-STRING)
                 (current-continuation-marks)
                 ID))))))

;; TODO: When writing "code-sexp", normalize the writing procedure.

;; (define (%finish-executing-test-spec-after-eval #:spec spec
;;         #:actual-exn actual-exn
;;         #:actual-value     actual-value)
;;
;;  )

(define (%overeasy-false-proc x)
  #f)

(define (%open-output-null)
  ;; Note: This definition is taken from the Racket 5.1.2 documentation for
  ;; "make-output-port".
  (make-output-port
   'null
   always-evt
   (lambda (s start end non-block? breakable?) (- end start))
   void
   (lambda (special non-block? breakable?) #t)
   (lambda (s start end) (wrap-evt always-evt (lambda (x) (- end start))))
   (lambda (special) always-evt)))

;; (struct %not-applicable ())
;; (define %not-applicable (%not-applicable))

(define (%execute-test-spec spec)
  (%call-with-valid-test-context
   (lambda (context)
     ((test-context-handle-test-start context) spec)
     (let* ((out-check (test-spec-out-check spec))
            (err-check (test-spec-err-check spec))
            (out-op    (if out-check (open-output-bytes) (%open-output-null)))
            (err-op    (if err-check (open-output-bytes) (%open-output-null))))
       (parameterize ((current-output-port out-op)
                      (current-error-port  err-op))
         (let*-values
             (((expected-exn)
               (test-spec-expected-exn spec))
              ((actual-exn actual-vals exn-ok? vals-ok?)
               (with-handlers (((or expected-exn %overeasy-false-proc)
                                (lambda (actual-exn)
                                  (values actual-exn
                                          'not-applicable
                                          #t
                                          'not-applicable)))
                               (exn:fail?
                                (lambda (actual-exn)
                                  (values actual-exn
                                          'not-applicable
                                          #f ; TODO: not-applicable?
                                          #f))))
                 (let ((actual-vals (call-with-values
                                        (test-spec-code-thunk spec)
                                      list)))
                   (if expected-exn
                       (values #f
                               actual-vals
                               #f
                               'not-applicable)
                       (let ((expected-vals  (test-spec-expected-vals spec)))
                         (values #f
                                 actual-vals
                                 'not-applicable
                                 ((test-spec-vals-check spec)
                                  actual-vals
                                  expected-vals)))))))
              ;; TODO: Make a macro for output ports.
              ((actual-out out-ok?)
               (if out-check
                   (let ((actual-bytes (get-output-bytes out-op)))
                     (values actual-bytes
                             (out-check actual-bytes
                                        (test-spec-expected-out spec))))
                   (values 'not-applicable
                           'not-applicable)))
              ((actual-err err-ok?)
               (if err-check
                   (let ((actual-bytes (get-output-bytes err-op)))
                     (values actual-bytes
                             (err-check actual-bytes
                                        (test-spec-expected-err spec))))
                   (values 'not-applicable
                           'not-applicable)))
              ((ok-ignoring-spec-fail-arg?)
               (and (if expected-exn
                        exn-ok?
                        vals-ok?)
                    (or (not out-check) out-ok?)
                    (or (not err-check) err-ok?)
                    #t))
              ((ok?)
               (if (test-spec-fail spec)
                   (not ok-ignoring-spec-fail-arg?)
                   ok-ignoring-spec-fail-arg?))
              ((result)
               (%make-test-result/kw #:spec        spec
                                     #:actual-exn  actual-exn
                                     #:actual-vals actual-vals
                                     #:actual-out  actual-out
                                     #:actual-err  actual-err
                                     #:exn-ok?     exn-ok?
                                     #:vals-ok?    vals-ok?
                                     #:out-ok?     out-ok?
                                     #:err-ok?     err-ok?
                                     #:ok?         ok?)))
           ((test-context-handle-test-end context) result)
           (void)))))))

;; TODO: Expose any of these make-exn- procedures?
;;
;;(define (make-exn-with-message-predicate pred msg)
;;  (let ((<make-exn-with-message-predicate>
;;         (lambda (e)
;;           (and (pred e)
;;                (equal? (exn-message e) msg)))))
;;    <make-exn-with-message-predicate>))
;;
;;(define (make-exn-with-message-rx-predicate pred rx)
;;  (let ((<make-exn-with-message-rx-predicate>
;;         (lambda (e)
;;           (and (pred e)
;;                (regexp-match? rx (exn-message e))))))
;;    <make-exn-with-message-rx-predicate>))
;;
;;(define (make-exn-with-message-starts-with-predicate pred msg)
;;  (let ((rx (string-append "^" (regexp-quote msg))))
;;    (let ((<make-exn-with-message-starts-with-predicate>
;;           (lambda (e)
;;             (and (pred e)
;;                  (regexp-match? rx (exn-message e))))))
;;      <make-exn-with-message-starts-with-predicate>)))

(begin-for-syntax
 (define-syntax-class exn-sc
   #:description "#:exn value"
   (pattern STR:str
            #:attr expanded #'(lambda (e)
                                (and (exn:fail? e)
                                     (equal? STR (exn-message e)))))
   (pattern (STR:str PRED:expr)
            #:attr expanded #'(let ((pred PRED))
                                (lambda (e)
                                  (and (pred e)
                                       (equal? STR (exn-message e))))))
   (pattern (EXPR:expr PRED:expr)
            #:attr expanded (let ((expr-e (syntax-e #'EXPR)))
                              (if (regexp? expr-e)
                                  #'(let ((pred PRED))
                                      (lambda (e)
                                        (and (exn:fail? e)
                                             (regexp-match? EXPR (exn-message e)))))
                                  #'(EXPR PRED))))
   (pattern EXPR:expr
            #:attr expanded (let ((expr-e (syntax-e #'EXPR)))
                              (if (regexp? expr-e)
                                  #'(lambda (e)
                                      (and (exn:fail? e)
                                           (regexp-match? EXPR (exn-message e))))
                                  #'EXPR)))))

;; TODO: !!! Write this documentation.
(doc (defform (test !!!)
       "See above."))
(provide test)
(define-syntax (test stx)
  (syntax-parse
      stx
    ((_ ID:expr CODE:expr VAL:expr RESTn ...)
     (syntax/loc stx
       (test #:id ID #:code CODE #:val VAL RESTn ...)))
    ((_ CODE:expr VAL:expr RESTn ...)
     (syntax/loc stx
       (test #:code CODE #:val VAL RESTn ...)))
    ((_ CODE:expr RESTn ...)
     (syntax/loc stx
       (test #:code CODE RESTn ...)))
    ((_ (~or (~optional (~seq #:id ID:expr)
                        #:name "#:id option")
             (~once     (~seq #:code CODE:expr)
                        #:name "#:code option")
             (~once     (~or (~seq #:val VAL:expr)
                             #:name "#:val option"
                             (~seq #:exn EXN:exn-sc)
                             #:name "#:exn option"))
             (~optional (~seq #:val-check VAL-CHECK:expr)
                        #:name "#:val-check option")
             (~optional (~seq #:out OUT:expr)
                        #:name "#:out option")
             (~optional (~seq #:out-check OUT-CHECK:expr)
                        #:name "#:out-check option")
             (~optional (~seq #:err ERR:expr)
                        #:name "#:err option")
             (~optional (~seq #:err-check ERR-CHECK:expr)
                        #:name "#:err-check option")
             ;; TODO: Make "#:note" be the canonical name for "#:notes", since
             ;; it's shorter (and I accidentally said "#:note" when using it)?
             (~optional (~seq #:notes NOTES:expr))
             (~optional (~seq #:fail FAILS:expr)
                        #:name "#:fail option")
             )
        ...)
     ;; TODO: Don't let specify "#:val-check" if "#:exn".  Is it
     ;; possible to do this with the "~or", "~seq", etc. alone?
     (with-syntax
         ((ID        (or (attribute ID)           #'#f))
          (VAL       (or (attribute VAL)          #''not-applicable))
          (EXN       (or (attribute EXN.expanded) #'#f))
          (VAL-CHECK (or (attribute VAL-CHECK)    #'equal?))
          (OUT       (or (attribute OUT)          #'#""))
          (ERR       (or (attribute ERR)          #'#""))
          (OUT-CHECK (or (attribute OUT-CHECK)    #'equal?))
          (ERR-CHECK (or (attribute ERR-CHECK)    #'equal?))
          (NOTES     (or (attribute NOTES)        #'#f))
          (FAILS     (or (attribute FAILS)        #'#f))
          ;;
          (EXN-TEST-SETUP-VAL
           (cond ((attribute VAL) #'%test-setup-values)
                 ((attribute EXN) #'%test-setup-value/non-false)
                 (else (error 'test
                              "internal error: expect-which setting")))))
       (quasisyntax/loc stx
         (with-handlers ((exn:fail:test:broken? %handle-test-setup-exn))
           (let ((id (%test-setup-values  #f "#:id" ID)))
             (%execute-test-spec
              (%make-test-spec/kw
               #:stx           srcloc ; TODO: !!! stx !!!
               #:id            id
               #:code-sexp     (%test-setup-values id "#:code"      (quote CODE))
               #:code-thunk    (%test-setup-values id "#:code"      (lambda () CODE))
               #:expected-exn  (EXN-TEST-SETUP-VAL id "#:exn"       EXN)
               #:expected-vals (%test-setup-values id "#:val"       (call-with-values
                                                                        (lambda ()
                                                                          VAL)
                                                                      list))
               #:vals-check    (%test-setup-values id "#:val-check" VAL-CHECK)
               #:expected-out  (%test-setup-values id "#:out"       OUT)
               #:expected-err  (%test-setup-values id "#:err"       ERR)
               #:out-check     (%test-setup-values id "#:out-check" OUT-CHECK)
               #:err-check     (%test-setup-values id "#:err-check" ERR-CHECK)
               #:notes         (%test-setup-values id "#:notes"     NOTES)
               #:fail          (%test-setup-values id "#:fail"     FAILS))))))))))

(define (%handle-test-setup-exn exn)
  (%call-with-valid-test-context
   (lambda (context)
     ((test-context-handle-test-broken context) exn)
     (void))))

(doc (section "Deprecated"))

(doc (defform/subs (with-test-usection maybe-id-kw id body ...+)
         ((maybe-id-kw code:blank
                       #:id))
       "Deprecated.  Alias for "
       (racket test-section)
       "."))
(provide with-test-section)
(define-syntax with-test-section
  (syntax-rules ()
    ((_ X ...)
     (test-section X ...))))

(doc (section "Known Issues")
     (itemlist

      (item "Sanity-check how keyword argument shortcuts are done, and which
combinations make sense.")

      (item "Document the support for "
            (racketfont "#rx")
            " with "
            (racket #:exn)
            ".")

      (item "Document the support for "
            (racket #:notes)
            ", but rename it to "
            (racket #:note)
            " and support the old name (which some package might have already
used, even though undocumented) as an alias.")

      (item "Document how to use with submodules and DrRacket.  Just examples of "
            (racket test)
            " submodule, and tests run when hitting the Run button with
particular DrRacket option set.")

      (item "In documentation, fill out the "
            (racket defproc)
            " for "
            (racket test)
            " form.")

      (item "For "
            (racket #:out)
            " and "
            (racket #:err)
            ", force expected value to bytes (convert using UTF-8 if string),
and also ensure that port encoding is UTF-8 (or whatever encoding makes
sense).")

      (item "Add conveniences for defining "
            (racket #:val-check)
            " predicates.  For example, a convenient way to specify "
            (racket eq?)
            " of a single value (not multiple values).")

      (item "Try to mess with the continuation marks for test failues due to
unexpected exceptions, so that user can navigate first to the "
            (racket test)
            " form, and then to the origin of the exception.")

      (item "Provide convenience for running tests from multiple files, in "
            (racket test)
            " submodules, and possibly entire files/modules.")

      (item "This package does not yet expose an interface so that alternative
means of reporting (e.g., GUI) can be added easily.  This is intentional, until
we can be comfortable that the existing internal interface won't be changing
soon.")))

(doc history

     (#:planet 4:3 #:date "2023-07-05"
               (itemlist
                (item "Changed package metadata "
                      (code "scribblings")
                      " to move this to category "
                      (racket "Testing")
                      ", per request.")))
     
     (#:planet 4:2 #:date "2016-02-26"
               (itemlist
                (item "Commented out some tests that have to be run manually.")))
     
     (#:planet 4:1 #:date "2016-02-25"
               (itemlist
                (item "Fixed deps.")))
     
     (#:planet 4:0 #:date "2016-02-21"
               (itemlist
                (item "Moving from PLaneT to new package system.")))
     
     (#:planet 3:2 #:date "2015-12-19"
               (itemlist
                (item "Removed documentation that wrongly claimed "
                      (racket #:id)
                      " as the only keyword argument worked, since there might
have been a regression 3+ years ago, but only just now reported. (Thanks to
David Storrs for reporting.)")
                (item "Documentation tweaks.")))

     (#:planet 3:1 #:date "2012-12-26"
               (itemlist
                (item "Documentation tweaks.")))

     (#:planet 3:0 #:date "2012-12-25"
               (itemlist
                (item "Now requires Racket 5.3.1.")
                (item "Converted to use the Racket logger facility, and format
of the messages changed.  This is reason for the change to the major version
number of the PLaneT package.")
                (item (racket #:fail)
                      " feature added.")
                (item "Messages regarding tests now qualify the test ID with
the IDs of the parent test sections.")
                (item "Documentation changes.")
                (item "Internal simplifications to test contexts.  There are no
longer parent and child test contexts, but a single test context.  Test
contexts no longer have handlers for the start and end of tests.  When there is
not yet any test context, previously a "
                      (racket test-section)
                      " would create one kind of transient context, and "
                      (racket test)
                      " would create a different kind of transient context;
now, both forms create the same kind of context, and it is not transient.")))

     (#:planet 2:1 #:date "2012-11-15"
               (itemlist
                (item "Fixed bug regarding ``fprintf: format string requires 1
arguments, given 2; arguments were: #<output-port> \"TEST BROKEN!~A\\\n\"
...")))

     (#:planet 2:0 #:date "2012-06-11"

               (itemlist
                (item "Converted to McFly.")
                (item "The default test context now raises an exception with
syntax location info for failed test cases, rather than only writing a message
to "
                      (racket current-error-port)
                      ".")
                (item "The "
                      (racket test)
                      " syntax now preserves syntax location info better.")

                (item "Added shorthand syntax "
                      (racket (test #,(italic "ID")
                                    #,(italic "CODE")
                                    #,(italic "VAL")
                                    #,(italic "RESTn") ...))
                      ".")
                (item "The new name "
                      (racket test-section)
                      " is now preferred to the old name "
                      (racket with-test-section)
                      ".")
                (item "In "
                      (racket test-section)
                      " syntax, the "
                      (racket #:id)
                      " keyword itself is now optional.")
                (item (racket test-section)
                      " may have no "
                      (italic "body")
                      " forms.")))

     (#:version "0.1" #:planet 1:0 #:date "2011-08-26"

                "Initial release."))
