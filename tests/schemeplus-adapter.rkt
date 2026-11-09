#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class racket/file racket/list racket/port racket/runtime-path racket/string
         (submod "adapter-debugger.rkt" support)
         "../racketdap/language-adapters.rkt"
         "../racketdap/worker/load.rkt"
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/doclib/textbuffer/text-port.rkt")

(define-runtime-path launcher "../vscode/language-adapters.rkt")

(define available?
  (and (equal? (getenv "RACKETDAP_TEST_SCHEMEPLUS") "1")
       (with-handlers ([exn:fail? (lambda (_) #f)])
         (and (file-exists? (collection-file-path "main.rkt" "Scheme+"))
              (file-exists? (collection-file-path "main.rkt" "SRFI-105"))))))
(define text
  (string-append
   "#lang reader SRFI-105\n(module program racket\n(require Scheme+)\n(provide run)\n"
   "(define (inner x)\n  (let ([y {x + 1}])\n    {y * 2}))\n"
   "(define (run)\n  {x := 20}\n"
   "  (for ({i := 0} {i < 2} {i <- i + 1})\n    {x <- x + i})\n"
   "  {inner(x) + x})\n)\n"))
(define annotated
  (string-append
   "#lang reader SRFI-105\n(module program racket\n(require Scheme+)\nANNOTATION-ON\n"
   "(provide run)\n(define (run)\n  {x := 2.0}\n  (type flonum? x)\n  {x + 3.0})\n)\n"))
(define (session source use #:disabled? [disabled? #f] #:interactive? [interactive? #f])
  (with-files "(profile)"
    (lambda (override _directory)
      (with-session source use #:context #f #:timeout 90 #:interactive? interactive?
                    #:adapter (and disabled? override)))))
(define (position frame)
  (list (hash-ref frame 'line) (hash-ref frame 'column)))
(define (check-frame frame path expected)
  (check-equal? (hash-ref (hash-ref frame 'source) 'path) (path->string path))
  (check-equal? (position frame) expected))
(define (move ask event stopped command)
  (ask command (hasheq 'threadId (hash-ref stopped 'threadId)))
  (event "stopped"))
(define (rows ask frame)
  (hash-ref (ask "variables" (hasheq 'variablesReference (locals ask frame))) 'variables))
(define (row table name)
  (findf (lambda (r) (equal? (hash-ref r 'name) name)) table))
(define (analyse path source-text only?)
  (define source (path->source path))
  (define doc (make-doc (source-uri source) source-text))
  (define trace
    (new build-trace% [source source] [doc-text (doc-copy-text-buffer doc)]
         [lexer-state (build-lexer-state source-text (source-uri source))]
         [contribution-only? only?]))
  (define result
    (parameterize ([current-output-port (open-output-nowhere)])
      (expand-source source (open-input-text source-text) trace #:contribution-only? only?)))
  (check-true (ExpandResult-all-succeed? result)
              (format "~a ~a" (ExpandResult-pre-exn result) (ExpandResult-post-exn result)))
  (send trace walk-stx result)
  (doc-update-trace! doc trace (send trace get-contribution) 0)
  (values doc trace))
(define (symbols xs)
  (append-map (lambda (x) (cons x (symbols (DocumentSymbol-children x)))) xs))

(module+ test
  (when available? (dynamic-require launcher #f))
  (unless available?
    (displayln "Skipping Scheme+ adapter: set RACKETDAP_TEST_SCHEMEPLUS=1 with Scheme+ 20.1 and SRFI-105 17.1 installed."))

  (test-case "reader identity selects the descriptor without changing ordinary Racket"
    (when available?
      (with-files text
        (lambda (path _directory)
          (define selected (resolve-language-adapter path))
          (check-not-equal? (hash-ref selected 'match) '())
          (check-equal? (hash-ref selected 'source) 'reader)
          (check-equal? (hash-ref selected 'bindings) 'expanded)
          (check-equal? (hash-ref (resolve-language-adapter path #:registry '()) 'match) '())
          (check-equal? (hash-ref (resolve-language-adapter path #:text "#lang racket/base\n(void)\n") 'match) '())))))

  (test-case "generic execution preserves infix, neoteric calls, definitions, nested blocks, loops and annotations"
    (when available?
      (for ([source (list text annotated)] [expected '(65 5.0)])
        (with-files source
          (lambda (path directory)
            (for ([instrument? '(#f #t)])
              (parameterize ([current-output-port (open-output-nowhere)])
                (check-equal? (run-module path #:entry 'run #:instrument? instrument?
                                          #:source-roots (list directory)) expected))))))))

  (test-case "line breakpoints keep exact nested, loop and annotation ranges"
    (when available?
      (for ([line '(6 7 9 10 11 12)]
            [expected '((6 3) (7 5) (10 4) (10 4) (11 8) (12 3))])
        (session text
          (lambda (path ask event _seen)
            (define stopped (start path ask event (list (hasheq 'line line))))
            (check-frame (car (frames ask stopped)) path expected))))
      (session annotated
        (lambda (path ask event _seen)
          (check-frame (car (frames ask (start path ask event (list (hasheq 'line 9))))) path '(9 3))))))

  (test-case "In and Over preserve the exact caller and nested frame locations"
    (when available?
      (session text
        (lambda (path ask event _seen)
          (define stopped (start path ask event (list (hasheq 'line 12))))
          (check-frame (car (frames ask stopped)) path '(12 3))
          (set! stopped (move ask event stopped "stepIn"))
          (check-frame (car (frames ask stopped)) path '(12 4))
          (set! stopped (move ask event stopped "stepIn"))
          (define fs (frames ask stopped))
          (check-equal? (length fs) 2)
          (check-frame (car fs) path '(6 3))
          (check-frame (cadr fs) path '(12 4))
          (set! stopped (move ask event stopped "next"))
          (check-frame (car (frames ask stopped)) path '(12 10))))))

  (test-case "Out returns from the nested block to the exact caller"
    (when available?
      (session text
        (lambda (path ask event _seen)
          (define stopped (start path ask event (list (hasheq 'line 7))))
          (check-frame (car (frames ask stopped)) path '(7 5))
          (define returned (move ask event stopped "stepOut"))
          (check-frame (car (frames ask returned)) path '(12 10))))))

  (test-case "locals and native previews retain values in both selected frames"
    (when available?
      (session text
        (lambda (_path ask event _seen)
          (define fs (frames ask (start _path ask event (list (hasheq 'line 7)))))
          (check-equal? (hash-ref (row (rows ask (car fs)) "y") 'value) "22")
          (for ([frame fs])
            (check-equal? (hash-ref (row (rows ask frame) "x") 'value) "21")
            (check-equal? (evaluate ask "x" frame "hover") "21"))))))

  (test-case "native watches and console use infix and neoteric syntax with selected locals"
    (when available?
      (for ([disabled? '(#t #f)])
        (session text #:disabled? disabled?
          (lambda (path ask event _seen)
            (define fs (frames ask (start path ask event (list (hasheq 'line 7)))))
            (for* ([frame fs] [context '("watch" "repl")]
                   [expression '("{x + 2}" "{add1(x)}")])
              (define result
                (ask "evaluate" (hasheq 'expression expression 'context context 'frameId (hash-ref frame 'id))
                     (not disabled?)))
              (unless disabled?
                (check-true (hash-ref frame 'racketdapNativeExpressions #f))
                (check-equal? (hash-ref result 'result) (if (equal? expression "{x + 2}") "23" "22"))))
            (unless disabled?
              (check-equal? (evaluate ask "{y + 2}" (car fs)) "24")
              (ask "evaluate" (hasheq 'expression "{y + 2}" 'frameId (hash-ref (cadr fs) 'id)) #f)))))))

  (test-case "annotated interactions use the package reader and do not retain a watch pragma"
    (when available?
      (for ([disabled? '(#t #f)])
        (session annotated #:disabled? disabled?
          (lambda (path ask event _seen)
            (define frame (car (frames ask (start path ask event (list (hasheq 'line 9))))))
            (define result (ask "evaluate" (hasheq 'expression "{x + 2.0}" 'frameId (hash-ref frame 'id))
                                (not disabled?)))
            (unless disabled?
              (check-equal? (hash-ref result 'result) "4.0")
              (evaluate ask "ANNOTATION-OFF" frame)
              (ask "evaluate" (hasheq 'expression "{car(x)}" 'frameId (hash-ref frame 'id)) #f)
              (check-equal? (evaluate ask "{x + 2.0}" frame) "4.0")))))))

  (test-case "native console without a frame retains the launch syntax and printer"
    (when available?
      (for ([disabled? '(#t #f)])
        (session text #:disabled? disabled? #:interactive? #t
          (lambda (_path ask event _seen)
            (ask "configurationDone")
            (event "racketdap/ready")
            (define result (ask "evaluate" (hasheq 'context "repl" 'expression "{list({2 + 3} 8)}")
                                (not disabled?)))
            (unless disabled? (check-equal? (hash-ref result 'result) "'(5 8)")))))))

  (test-case "runtime errors retain exact source locations and error messages"
    (when available?
      (session (string-replace text "{inner(x) + x}" "{x / 0}")
        (lambda (path ask event _seen)
          (ask "setExceptionBreakpoints" (hasheq 'filters '("uncaught")))
          (ask "configurationDone")
          (define stopped (event "stopped"))
          (check-equal? (hash-ref stopped 'reason) "exception")
          (check-frame (car (frames ask stopped)) path '(12 3))
          (check-regexp-match #rx"division by zero"
                              (hash-ref (ask "exceptionInfo" (hasheq 'threadId (hash-ref stopped 'threadId))) 'description))))))

  (test-case "full and contribution analysis retain exact definitions and references"
    (when available?
      (for ([source (list text annotated)] [uses (list (list (Pos 11 3) (Pos 11 9) (Pos 6 5)) (list (Pos 8 3)))]
            [definitions (list (list (Range (Pos 4 9) (Pos 4 14)) (Range (Pos 8 3) (Pos 8 4))
                                     (Range (Pos 5 9) (Pos 5 10))) (list (Range (Pos 6 3) (Pos 6 4))))])
        (with-files source
          (lambda (path _directory)
            (define graphs
              (for/list ([only? '(#f #t)])
                (define-values (doc _trace) (analyse path source only?))
                (for/list ([pos uses] [expected definitions])
                  (check-equal? (doc-definition doc (Doc-uri doc) pos) (Location (Doc-uri doc) expected))
                  (define refs (doc-references doc (Doc-uri doc) pos #t))
                  (check-not-false refs)
                  (define locations (Reference-Source-locations (Document-Reference-Result-source refs)))
                  (check-not-false (member (Location (Doc-uri doc) expected) locations))
                  (define use-range
                    (Range pos (Pos (Pos-line pos) (+ (Pos-char pos)
                                                     (if (equal? expected (Range (Pos 4 9) (Pos 4 14))) 5 1)))))
                  (check-not-false (member (Location (Doc-uri doc) use-range) locations))
                  (check-equal? (doc-occurrence-at doc pos) use-range)
                  locations)))
            (check-equal? (car graphs) (cadr graphs)))))))

  (test-case "full analysis supplies hover, outline and tokens; contribution analysis omits display products"
    (when available?
      (for ([source (list text annotated)] [pos (list (Pos 11 9) (Pos 8 3))])
        (with-files source
          (lambda (path _directory)
            (for ([only? '(#f #t)])
              (define-values (doc trace) (analyse path source only?))
              (check-equal? (doc-diagnostics doc) '())
              (define outline (symbols (doc-symbols-hierarchical doc)))
              (define run (findf (lambda (entry) (equal? (DocumentSymbol-name entry) "run")) outline))
              (check-not-false run)
              (check-equal? (DocumentSymbol-selectionRange run)
                            (if (equal? source text) (Range (Pos 7 9) (Pos 7 12))
                                (Range (Pos 5 9) (Pos 5 12))))
              (check-false (findf (lambda (entry) (equal? (DocumentSymbol-name entry) "x")) outline))
              (when (equal? source text)
                (define loop (findf (lambda (entry) (equal? (DocumentSymbol-name entry) "for")) outline))
                (check-not-false loop)
                (check-equal? (DocumentSymbol-kind loop) SymbolKind-Object))
              (if only?
                  (begin (check-false (doc-hover doc pos)) (check-equal? (send trace get-semantic-tokens) '()))
                  (let ([start (doc-pos->abs-pos doc pos)])
                    (check-not-false (doc-hover doc pos))
                    (check-not-false
                     (findf (lambda (token) (and (= (SemanticToken-start token) start)
                                                (= (SemanticToken-end token) (add1 start))))
                            (send trace get-semantic-tokens)))))))))))

  (test-case "full diagnostics retain exact error ranges; contribution analysis omits diagnostics"
    (when available?
      (with-files (string-replace text "{inner(x) + x}" "{missing + x}")
        (lambda (path _directory)
          (define broken (file->string path))
          (for ([only? '(#f #t)])
            (define doc (make-doc (source-uri (path->source path)) broken))
            (define result
              (parameterize ([current-output-port (open-output-nowhere)])
                (doc-check-syntax doc #:contribution-only? only?)))
            (check-false (CSResult-succeed? result))
            (doc-update-trace! doc (CSResult-trace result)
                               (send (CSResult-trace result) get-contribution) 0)
            (define diagnostics (doc-diagnostics doc))
            (if only?
                (check-equal? diagnostics '())
                (begin
                  (check-equal? (length diagnostics) 1)
                  (check-equal? (Diagnostic-range (car diagnostics)) (Range (Pos 11 3) (Pos 11 10)))
                  (check-regexp-match #rx"unbound identifier" (Diagnostic-message (car diagnostics))))))))))


  (test-case "SRFI-105 alone and the Scheme+ library retain generic execution"
    (when available?
      (for ([source (list "#lang reader SRFI-105\n(module program racket/base (provide run) (define (run) {add1(4) + 2}))\n"
                          "#lang racket/base\n(require Scheme+)\n(provide run)\n(define (run) (:= x 6) (+ x 1))\n")])
        (with-files source
          (lambda (path directory)
            (for ([instrument? '(#f #t)])
              (parameterize ([current-output-port (open-output-nowhere)])
                (check-equal? (run-module path #:entry 'run #:instrument? instrument?
                                          #:source-roots (list directory)) 7))))))))

  (test-case "Variables, watches and children use configured list and vector notation"
    (when available?
      (define values-text (string-replace text "[y {x + 1}]" "[y {x + 1}] [items (list x 8)]"))
      (for ([disabled? '(#t #f)])
        (session values-text #:disabled? disabled?
          (lambda (path ask event _seen)
            (define frame (car (frames ask (start path ask event (list (hasheq 'line 7))))))
            (define items (row (rows ask frame) "items"))
            (check-equal? (hash-ref items 'value) (if disabled? "(21 8)" "'(21 8)"))
            (define children (hash-ref (ask "variables" (hasheq 'variablesReference
                                                                (hash-ref items 'variablesReference))) 'variables))
            (check-equal? (map (lambda (child) (hash-ref child 'value)) children) (if disabled? '("21" "(8)") '("21" "'(8)")))
            (unless disabled?
              (check-equal? (evaluate ask "items" frame) "'(21 8)")
              (check-equal? (evaluate ask "{vector(x y)}" frame) "'#(21 22)")))))))

  (test-case "native assignments update live storage and fail under an empty profile"
    (when available?
      (for ([disabled? '(#t #f)])
        (session text #:disabled? disabled?
          (lambda (path ask event _seen)
            (define frame (car (frames ask (start path ask event (list (hasheq 'line 11))))))
            (define result (ask "setVariable" (hasheq 'variablesReference (locals ask frame)
                                                     'name "x" 'value "{x + 2}") (not disabled?)))
            (unless disabled?
              (check-equal? (hash-ref result 'value) "22")
              (check-equal? (evaluate ask "x" frame) "22")))))))

  (test-case "interactions preserve the programme's reader hook on success, failure and continuation"
    (when available?
      (with-files text
        (lambda (path _directory)
          (define reference (hash-ref (resolve-language-adapter path) 'bootstrap))
          (define services
            (call-language-provider (cadr reference)
              (make-provider-request 'bootstrap #:text text
                #:hooks (hasheq 'call-with-interaction-context (lambda (thunk) (thunk))))
              #:field 'bootstrap))
          (define enter (hash-ref services 'call-with-interaction-context))
          (define reader (hash-ref services 'read-interaction))
          (define original (current-read-interaction))
          (define namespace (make-base-namespace))
          (define (interact expression)
            (enter (lambda ()
                     (eval (syntax->datum (reader #f (open-input-string expression))) namespace))))
          (check-equal? (interact "{1 + 2}") 3)
          (check-eq? (current-read-interaction) original)
          (check-exn exn:fail:read? (lambda () (interact "{")))
          (check-eq? (current-read-interaction) original)
          (check-exn #rx"division by zero" (lambda () (interact "{1 / 0}")))
          (check-eq? (current-read-interaction) original)))
      (define hook-text
        (string-append
         "#lang reader SRFI-105\n(module program racket\n(require Scheme+)\n(provide run)\n"
         "(define (run)\n  (define original (current-read-interaction))\n  (void 'before)\n"
         "  (define unchanged? (eq? original (current-read-interaction)))\n  (void 'after)\n"
         "  unchanged?)\n)\n"))
      (for* ([context '("watch" "repl")]
             [expression '(#f "{1 + 2}" "{" "{1 / 0}")])
        (session hook-text
          (lambda (path ask event _seen)
            (define stopped (start path ask event (list (hasheq 'line 7) (hasheq 'line 9))))
            (define frame (car (frames ask stopped)))
            (when expression
              (define result
                (ask "evaluate" (hasheq 'expression expression 'context context
                                        'frameId (hash-ref frame 'id))
                     (equal? expression "{1 + 2}")))
              (when (equal? expression "{1 + 2}")
                (check-equal? (hash-ref result 'result) "3")))
            (define resumed (move ask event stopped "continue"))
            (define selected (car (frames ask resumed)))
            (check-frame selected path '(9 3))
            (check-equal? (evaluate ask "unchanged?" selected "hover") "#t"
                          (format "~a interaction ~s" context expression))
            (ask "continue" (hasheq 'threadId (hash-ref resumed 'threadId)))
            (check-equal? (hash-ref (event "workerExit") 'exitCode) 0))))))

  (test-case "interaction pragmas are isolated before reading, including failed evaluation"
    (when available?
      (with-files annotated
        (lambda (path _directory)
          (define descriptor (resolve-language-adapter path))
          (define reference (hash-ref descriptor 'bootstrap))
          (check-true (pair? reference))
          (define services
            (call-language-provider (cadr reference)
              (make-provider-request 'bootstrap #:text annotated
                #:hooks (hasheq 'call-with-interaction-context (lambda (thunk) (thunk))))
              #:field 'bootstrap))
          (check-exn #rx"module source"
                     (lambda () (call-language-provider (cadr reference)
                                   (make-provider-request 'bootstrap) #:field 'bootstrap)))
          (define enter (hash-ref services 'call-with-interaction-context))
          (define reader (hash-ref services 'read-interaction))
          (define (read-native text)
            (parameterize ([current-output-port (open-output-nowhere)])
              (enter (lambda () (syntax->datum (reader #f (open-input-string text)))))))
          (check-equal? (read-native "{1.0 + 2.0}") 3.0)
          (read-native "ANNOTATION-OFF")
          (check-equal? (read-native "{1.0 + 2.0}") 3.0)
          (check-exn #rx"failed interaction"
                     (lambda ()
                       (parameterize ([current-output-port (open-output-nowhere)])
                         (enter (lambda ()
                                  (reader #f (open-input-string "ANNOTATION-OFF"))
                                  (error 'test "failed interaction"))))))
          (check-equal? (read-native "{1.0 + 2.0}") 3.0)))))
)
