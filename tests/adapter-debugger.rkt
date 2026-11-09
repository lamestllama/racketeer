#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/async-channel racket/file racket/list racket/path racket/port racket/string
         "../racketdap/protocol.rkt" "../racketdap/worker/load.rkt"
         "../racketdap/worker/session.rkt" "../racketdap/worker/expressions.rkt"
         "../racketdap/worker/inspect.rkt" "../racketdap/instrumentation/instrument.rkt")

;; A tiny language: ! introduces an interaction, @ introduces a local name.
;; Its printer deliberately produces notation that is not an expression.
(define prints (box 0))
(define reads (box 0))
(define (native-read source in)
  (set-box! reads (add1 (unbox reads)))
  (display "reader chatter\n")
  (define text (read-line in))
  (cond [(eof-object? text) eof]
        [(string=? text "") eof]
        [else
         (unless (string-prefix? text "!") (error 'tiny "Expected !"))
         (define form (read-syntax source (open-input-string (substring text 1))))
         (datum->syntax form (list 'tiny form) form)]))
(define (bridge request)
  (define form (cadr (syntax->list (hash-ref request 'term))))
  (define lexical (hash-ref (hash-ref request 'hooks) 'lexical-identifier))
  (define (walk term)
    (cond [(identifier? term)
           (define name (symbol->string (syntax-e term)))
           (if (string-prefix? name "@")
               (or (lexical (substring name 1)) (error 'tiny "No local ~a" name)) term)]
          [(syntax? term) (datum->syntax term (walk (syntax-e term)) term term)]
          [(pair? term) (cons (walk (car term)) (walk (cdr term)))]
          [else term]))
  (walk form))
(define (native-print value out)
  (set-box! prints (add1 (unbox prints)))
  (fprintf out "tiny<~s>\n" value))
(define expressions (hasheq 'read-interaction native-read 'lower bridge))
(define values-choice (hasheq 'print native-print))
(define native-context (hasheq 'expressions expressions 'values values-choice
                               'call-with-interaction-context (lambda (thunk) (thunk))))

(define (with-files text use)
  (define directory (make-temporary-file "adapter-~a" 'directory))
  (dynamic-wind
    void
    (lambda ()
      (define path (build-path directory "program.rkt"))
      (display-to-file text path)
      (use path directory))
    (lambda () (delete-directory/files directory))))

;; Pipes exercise the actual worker handlers without requiring a socket.
(define (with-session text use #:context [select (lambda (_where _namespace) native-context)]
                      #:interactive? [interactive? #f] #:rich? [rich? #f]
                      #:entry [entry 'run] #:test? [test? #f] #:setup [setup void]
                      #:cache-directory [cache-directory #f] #:adapter [adapter #f]
                      #:timeout [timeout 15] #:on-sites [observe-sites void])
  (with-files
   text
   (lambda (path directory)
     (setup directory)
     (define owner (make-custodian))
     (define seen (box '()))
     (define errors (open-output-string))
     (dynamic-wind
       void
       (lambda ()
         (parameterize ([current-custodian owner])
           (define-values (input requests) (make-pipe))
           (define-values (messages output) (make-pipe))
           (define incoming (make-async-channel))
           (thread (lambda () (let loop ()
                               (define message (read-message messages))
                               (unless (eof-object? message)
                                 (async-channel-put incoming message) (loop)))))
           (define runner
             (make-keyword-procedure
              (lambda (keys args program)
                (define options (for/hasheq ([key (in-list keys)] [arg (in-list args)]) (values key arg)))
                (parameterize ([current-output-port (open-output-nowhere)]
                               [current-error-port errors])
                  (run-module program #:gate (hash-ref options '#:gate)
                              #:on-event (hash-ref options '#:on-event)
                              #:on-sites (lambda (sites)
                                          (observe-sites sites)
                                          ((hash-ref options '#:on-sites) sites))
                              #:on-thread (hash-ref options '#:on-thread)
                              #:on-exception (hash-ref options '#:on-exception)
                              #:on-error (hash-ref options '#:on-error)
                              #:test? test?
                              #:cache-directory (if (eq? cache-directory 'project)
                                                    (build-path directory "cache") cache-directory)
                              #:language-adapter adapter
                              #:on-language-adapter (hash-ref options '#:on-language-adapter (lambda () void))
                              #:on-test-event (hash-ref options '#:on-test-event)
                              #:on-source-snapshot (hash-ref options '#:on-source-snapshot)
                              #:source-roots (list directory)
                              #:on-ready (hash-ref options '#:on-ready)
                              #:entry entry)))))
           (thread
            (lambda ()
              (define config (hasheq 'program (path->string path) 'cwd (path->string directory)
                                     'debugCache #f 'interactive interactive? 'testMode test? 'racketdapRichInteractions rich?))
              (define-values (_required allowed) (procedure-keywords serve-session))
              (if (and select (memq '#:module-context allowed))
                  (serve-session input output config (hasheq) runner #:module-context select)
                  (serve-session input output config (hasheq) runner))))
           (define seq 0)
           (define (await predicate)
             (let loop ()
               (define message (sync/timeout timeout incoming))
               (unless message (error 'test "Worker did not respond: ~a; ~s" (get-output-string errors) (take (unbox seen) (min 6 (length (unbox seen))))))
               (set-box! seen (cons message (unbox seen)))
               (cond [(predicate message) message]
                     [(equal? (hash-ref message 'type #f) "workerExit")
                      (error 'test "Worker exited: ~s; ~a" message (get-output-string errors))]
                     [else (loop)])))
           (define (ask command [arguments (hasheq)] [success? #t])
             (set! seq (add1 seq))
             (write-message (hasheq 'seq seq 'command command 'arguments arguments) requests)
             (define answer (await (lambda (m) (= (hash-ref m 'request_seq -1) seq))))
             (check-equal? (hash-ref answer 'success) success? (hash-ref answer 'message ""))
             (hash-ref answer 'body))
           (define (event name)
             (define message (await (lambda (m) (or (equal? (hash-ref m 'event #f) name)
                                                   (equal? (hash-ref m 'type #f) name)))))
             (hash-ref message 'body message))
           (use path ask event seen)))
       (lambda () (custodian-shutdown-all owner))))))

(define program
  (string-append "#lang racket/base\n(provide run)\n"
                 "(define (inner x)\n  (void 'pause)\n  (+ x 1))\n"
                 "(define (run)\n  (define x 20)\n  (list (inner 3) x))\n"))
(define (start path ask event [breaks (list (hasheq 'line 4))])
  (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string path)) 'breakpoints breaks))
  (ask "configurationDone")
  (event "stopped"))
(define (frames ask stopped)
  (hash-ref (ask "stackTrace" (hasheq 'threadId (hash-ref stopped 'threadId))) 'stackFrames))
(define (locals ask frame)
  (hash-ref (car (hash-ref (ask "scopes" (hasheq 'frameId (hash-ref frame 'id))) 'scopes)) 'variablesReference))
(define (evaluate ask text frame [context "watch"])
  (hash-ref (ask "evaluate" (hasheq 'expression text 'context context 'frameId (hash-ref frame 'id))) 'result))

(module+ support
  (provide with-session with-files program start frames locals evaluate
           native-read bridge expressions native-context))

(module+ test
  (test-case "native watches and console use the selected activation and preserve live mutation"
    (with-session program
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (define fs (frames ask stopped))
        (for ([context '("watch" "repl")])
          (check-equal? (evaluate ask "!(+ @x 2)" (car fs) context) "tiny<5>")
          (check-equal? (evaluate ask "!(+ @x 2)" (cadr fs) context) "tiny<22>"))
        (check-equal? (evaluate ask "!(begin (set! @x 7) @x)" (car fs)) "tiny<7>")
        (check-equal? (evaluate ask "!(values)" (car fs)) "#<zero values>")
        (check-equal? (evaluate ask "!(values @x 9)" (car fs)) "tiny<7>\ntiny<9>")
        (check-exn exn:fail? (lambda () (read-expression "!1\n!2" #:expressions expressions)))
        (void (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))))))
  (test-case "Variables, children, hovers and watch results use native notation by default"
    (with-session program
      (lambda (path ask event seen)
        (set-box! prints 0)
        (define stopped (start path ask event))
        (define frame (car (frames ask stopped)))
        (define reference (locals ask frame))
        (check-equal? (unbox prints) 0)
        (define rows (hash-ref (ask "variables" (hasheq 'variablesReference reference)) 'variables))
        (check-equal? (hash-ref (findf (lambda (row) (equal? (hash-ref row 'name) "x")) rows) 'value) "tiny<3>")
        (check-equal? (evaluate ask "x" frame "hover") "tiny<3>")
        (check-equal? (evaluate ask "!@x" frame) "tiny<3>")
        (check-equal? (unbox prints) 3)
        (define result (ask "evaluate" (hasheq 'expression "!(vector @x 8)" 'frameId (hash-ref frame 'id))))
        (define children (hash-ref (ask "variables" (hasheq 'variablesReference (hash-ref result 'variablesReference))) 'variables))
        (check-equal? (map (lambda (row) (hash-ref row 'value)) children) '("tiny<3>" "tiny<8>")))))
  (test-case "both assignment handlers read native expressions in their selected frame"
    (with-session program
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (define fs (frames ask stopped))
        (define caller (cadr fs))
        (define reference (locals ask caller))
        (check-equal? (hash-ref (ask "setVariable" (hasheq 'variablesReference reference 'name "x" 'value "!(+ @x 2)")) 'value) "tiny<22>")
        (check-equal? (hash-ref (ask "racketdap/setBinding" (hasheq 'frameId (hash-ref caller 'id) 'name "x" 'expression "!(+ @x 3)")) 'result) "tiny<25>")
        (check-equal? (evaluate ask "!@x" (car fs)) "tiny<3>"))))
  (test-case "conditions are read lazily and explicit segments accept native braces"
    (set-box! reads 0)
    (with-session program
      (lambda (path ask event seen)
        (define breaks
          (list (hasheq 'line 4 'condition "!(= @x 3)" 'hitCondition "%1"
                        'logSegments (list "result {" (hasheq 'expression "!{+ @x 2}") "}"))
                (hasheq 'line 5)))
        (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string path)) 'breakpoints breaks))
        (check-equal? (unbox reads) 0)
        (ask "configurationDone")
        (event "stopped")
        (check-not-false
         (findf (lambda (m) (equal? (hash-ref (hash-ref m 'body (hasheq)) 'output #f) "result {tiny<5>}\n")) (unbox seen))))))
  (test-case "legacy Racket templates keep their grammar even with a native adapter"
    (with-session program
      (lambda (path ask event seen)
        (start path ask event
               (list (hasheq 'line 4 'logMessage "{{x}}={x}, sum={(+ x 2)}") (hasheq 'line 5)))
        (check-not-false
         (findf (lambda (m) (equal? (hash-ref (hash-ref m 'body (hasheq)) 'output #f)
                                   "{x}=tiny<3>, sum=tiny<5>\n")) (unbox seen))))))
  (for ([mode '("racketdap/skipExpression" "racketdap/replaceResults")])
    (test-case (format "~a reads native zero and multiple results" mode)
      (with-session program
        (lambda (path ask event seen)
          (define stopped (start path ask event (list (hasheq 'line 4 'phase (if (equal? mode "racketdap/skipExpression") "before" "after")))))
          (check-equal? (hash-ref (ask mode (hasheq 'threadId (hash-ref stopped 'threadId) 'expression "!(values 6 7)")) 'result) "tiny<6>\ntiny<7>")
          (check-equal? (hash-ref (ask mode (hasheq 'threadId (hash-ref stopped 'threadId) 'expression "!(values)")) 'result) "#<zero values>")))))
  (test-case "console outside a frame uses the launch expression and value choices"
    (with-session "#lang racket/base\n(provide run)\n(define (run) (void))\n"
      (lambda (path ask event seen)
        (ask "configurationDone")
        (event "racketdap/ready")
        (check-equal? (hash-ref (ask "evaluate" (hasheq 'context "repl" 'expression "!(+ 4 5)")) 'result) "tiny<9>"))
      #:interactive? #t))
  (test-case "reader rejects empty and multiple interactions and preserves syntax"
    (parameterize ([current-output-port (open-output-nowhere)])
      (check-exn #rx"one language interaction" (lambda () (read-expression "" #:expressions expressions)))
      (check-exn #rx"one language interaction" (lambda () (read-expression "!1\n!2" #:expressions expressions)))
      (define scoped (let ([x 1]) #'x))
      (define choice (hasheq 'read-interaction (lambda (_ in) (if (eof-object? (read-char in)) eof scoped))))
      (check-eq? (read-expression "x" #:expressions choice) scoped)))
  (test-case "printer effects are accepted and error, output and time failures fall back structurally"
    (set-box! prints 0)
    (check-equal? (value-preview '(1 2) #:values values-choice) "tiny<(1 2)>")
    (check-equal? (unbox prints) 1)
    (define background #f)
    (value-preview 1 #:values (hasheq 'print (lambda (v out)
                                              (set! background (thread (lambda () (sync never-evt))))
                                              (display v out))))
    (check-true (thread-dead? background))
    (for ([printer (in-list
                    (list (lambda (_ out) (error 'tiny "printer failed"))
                          (lambda (_ out) (let loop () (display "overflow" out) (loop)))
                          (lambda (_ out) (sync never-evt))))])
      (check-equal? (value-preview '(1 2) #:values (hasheq 'print printer)) "[structural] (1 2)")))
  (test-case "worker previews, watches and hovers retain structural values after printer failures"
    (for ([printer (in-list (list (lambda (_ out) (error 'tiny "failed"))
                                 (lambda (_ out) (display (make-string 4097 #\x) out))
                                 (lambda (_ out) (sync never-evt))))])
      (define context (hash-set native-context 'values (hasheq 'print printer)))
      (with-session program
        (lambda (path ask event seen)
          (define stopped (start path ask event))
          (define frame (car (frames ask stopped)))
          (define reference (locals ask frame))
          (define rows (hash-ref (ask "variables" (hasheq 'variablesReference reference)) 'variables))
          (check-equal? (hash-ref (car rows) 'value) "[structural] 3")
          (check-equal? (evaluate ask "!@x" frame) "[structural] 3")
          (check-equal? (evaluate ask "x" frame "hover") "[structural] 3"))
        #:context (lambda (_where _namespace) context))))
  (test-case "optional value provider uses its print hook and bounded returned text"
    (define choice
      (hasheq 'print native-print
              'render (lambda (request)
                        (define out (open-output-string))
                        ((hash-ref (hash-ref request 'hooks) 'print) (hash-ref request 'value) out)
                        (string-append "provider:" (string-trim (get-output-string out))))))
    (check-equal? (value-preview 8 #:values choice) "provider:tiny<8>")
    (check-equal? (value-preview 8 #:values (hash-set choice 'render (lambda (_) (make-string 4097 #\x)))) "[structural] 8")
    (check-equal? (value-preview 8 #:values (hash-set choice 'render (lambda (_) #f))) "[structural] 8")
    (check-equal? (value-preview 8 #:values (hash-set choice 'print (lambda (_ out) (display (make-string 4097 #\x) out)))) "[structural] 8"))
  (test-case "configured interaction and print hooks work with identity lowering"
    (define captured #f)
    (with-session
      "#lang s-exp \"tiny-language.rkt\"\n(provide run)\n(define (run)\n  (let ([x 6])\n    (add1 x)))\n"
      (lambda (path ask event seen)
        (define stopped (start path ask event (list (hasheq 'line 5))))
        (define frame (car (frames ask stopped)))
        (check-equal? (evaluate ask "!(+ x 2)" frame) "configured<8>"))
      #:context
      (lambda (_where namespace)
        (if (not namespace) native-context
        (or captured
            (let ([reader (current-read-interaction)] [printer (current-print)])
              (set! captured
                    (hasheq 'call-with-interaction-context (lambda (thunk) (thunk))
                            'expressions (hasheq 'read-interaction reader)
                            'values (hasheq 'print (lambda (v out) (parameterize ([current-output-port out]) (printer v))))))
              captured))))
      #:setup
      (lambda (directory)
        (display-to-file
          (string-append
            "#lang racket/base\n(require (for-syntax racket/base))\n"
            "(provide (except-out (all-from-out racket/base) #%module-begin) (rename-out [tiny-begin #%module-begin]))\n"
            "(define-syntax-rule (tiny-begin form ...)\n"
            "  (#%plain-module-begin\n"
            "    (module configure-runtime racket/base\n"
            "      (current-read-interaction (lambda (src in)\n"
            "        (let skip () (when (and (char? (peek-char in)) (char-whitespace? (peek-char in))) (read-char in) (skip)))\n"
            "        (define char (read-char in))\n"
            "        (cond [(eof-object? char) eof] [(eqv? char #\\!) (read-syntax src in)] [else (error 'tiny \"Expected !\")])))\n"
            "      (current-print (lambda (v) (printf \"configured<~s>\\n\" v))))\n"
            "    form ...))\n")
          (build-path directory "tiny-language.rkt")))))
  (test-case "imported frames and launch callers select separate module contexts"
    (define imported-expressions
      (hash-set expressions 'read-interaction
                (lambda (source in)
                  (define text (read-line in))
                  (if (eof-object? text) eof
                      (native-read source (open-input-string (string-append "!" (substring text 1))))))))
    (define imported-context
      (hasheq 'expressions imported-expressions
              'call-with-interaction-context (lambda (thunk) (thunk))
              'values (hasheq 'print (lambda (v out) (fprintf out "imported<~s>" v)))))
    (with-session
      "#lang racket/base\n(require \"other.rkt\")\n(provide run)\n(define (run) (let ([x 20]) (list (inner 3) x)))\n"
      (lambda (path ask event seen)
        (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string (build-path (path-only path) "other.rkt")))
                                      'breakpoints (list (hasheq 'line 4))))
        (ask "configurationDone")
        (define stopped (event "stopped"))
        (define fs (frames ask stopped))
        (check-equal? (evaluate ask "?(+ @x 2)" (car fs)) "imported<5>")
        (check-equal? (evaluate ask "!(+ @x 2)" (cadr fs)) "tiny<22>")
        (check-equal? (evaluate ask "x" (car fs) "hover") "imported<3>")
        (check-equal? (evaluate ask "x" (cadr fs) "hover") "tiny<20>"))
      #:context (lambda (where _namespace)
                  (if (and where (regexp-match? #rx"other[.]rkt$" (path->string (site-source where)))) imported-context native-context))
      #:setup (lambda (directory)
                (display-to-file "#lang racket/base\n(provide inner)\n(define (inner x)\n  (void x)\n  (+ x 1))\n" (build-path directory "other.rkt")))))
  (test-case "no adapter keeps Racket parsing and text and never calls native hooks"
    (set-box! prints 0)
    (set-box! reads 0)
    (with-session program
      (lambda (path ask event seen)
        (define stopped (start path ask event))
        (define frame (car (frames ask stopped)))
        (check-equal? (evaluate ask "(+ x 2)" frame) "5")
        (check-equal? (evaluate ask "x" frame "hover") "3")
        (check-equal? (unbox prints) 0)
        (check-equal? (unbox reads) 0)
        (define rule (compile-breakpoint-rule (hasheq 'logMessage "{{x}}={x}; sum={(+ x 2)}")))
        (check-equal? (render-log-message (breakpoint-rule-log rule)
                                        (lambda (form) (eval `(let ([x 3]) ,form) (make-base-namespace))) value-preview)
                      "{x}=3; sum=5\n"))
      #:context #f)))

(module+ test
  (test-case "native interactions retain live programme parameters and their writes"
    (when (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
      (with-session
        (string-append
         "#lang rhombus\nimport: \"state.rkt\" open\nexport: run\n"
         "fun run():\n  p(10)\n  1 + 1\n  p(30)\n  2 + 2\n  p()\n")
        (lambda (path ask event seen)
          (define stopped (start path ask event (list (hasheq 'line 6) (hasheq 'line 8))))
          (define frame (car (frames ask stopped)))
          (check-equal? (evaluate ask "p()" frame) "10")
          (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
          (define next (event "stopped"))
          (define selected (car (frames ask next)))
          (check-equal? (evaluate ask "p()" selected) "30")
          (evaluate ask "p(45)" selected "repl")
          (check-equal? (evaluate ask "p()" selected) "45")
          (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string path)) 'breakpoints '()))
          (ask "continue" (hasheq 'threadId (hash-ref next 'threadId)))
          (check-equal? (hash-ref (event "workerExit") 'exitCode) 0))
        #:context #f #:timeout 120
        #:setup
        (lambda (directory)
          (display-to-file "#lang racket/base\n(provide p)\n(define p (make-parameter 0))\n"
                           (build-path directory "state.rkt"))))))

  (test-case "generic frames resolve contexts without repeated evaluation"
    (define calls 0)
    (define references 0)
    (define original (current-eval))
    (parameterize ([current-eval
                    (lambda (form)
                      (set! calls (add1 calls))
                      (when (equal? (if (syntax? form) (syntax->datum form) form) '(#%variable-reference))
                        (set! references (add1 references)))
                      (original form))])
      (with-session program
        (lambda (path ask event seen)
          (define stopped (start path ask event))
          (check-equal? references 0)
          (define before calls)
          (frames ask stopped)
          (check-equal? calls before)
          (for ([_ (in-range 3)])
            (frames ask stopped)
            (check-equal? calls before)))
        #:context #f)
      (when (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
        (with-session
          "#lang racket/base\n(require \"other.rhm\")\n(provide run)\n(define (run) (+ (inner 3) 1))\n"
          (lambda (path ask event seen)
            (ask "setBreakpoints"
                 (hasheq 'source (hasheq 'path (path->string (build-path (path-only path) "other.rhm")))
                         'breakpoints (list (hasheq 'line 4))))
            (ask "configurationDone")
            (define stopped (event "stopped"))
            (define fs (frames ask stopped))
            (check-true (hash-ref (car fs) 'racketdapNativeExpressions #f))
            (check-false (hash-ref (cadr fs) 'racketdapNativeExpressions #f))
            (define before calls)
            (for ([_ (in-range 3)])
              (frames ask stopped)
              (check-equal? calls before)))
          #:context #f #:timeout 120
          #:setup (lambda (directory)
                    (display-to-file
                     "#lang rhombus\nexport: inner\nfun inner(x):\n  x + 1\n"
                     (build-path directory "other.rhm"))))))))
