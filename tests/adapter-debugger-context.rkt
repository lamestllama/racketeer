#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/list racket/path racket/port
         test-engine/test-engine
         (submod "adapter-debugger.rkt" support)
         "../racketdap/worker/expressions.rkt"
         "../racketdap/worker/inspect.rkt"
         "../racketdap/instrumentation/instrument.rkt")
(define-namespace-anchor anchor)

(module+ test
  (test-case "captured interactions retain native watches and caller child contexts"
    (define captured (current-parameterization))
    (define selected
      (hash-set native-context 'call-with-interaction-context
                (lambda (thunk) (call-with-parameterization captured thunk))))
    (define caller-context
      (hash-set selected 'values (hasheq 'print (lambda (value out) (fprintf out "caller<~s>" value)))))
    (with-session program
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (define fs (frames ask stopped))
        (define watch (evaluate ask "!6" (car fs)))
        (define result
          (ask "evaluate" (hasheq 'frameId (hash-ref (cadr fs) 'id)
                                  'context "watch" 'expression "!(vector @x (vector 9))")))
        (define children
          (hash-ref (ask "variables" (hasheq 'variablesReference (hash-ref result 'variablesReference))) 'variables))
        (define grandchildren
          (hash-ref (ask "variables" (hasheq 'variablesReference (hash-ref (cadr children) 'variablesReference))) 'variables))
        (check-equal? (list watch (hash-ref result 'result)
                            (map (lambda (row) (hash-ref row 'value)) children)
                            (map (lambda (row) (hash-ref row 'value)) grandchildren))
                      '("tiny<6>" "caller<#(20 #(9))>" ("caller<20>" "caller<#(9)>") ("caller<9>"))))
      #:context (lambda (where _namespace)
                  (if (and where (site-line where) (>= (site-line where) 6)) caller-context selected))))

  (test-case "a configured teaching reader preserves a two-check suite through successful and failed watches and console input"
    (define private (make-base-namespace))
    (define private-reader #f)
    (define private-eval #f)
    (sync (thread
           (lambda ()
             (parameterize ([current-namespace private])
               ((dynamic-require 'htdp/bsl/runtime 'configure) '())
               (set! private-reader (current-read-interaction))
               (set! private-eval (current-eval))))))
    (define object #f)
    (define get-object #f)
    (define get-tests #f)
    (define get-successes #f)
    (define copy-object #f)
    (define same-object? #f)
    (define (select where namespace)
      (when namespace
        (parameterize ([current-namespace namespace])
          (set! get-object (dynamic-require 'test-engine/test-engine 'current-test-object))
          (set! get-tests (dynamic-require 'test-engine/test-engine 'test-object-tests))
          (set! get-successes (dynamic-require 'test-engine/test-engine 'test-object-successful-tests))
          (set! copy-object (dynamic-require 'test-engine/test-engine 'test-object-copy))
          (set! same-object? (dynamic-require 'test-engine/test-engine 'test-object=?))))
      (hasheq 'expressions (hasheq 'read-interaction (lambda (src in) ((current-read-interaction) src in)))
              'call-with-interaction-context
              (lambda (thunk)
                (parameterize ([current-read-interaction private-reader] [current-eval private-eval]) (thunk)))))
    (with-session
      "#lang htdp/bsl\n(define (inc x) (+ x 1))\n(check-expect (inc 1) 2)\n(check-expect (inc 2) 3)\n"
      (lambda (path ask event seen)
        (define stopped (start path ask event (list (hasheq 'line 2))))
        (define frame (car (frames ask stopped)))
        (set! object (copy-object (get-object)))
        (check-equal? (length (get-tests object)) 2)
        (for* ([context '("watch" "repl")] [expression '("(+ x 5)" "(/ x 0)" "(")])
          (define body (ask "evaluate" (hasheq 'frameId (hash-ref frame 'id) 'context context 'expression expression)
                            (equal? expression "(+ x 5)")))
          (when (equal? expression "(+ x 5)") (check-equal? (hash-ref body 'result) "6"))
          (check-equal? (length (get-tests (get-object))) 2)
          (check-true (same-object? object (get-object))))
        (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string path)) 'breakpoints '()))
        (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
        (check-equal? (hash-ref (event "workerExit") 'exitCode) 0)
        (check-equal? (length (get-tests (get-object))) 2)
        (check-equal? (length (get-successes (get-object))) 2))
      #:context select #:entry #f #:test? #t #:rich? #t))

  (test-case "isolated input retains two teaching checks, their results and incidental state on every route"
    (initialize-test-object!)
    (add-test! (lambda () #t))
    (add-test! (lambda () #t))
    (run-tests!)
    (define original (test-object-copy (current-test-object)))
    (define incidental (box 'programme))
    (define inside? (make-parameter #f))
    (define calls 0)
    (define evaluations 0)
    (define (touch)
      (check-true (inside?))
      (set-box! incidental 'interaction)
      (initialize-test-object!))
    (define (isolated thunk)
      (set! calls (add1 calls))
      (define saved (test-object-copy (current-test-object)))
      (define state (unbox incidental))
      (dynamic-wind void
        (lambda () (parameterize ([inside? #t]) (thunk)))
        (lambda ()
          (define object (current-test-object))
          (set-test-object-tests! object (test-object-tests saved))
          (set-test-object-successful-tests! object (test-object-successful-tests saved))
          (set-test-object-failed-checks! object (test-object-failed-checks saved))
          (set-test-object-signature-violations! object (test-object-signature-violations saved))
          (set-box! incidental state))))
    (define selected
      (hasheq 'call-with-interaction-context isolated
              'expressions
              (hasheq 'read-interaction (lambda (src in) (touch) (native-read src in))
                      'lower (lambda (request)
                               (touch)
                               (define lowered (bridge request))
                               (datum->syntax #f
                                 (list 'begin
                                       (list (list 'quote (lambda () (set! evaluations (add1 evaluations)) (touch))))
                                       lowered))))))
    (define (intact)
      (check-true (test-object=? (current-test-object) original))
      (check-equal? (length (test-object-tests (current-test-object))) 2)
      (check-equal? (length (test-object-successful-tests (current-test-object))) 2)
      (check-equal? (unbox incidental) 'programme))
    (with-session program
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (define frame (car (frames ask stopped)))
        (define reference (locals ask frame))
        (for ([text '("!6" "!(error 'fixture \"failed\")" "!@missing" "broken")])
          (define ok? (equal? text "!6"))
          (for* ([context '("watch" "hover")]
                 [command '("evaluate" "setVariable" "racketdap/setBinding" "racketdap/skipExpression")]
                 #:unless (and (equal? context "hover") (equal? command "evaluate")))
            (define body
              (ask command (hasheq 'frameId (hash-ref frame 'id) 'threadId (hash-ref stopped 'threadId)
                                  'variablesReference reference 'name "x" 'value text 'expression text 'context context) ok?))
            (when (and ok? (equal? command "evaluate")) (check-equal? (hash-ref body 'result) "6"))
            (intact))
          (ask "evaluate" (hasheq 'frameId (hash-ref frame 'id) 'expression text 'context "repl") ok?)
          (intact))
        (check-true (> calls 0))
        (check-true (> evaluations 0)))
      #:context (lambda (_where _namespace) selected))
    (for ([text '("!6" "!(error 'fixture \"failed\")" "!@missing" "broken")])
      (with-session program
        (lambda (path ask event seen)
          (define stopped (start path ask event (list (hasheq 'line 4 'phase "after"))))
          (for ([context '("watch" "hover")])
            (ask "racketdap/replaceResults" (hasheq 'threadId (hash-ref stopped 'threadId) 'expression text 'context context) (equal? text "!6"))
            (intact)))
        #:context (lambda (_where _namespace) selected))
      (for ([kind '(condition segment)])
        (with-session program
          (lambda (path ask event seen)
            (define input (if (eq? kind 'condition) (hasheq 'line 4 'condition text)
                              (hasheq 'line 4 'logSegments (list (hasheq 'expression text)))))
            (start path ask event (list input (hasheq 'line 5)))
            (intact))
          #:context (lambda (_where _namespace) selected)))
      (with-session "#lang racket/base\n(provide run)\n(define (run) (void))\n"
        (lambda (path ask event seen)
          (ask "configurationDone") (event "racketdap/ready")
          (ask "evaluate" (hasheq 'expression text 'context "repl") (equal? text "!6"))
          (intact))
        #:interactive? #t #:context (lambda (_where _namespace) selected))))

  (test-case "native interactions without an isolation service are refused before reading"
    (define reads 0)
    (define unsafe
      (hasheq 'expressions (hash-set expressions 'read-interaction
                                     (lambda (src in) (set! reads (add1 reads)) (native-read src in)))))
    (with-session program
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (check-equal? (hash-ref stopped 'description) "Before expression")
        (define frame (car (frames ask stopped)))
        (ask "evaluate" (hasheq 'frameId (hash-ref frame 'id) 'expression "!6") #f)
        (check-equal? reads 0))
      #:context (lambda (_where _namespace) unsafe)))

  (test-case "configured error wording, bounded fallback and exception locations retain the original exception"
    (for ([formatter (list (lambda (message exception out) (display "configured wording" out))
                          (lambda (_message _exception _out) (error 'formatter "failed"))
                          (lambda (_message _exception out) (display (make-string 4097 #\x) out))
                          (lambda (_message _exception _out) (sync never-evt)))]
          [expected '("configured wording" "fixture: raw error" "fixture: raw error" "fixture: raw error")])
      (define selected (hasheq 'error-display formatter))
      (with-session program
        (lambda (path ask event seen)
          (define stopped (start path ask event))
          (define frame (car (frames ask stopped)))
          (ask "evaluate" (hasheq 'frameId (hash-ref frame 'id) 'expression "(error 'fixture \"raw error\")") #f)
          (define answer (car (unbox seen)))
          (check-equal? (hash-ref answer 'message) expected))
        #:context (lambda (_where _namespace) selected))))

  (test-case "configured errors retain rich locations, exception identity and condition and logpoint wording"
    (define observed '())
    (define selected
      (hasheq 'error-display (lambda (message exception out)
                              (set! observed (cons exception observed))
                              (check-equal? message (exn-message exception))
                              (display "configured wording" out))))
    (with-session
      "#lang racket/base\n(provide run)\n(define (run)\n  (void 'pause)\n  (error 'fixture \"raw error\"))\n"
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (define frame (car (frames ask stopped)))
        (define body (ask "evaluate"
                          (hasheq 'frameId (hash-ref frame 'id) 'context "repl"
                                  'expression "(error 'fixture \"raw error\")") #f))
        (check-equal? (hash-ref (car (unbox seen)) 'message) "configured wording")
        (check-not-equal? (hash-ref (hash-ref body 'racketdapError) 'locations) '())
        (ask "setExceptionBreakpoints" (hasheq 'filters '("uncaught")))
        (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
        (define failure (event "stopped"))
        (check-equal? (hash-ref failure 'reason) "exception")
        (check-equal? (hash-ref failure 'description) "configured wording")
        (define original (car observed))
        (define info (ask "exceptionInfo" (hasheq 'threadId (hash-ref failure 'threadId))))
        (check-equal? (hash-ref info 'description) "configured wording")
        (check-equal? (hash-ref (hash-ref info 'details) 'message) "configured wording")
        (check-eq? (car observed) original)
        (check-equal? (hash-ref (car (frames ask failure)) 'line) 5))
      #:rich? #t #:context (lambda (_where _namespace) selected))
    (for ([key '(condition logSegments)])
      (with-session program
        (lambda (path ask event seen)
          (define stopped
            (start path ask event
                   (list (hasheq 'line 4 key
                                 (if (eq? key 'condition) "(error 'fixture \"raw error\")"
                                     (list (hasheq 'expression "(error 'fixture \"raw error\")")))))))
          (check-equal? (hash-ref stopped 'description) "Breakpoint expression failed: configured wording"))
        #:context (lambda (_where _namespace) selected))))

  (test-case "captured printing context precedes owned guards and retains port handlers and conversion parameters"
    (define background #f)
    (define port (open-output-string))
    (port-print-handler port (lambda (v out [mode 0]) (fprintf out "native<~a>" v)))
    (define printer (current-print))
    (define callbacks 0)
    (define instrumented
      (parameterize ([current-namespace (namespace-anchor->namespace anchor)])
        (define unit (gensym 'printing))
        (define next 0)
        (define-values (rewritten _visible table)
          (instrument-module (expand #'(lambda (value out) (+ value 1)))
                             (syntax-source #'anchor)
                             (lambda () (set! next (add1 next)) next) #:form (cons unit 0)))
        (register-form-sites! unit 0 (lambda (_stop) (set! callbacks (add1 callbacks))) (map car table))
        (eval rewritten)))
    (instrumented 7 port)
    (check-true (> callbacks 0))
    (set! callbacks 0)
    (define captured
      (parameterize ([current-output-port port] [print-as-expression #f]) (current-parameterization)))
    (define printing-context? (make-parameter #f))
    (define (print-value value out)
      (check-eq? (current-print) printer)
      (check-false (print-as-expression))
      (set! background (thread (lambda () (sync never-evt))))
      (instrumented value out)
      (print value out))
    (define selected
      (hasheq 'call-with-print-context
              (lambda (thunk)
                (call-with-parameterization captured
                  (lambda () (parameterize ([printing-context? #t]) (thunk)))))
              'print (lambda (value out)
                       (if (printing-context?) (print-value value out)
                           (call-with-parameterization captured (lambda () (print-value value out)))))))
    (define text (value-preview 7 #:values selected))
    (define outcome (list text (thread-dead? background) callbacks))
    (unless (thread-dead? background) (kill-thread background))
    (check-equal? outcome '("native<7>" #t 0))
    (for ([finish (list (lambda (out) (error 'printing "failed"))
                       (lambda (out) (display (make-string 4097 #\x) out))
                       (lambda (out) (sync never-evt)))])
      (check-equal? (value-preview 7 #:values
                                  (hash-set selected 'print
                                            (lambda (value out)
                                              (set! background (thread (lambda () (sync never-evt))))
                                              (instrumented value out)
                                              (finish out)))) "[structural] 7")
      (check-true (thread-dead? background))
      (check-equal? callbacks 0)))

  (test-case "captured error contexts precede owned guards and suppress debugging"
    (define callbacks 0)
    (define instrumented
      (parameterize ([current-namespace (namespace-anchor->namespace anchor)])
        (define unit (gensym 'formatting))
        (define next 0)
        (define-values (rewritten _visible table)
          (instrument-module (expand #'(lambda (value out) (+ value 1)))
                             (syntax-source #'anchor)
                             (lambda () (set! next (add1 next)) next) #:form (cons unit 0)))
        (register-form-sites! unit 0 (lambda (_stop) (set! callbacks (add1 callbacks))) (map car table))
        (eval rewritten)))
    (instrumented 7 (open-output-nowhere))
    (check-true (> callbacks 0))
    (define inside? (make-parameter #f))
    (for ([finish (list (lambda (out) (display "captured wording" out))
                       (lambda (_out) (error 'formatting "failed"))
                       (lambda (out) (display (make-string 4097 #\x) out))
                       (lambda (_out) (sync never-evt)))]
          [expected '("captured wording" "fixture: raw error" "fixture: raw error" "fixture: raw error")])
      (define background #f)
      (define configured? #f)
      (define captured-owner (make-custodian))
      (define captured
        (parameterize ([current-custodian captured-owner] [print-as-expression #f]) (current-parameterization)))
      (set! callbacks 0)
      (define (format-error out)
        (set! configured? (not (print-as-expression)))
        (set! background (thread (lambda () (sync never-evt))))
        (instrumented 7 out)
        (finish out))
      (define selected
        (hasheq 'call-with-error-context
                (lambda (thunk)
                  (call-with-parameterization captured
                    (lambda () (parameterize ([inside? #t]) (thunk)))))
                'error-display (lambda (_message _exception out)
                                 (if (inside?) (format-error out)
                                     (call-with-parameterization captured (lambda () (format-error out)))))))
      (with-session program
        (lambda (path ask event seen)
          (define stopped (start path ask event))
          (define frame (car (frames ask stopped)))
          (ask "evaluate" (hasheq 'frameId (hash-ref frame 'id) 'expression "(error 'fixture \"raw error\")") #f)
          (define outcome (list (hash-ref (car (unbox seen)) 'message) (thread-dead? background) callbacks configured?))
          (custodian-shutdown-all captured-owner)
          (check-equal? outcome (list expected #t 0 #t)))
        #:context (lambda (_where _namespace) selected))))

  (test-case "imported failures retain their wording and locations through the interaction error"
    (define observed '())
    (define (wording text)
      (hasheq 'error-display (lambda (_message exception out)
                              (set! observed (cons exception observed))
                              (display text out))))
    (define imported (wording "imported wording"))
    (define launch (wording "launch wording"))
    (with-session
      "#lang racket/base\n(require \"other.rkt\")\n(provide run)\n(define (run) (inner))\n"
      (lambda (path ask event seen)
        (ask "setExceptionBreakpoints" (hasheq 'filters '("uncaught")))
        (ask "configurationDone")
        (define stopped (event "stopped"))
        (check-equal? (hash-ref stopped 'reason) "exception")
        (check-equal? (hash-ref stopped 'description) "imported wording")
        (define original (car observed))
        (define frame (car (frames ask stopped)))
        (check-equal? (hash-ref (hash-ref frame 'source) 'path)
                      (path->string (build-path (path-only path) "other.rkt")))
        (check-equal? (hash-ref frame 'line) 4)
        (check-equal? (hash-ref (ask "exceptionInfo" (hasheq 'threadId (hash-ref stopped 'threadId))) 'description)
                      "imported wording")
        ;; A failing evaluation while paused leaves the original failure's context in place.
        (ask "evaluate" (hasheq 'frameId (hash-ref frame 'id) 'context "repl"
                                'expression "(error 'probe \"paused failure\")") #f)
        (set! observed (list original))
        (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
        (define failure (event "racketdap/interactionError"))
        (check-equal? (hash-ref failure 'message) "imported wording")
        (check-true (andmap (lambda (exception) (eq? exception original)) observed))
        (define location (car (hash-ref failure 'locations)))
        (check-false (hash-ref location 'approximate))
        (check-equal? (hash-ref location 'line) 4)
        (check-equal? (hash-ref (list-ref (hash-ref failure 'sources) (hash-ref location 'source)) 'path)
                      (path->string (build-path (path-only path) "other.rkt"))))
      #:rich? #t
      #:context (lambda (where _namespace)
                  (if (and where (regexp-match? #rx"other[.]rkt$" (path->string (site-source where)))) imported launch))
      #:setup (lambda (directory)
                (display-to-file "#lang racket/base\n(provide inner)\n(define (inner)\n  (error 'fixture \"raw error\"))\n"
                                 (build-path directory "other.rkt")))))

  (test-case "pending interactions use the selected module identity with shared expression choices"
    (define current-instance (make-parameter 0))
    (define shared (hasheq 'read-interaction
                          (lambda (source in)
                            (if (eof-object? (read-char in)) eof (datum->syntax #f (current-instance))))))
    (define rule (compile-breakpoint-rule (hasheq 'condition "x") #:defer? #t))
    (define pending (expression-form (breakpoint-rule-condition rule)))
    (define a (hasheq 'expressions shared 'instance 'a))
    (define b (hasheq 'expressions shared 'instance 'b))
    (define-values (_required allowed) (procedure-keywords resolve-expression))
    (for ([selected (list a b a)] [n '(1 2 3)] [expected '(1 2 1)])
      (parameterize ([current-instance n])
        (check-equal? (syntax-e (if (memq '#:context allowed)
                                   (resolve-expression pending #:expressions shared #:context selected)
                                   (resolve-expression pending #:expressions shared))) expected))))

  (test-case "absent adapters retain immediate condition parse diagnostics with or without a resolver"
    (define diagnostics
      (for/list ([select (list #f (lambda (_where _namespace) #f))])
        (define answer #f)
        (with-session program
          (lambda (path ask event seen)
            (set! answer (car (hash-ref (ask "setBreakpoints"
              (hasheq 'source (hasheq 'path (path->string path))
                      'breakpoints (list (hasheq 'line 4 'condition "(")))) 'breakpoints)))
            (check-false (hash-ref answer 'verified))
            (check-regexp-match #rx"read:.*expected" (hash-ref answer 'message)))
          #:context select)
        (hash-ref answer 'message)))
    (check-equal? (car diagnostics) (cadr diagnostics)))

  (test-case "session fixtures respect the normal temporary directory"
    (with-files "#lang racket/base\n"
      (lambda (path directory)
        (check-equal? (simplify-path (path-only directory))
                      (simplify-path (find-system-path 'temp-dir)))))))
