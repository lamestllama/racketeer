#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/file racket/list racket/port racket/path racket/runtime-path
         (submod "../tests/adapter-debugger.rkt" support)
         (only-in "../racketdap/language-adapters.rkt" validate-language-profile)
         (only-in "../racketdap/adapters/teaching-rename.rkt" [rename native-rename])
         "../racketdap/worker/load.rkt"
         (only-in "../racketdap/instrumentation/instrument.rkt" site-expression)
         "../vscode/language-adapters.rkt"
         "../vscode/workspace-rename.rkt"
         "../racketdap/tools/bindings-service.rkt"
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/doclib/language-adapter.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/doc-trace.rkt"
         "../vendor/collects/racket-langserver/doclib/check-syntax.rkt"
         "../vendor/collects/racket-langserver/doclib/internal-types.rkt"
         "../vendor/collects/racket-langserver/doclib/lexer.rkt"
         "../vendor/collects/racket-langserver/doclib/textbuffer/text-port.rkt")

(define-runtime-path providers "../racketdap/adapters")
(define (reference file export level) (vector `(file ,(path->string (build-path providers file))) export level))
(define (descriptor level)
  `(profile
    (bootstrap (auto ,(reference "teaching.rkt" 'interactions level)))
    (bindings (expanded+ ,(reference "teaching-bindings.rkt" 'bindings level)))
    (editor (rename (expanded-graph ,(reference "teaching-rename.rkt" 'rename level)))
            (declarations ,(reference "teaching-editor.rkt" 'declarations level))
            (calls ,(reference "teaching-editor.rkt" 'calls level))
            (completion (expanded+ ,(reference "teaching-editor.rkt" 'completion level))))))
(define (with-adapter level use)
  (with-files (format "~s\n" (descriptor level)) (lambda (file _root) (use file))))
(define (analyse file text only?)
  (define doc (make-doc (source-uri (path->source file)) text))
  (check-true (doc-expand! doc #:contribution-only? only?))
  doc)

(define (edits result file) (hash-ref (hash-ref result 'changes) (string->symbol (source-uri (path->source file)))))
(define (edit start end text)
  (hasheq 'range (hasheq 'start (hasheq 'line (car start) 'character (cadr start))
                        'end (hasheq 'line (car end) 'character (cadr end))) 'newText text))

(define (accept-level level)
  (define editor-text
    (string-append (format "#lang htdp/~a\n" level) "(define-struct point (x y))\n"
                 "(define (shift n) (cond [(zero? n) 0] [else (shift (sub1 n))]))\n"
                 "(define sample (make-point 3 4))\n(point-x sample)\n(shift 2)\n(define x 99)\n"))
  (define debug-text
    (string-append (format "#lang htdp/~a\n" level) "(define-struct point (x y))\n"
                 "(define sample (make-point 3 4))\n(define (shift n)\n  (+ n 1))\n"
                 "(check-expect 1 2)\n(check-expect (shift 2) 3)\n"))
  (test-case (format "~a keeps authored macro, anonymous-function and assignment restrictions" level)
    (with-adapter level
      (lambda (adapter)
        (for ([form (append '("(define-syntax-rule (m) 1)")
                            (if (memq level '(bsl bsl+ isl)) '("(lambda (x) x)") '())
                            (if (eq? level 'asl) '() '("(define x 1) (set! x 2)"))
                            (if (memq level '(bsl bsl+)) '("(local [] 1)") '()))])
          (with-files (string-append (format "#lang htdp/~a\n" level) form)
            (lambda (file _root)
              (for ([instrument? '(#f #t)])
                (check-exn exn:fail? (lambda () (run-module file #:instrument? instrument? #:language-adapter adapter))))))))))

  (test-case (format "~a full and index graphs preserve structure hover and exact field anchors" level)
    (with-files editor-text
      (lambda (file _root)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
          (define uri (source-uri (path->source file)))
          (check-equal? (navigation file editor-text 'definition 4 7)
                        (list (hasheq 'uri uri 'range (written-range 1 22 23))))
          (check-equal? (navigation file editor-text 'definition 5 1)
                        (list (hasheq 'uri uri 'range (written-range 2 9 14))))
          (for ([only? '(#f #t)])
            (define doc (analyse file editor-text only?))
            (check-equal? (doc-definition-at doc (Pos 4 7)) (Range (Pos 1 22) (Pos 1 23)))
            (check-equal? (doc-definition-at doc (Pos 5 1)) (Range (Pos 2 9) (Pos 2 14)))
            (unless only?
              (check-regexp-match #rx"define-struct point" (Hover-contents (doc-hover doc (Pos 1 16))))
              (define outline (doc-symbols-hierarchical doc))
              (check-equal? (map DocumentSymbol-name outline) '("point" "shift" "sample" "x"))
              (check-equal? (DocumentSymbol-kind (cadr outline)) SymbolKind-Function)
              (check-equal? (DocumentSymbol-children (cadr outline)) '())
              (define (labels at)
                (parameterize ([current-completion-position (doc-pos->abs-pos doc at)])
                  (check-true (doc-expand! doc)))
                (map CompletionItem-label (CompletionList-items (doc-completion doc at))))
              (check-not-false (member "n" (labels (Pos 2 30))))
              (check-false (member "n" (labels (Pos 5 1))))
              (define help (doc-signature-help doc (Pos 5 8)))
              (check-not-false help)
              (check-equal? (SignatureInformation-label (car (SignatureHelp-signatures help))) "(shift n)")))))))

  (test-case (format "~a workspace function rename succeeds and reserved names and recursive capture refuse" level)
    (with-files editor-text
      (lambda (file _root)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
          (define sources (hash file editor-text))
          (for ([name '(#f "offset" "n" "偏移" "𝑛" "if" "a b" "42" "#;x y" "")]
                [expected '(#t #t #t #t #t #f #f #f #f #f)])
            (define policy
              (native-rename
               (hasheq 'stage 'rename 'text "shift" 'new-name name
                       'target (hasheq 'range '(0 . 5) 'names '() 'families '())) level))
            (check-equal? (hash-ref policy 'valid?) expected))
          (check-equal? (edits (workspace-rename sources file (hasheq 'line 2 'character 9) "offset") file)
                        (list (edit '(2 9) '(2 14) "offset") (edit '(2 45) '(2 50) "offset") (edit '(5 1) '(5 6) "offset")))
          (for ([new '("if" "n")])
            (check-exn exn:fail? (lambda () (workspace-rename sources file (hasheq 'line 2 'character 9) new))))
          (check-equal? (file->string file) editor-text)))))

  (test-case (format "~a workspace structure and field renames keep exact component edits" level)
    (with-files editor-text
      (lambda (file _root)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
          (define sources (hash file editor-text))
          (check-equal? (edits (workspace-rename sources file (hasheq 'line 1 'character 15) "coord") file)
                        (list (edit '(1 15) '(1 20) "coord") (edit '(3 21) '(3 26) "coord") (edit '(4 1) '(4 6) "coord")))
          (check-equal? (edits (workspace-rename sources file (hasheq 'line 1 'character 22) "u") file)
                        (list (edit '(1 22) '(1 23) "u") (edit '(4 7) '(4 8) "u")))))))

  (test-case (format "~a untitled rename requests saving in the workspace" level)
    (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
      (define doc (make-doc "untitled:teaching" editor-text))
      (check-true (doc-expand! doc))
      (check-exn #rx"Save the file in the workspace" (lambda () (doc-prepare-rename doc (Pos 2 9))))
      (check-exn #rx"Save the file in the workspace" (lambda () (doc-rename doc "untitled:teaching" (Pos 2 9) "offset")))))

  (test-case (format "~a Variables and native watches preserve printing, grammar, errors and two existing checks" level)
    (with-adapter level
      (lambda (adapter)
        (with-session debug-text #:context #f #:adapter adapter #:entry #f #:test? #t #:timeout 90
          (lambda (file ask event seen)
            (define stopped (start file ask event (list (hasheq 'line 5))))
            (define frame (car (frames ask stopped)))
            (define rows (hash-ref (ask "variables" (hasheq 'variablesReference (locals ask frame))) 'variables))
            (check-equal? (hash-ref (findf (lambda (r) (equal? (hash-ref r 'name) "n")) rows) 'value) "2")
            (for ([context '("watch" "repl")])
              (for ([expression '("n" "(make-posn 1 2)" "sample" "(cons 1 (cons 2 empty))")]
                    [expected (list "2" "(make-posn 1 2)" "(make-point 3 4)"
                                    (if (eq? level 'bsl) "(cons 1 (cons 2 '()))" "(list 1 2)"))])
                (check-equal? (evaluate ask expression frame context) expected))
              (ask "evaluate" (hasheq 'expression "(" 'context context 'frameId (hash-ref frame 'id)) #f)
              (ask "evaluate" (hasheq 'expression "(posn-x 7)" 'context context 'frameId (hash-ref frame 'id)) #f)
              (check-regexp-match #rx"posn-x: expects a posn, given 7" (hash-ref (car (unbox seen)) 'message))
              (if (memq level '(bsl bsl+ isl))
                  (ask "evaluate" (hasheq 'expression "(lambda (x) x)" 'context context 'frameId (hash-ref frame 'id)) #f)
                  (check-regexp-match #rx"lambda|function" (evaluate ask "(lambda (x) x)" frame context)))
              (if (eq? level 'bsl)
                  (ask "evaluate" (hasheq 'expression "`(1 2)" 'context context 'frameId (hash-ref frame 'id)) #f)
                  (check-equal? (evaluate ask "`(1 2)" frame context) "(list 1 2)")))
            (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string file)) 'breakpoints '()))
            (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
            (define summary
              (let loop () (define e (event "racketdap/test"))
                (if (equal? (hash-ref e 'kind) "summary") e (loop))))
            (check-equal? summary (hasheq 'kind "summary" 'status "failed" 'total 2 'failed 1))
            (check-equal? (hash-ref (event "workerExit") 'exitCode) 1))))))

  (test-case (format "~a Run and Debug retain registered tests; Test and Debug Test retain located failure totals" level)
    (with-adapter level
      (lambda (adapter)
        (with-files debug-text
          (lambda (file _root)
            (for* ([instrument? '(#f #t)] [test? '(#f #t)])
              (define events '())
              (define tests #f)
              (parameterize ([current-output-port (open-output-nowhere)])
                (run-module file #:instrument? instrument? #:test? test? #:language-adapter adapter
                            #:on-test-event (lambda (e) (set! events (cons e events)))
                            #:on-ready (and (not test?)
                                            (lambda (ns)
                                              (parameterize ([current-namespace ns])
                                                (define obj ((dynamic-require 'test-engine/test-engine 'current-test-object)))
                                                (set! tests (length ((dynamic-require 'test-engine/test-engine 'test-object-tests) obj))))))))
              (if test?
                  (let ([failed (findf (lambda (e) (equal? (hash-ref e 'kind) "failure")) events)])
                    (check-not-false (member (hasheq 'kind "summary" 'status "failed" 'total 2 'failed 1) events))
                    (check-equal? (hash-ref (hash-ref failed 'location) 'position) (+ 103 (string-length (symbol->string level)))))
                  (check-equal? tests 2)))))))))

(define (accept-cached level)
  (test-case (format "~a compiled debugger replay keeps native expressions, previews and registered checks" level)
    (define text
      (string-append (format "#lang htdp/~a\n" level)
                     "(define (shift n)\n  (+ n 1))\n"
                     "(check-expect 1 2)\n(check-expect (shift 2) 3)\n(shift 2)\n"))
    (with-adapter level
      (lambda (adapter)
        (define sites '())
        (with-session text #:context #f #:adapter adapter #:entry #f #:timeout 90
          #:cache-directory 'project
          #:on-sites (lambda (added) (set! sites (append sites added)))
          #:setup
          (lambda (directory)
            (define failure #f)
            (thread-wait
             (thread
              (lambda ()
                (with-handlers ([exn:fail? (lambda (e) (set! failure e))])
                  (parameterize ([current-output-port (open-output-nowhere)])
                    (run-module (build-path directory "program.rkt") #:entry #f
                                #:on-ready
                                (lambda (ns)
                                  (parameterize ([current-namespace ns])
                                    (define obj ((dynamic-require 'test-engine/test-engine 'current-test-object)))
                                    (check-equal? (length ((dynamic-require 'test-engine/test-engine 'test-object-tests) obj)) 2)))
                                #:source-roots (list directory) #:cache-directory (build-path directory "cache")
                                #:language-adapter adapter))))))
            (when failure (raise failure)))
          (lambda (file ask event seen)
            (define stopped (start file ask event (list (hasheq 'line 3))))
            (define frame (car (frames ask stopped)))
            (check-equal? (evaluate ask "(+ n 3)" frame) "5")
            (check-equal? (evaluate ask "(make-posn 1 2)" frame) "(make-posn 1 2)")
            (check-not-equal? sites '())
            (check-true (andmap (lambda (site) (not (site-expression site))) sites))
            (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string file)) 'breakpoints '()))
            (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
            (check-equal? (hash-ref (event "workerExit") 'exitCode) 0)))))))

(define (accept-imports level)
  (test-case (format "~a completion keeps current phase-zero imported exports without running dependency bodies" level)
    (define text (format "#lang htdp/~a\n(require \"library.rkt\")\n(define value 1)\n" level))
    (with-files text
      (lambda (file root)
        (define marker (build-path root "executed"))
        (define library (build-path root "library.rkt"))
        (define (write-library name)
          (display-to-file
           (format
            (string-append "#lang racket/base\n(require (for-syntax racket/base))\n"
                           "(provide ~a (for-syntax phase-only))\n(define-for-syntax phase-only 99)\n"
                           "(define (~a x) (* 3 x))\n"
                           "(call-with-output-file ~s (lambda (out) (display 1 out)) #:exists 'append)\n"
                           "(error 'library \"Runtime body executed\")\n")
            name name (path->string marker)) library #:exists 'truncate))
        (write-library 'triple)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))]
                       [current-completion-position (sub1 (string-length text))])
          (define doc (analyse file text #f))
          (define (labels)
            (map CompletionItem-label
                 (CompletionList-items (doc-completion doc (doc-abs-pos->pos doc (sub1 (string-length text)))))))
          (check-not-false (member "triple" (labels)))
          (check-false (member "phase-only" (labels)))
          (check-false (file-exists? marker))
          (write-library 'scaled)
          (check-true (doc-expand! doc))
          (check-not-false (member "scaled" (labels)))
          (check-false (member "triple" (labels)))
          (check-false (file-exists? marker)))))))

(define (accept-local level)
  (define text
    (string-append (format "#lang htdp/~a\n" level)
                   "(define (outer n)\n"
                   "  (local [(define (shift x) (+ x n))\n"
                   "          (define (bump x)\n"
                   "            (local [(define hidden 1)]\n"
                   "              (+ (shift x) hidden)))]\n"
                   "    (bump 3)))\n(outer 2)\n"))
  (test-case (format "~a nested declarations, signatures and completion keep local scopes" level)
    (with-files text
      (lambda (file _root)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
          (define doc (analyse file text #f))
          (define outer (car (doc-symbols-hierarchical doc)))
          (check-equal? (DocumentSymbol-name outer) "outer")
          (check-equal? (map DocumentSymbol-name (DocumentSymbol-children outer)) '("shift" "bump"))
          (check-equal? (map DocumentSymbol-kind (DocumentSymbol-children outer)) (list SymbolKind-Function SymbolKind-Function))
          (check-equal? (map DocumentSymbol-name (DocumentSymbol-children (cadr (DocumentSymbol-children outer)))) '("hidden"))
          (define (labels line column)
            (parameterize ([current-completion-position (doc-pos->abs-pos doc (Pos line column))])
              (check-true (doc-expand! doc)))
            (map CompletionItem-label (CompletionList-items (doc-completion doc (Pos line column)))))
          (for ([name '("shift" "bump" "n")]) (check-not-false (member name (labels 6 4))))
          (check-false (member "hidden" (labels 6 4)))
          (for ([name '("shift" "bump" "hidden" "n")]) (check-false (member name (labels 7 1))))
          (define help (doc-signature-help doc (Pos 6 10)))
          (check-not-false help)
          (check-equal? (SignatureInformation-label (car (SignatureHelp-signatures help))) "(bump x)")))))
  (test-case (format "~a redirected local function rename keeps scoped uses and rejects capture" level)
    (with-files text
      (lambda (file _root)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
          (check-equal? (edits (workspace-rename (hash file text) file (hasheq 'line 2 'character 19) "offset") file)
                        (list (edit '(2 19) '(2 24) "offset") (edit '(5 18) '(5 23) "offset")))
          (check-exn exn:fail? (lambda () (workspace-rename (hash file text) file (hasheq 'line 2 'character 19) "x")))
          (check-equal? (file->string file) text)))))
  (test-case (format "~a Variables and watches expose shift, bump and captured n through storage" level)
    (with-adapter level
      (lambda (adapter)
        (with-session text #:context #f #:adapter adapter #:entry #f #:timeout 90
          (lambda (file ask event seen)
            (define stopped (start file ask event (list (hasheq 'line 7))))
            (define frame (car (frames ask stopped)))
            (define rows (hash-ref (ask "variables" (hasheq 'variablesReference (locals ask frame))) 'variables))
            (define names (map (lambda (row) (hash-ref row 'name)) rows))
            (for ([name '("shift" "bump" "n")]) (check-not-false (member name names)))
            (check-false (member "hidden" names))
            (for ([context '("watch" "repl")])
              (check-equal? (evaluate ask "(shift 4)" frame context) "6")
              (check-equal? (evaluate ask "(bump 4)" frame context) "7")
              (check-equal? (evaluate ask "n" frame context) "2")
              (case level
                [(isl) (check-equal? (evaluate ask "shift" frame context) "function:shift")]
                [else (check-equal? (evaluate ask "shift" frame context) "shift")]))
            (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string file)) 'breakpoints '()))
            (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
            (check-equal? (hash-ref (event "workerExit") 'exitCode) 0)))))))

(define-runtime-path navigation-worker "../vscode/workspace-analysis-worker.rkt")
(dynamic-require navigation-worker #f)
(define navigation-answer
  (parameterize ([current-namespace (module->namespace navigation-worker)]) (eval 'answer)))
(define (navigation file text operation line column)
  (define uri (source-uri (path->source file)))
  (define result
    (navigation-answer
     (list 'analyse file 1048576 text
           (list operation uri (hasheq 'line line 'character column) #t (hash) (path-only file))
           (hash) (list (path-only file)) (hash)) void))
  (check-equal? (car result) 'ok (format "~s" result))
  (if (eq? operation 'references) (caadr result) (cadr result)))
(define (written-range line start end)
  (hasheq 'start (hasheq 'line line 'character start) 'end (hasheq 'line line 'character end)))

(define (accept-structure level)
  (test-case (format "~a local structure components keep exact anchors and distinct outer owners" level)
    (define text
      (string-append (format "#lang htdp/~a\n" level)
                     "(define-struct point (x))\n"
                     "(define (outer n)\n"
                     "  (local [(define-struct point (x))\n"
                     "          (define p (make-point n))]\n"
                     "    (point-x p)))\n(outer 3)\n(point-x (make-point 1))\n"))
    (with-files text
      (lambda (file _root)
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor level)))])
          (define uri (source-uri (path->source file)))
          (check-equal? (navigation file text 'definition 5 11)
                        (list (hasheq 'uri uri 'range (written-range 3 32 33))))
          (check-equal? (navigation file text 'definition 7 7)
                        (list (hasheq 'uri uri 'range (written-range 1 22 23))))
          (define local-ranges (list (written-range 3 32 33) (written-range 5 11 12)))
          (check-equal? (navigation file text 'highlights 5 11)
                        (map (lambda (r) (hasheq 'range r)) local-ranges))
          (check-equal? (navigation file text 'references 5 11)
                        (map (lambda (r) (hasheq 'uri uri 'range r)) local-ranges))
          (check-equal? (edits (workspace-rename (hash file text) file (hasheq 'line 3 'character 25) "coord") file)
                        (list (edit '(3 25) '(3 30) "coord") (edit '(4 26) '(4 31) "coord") (edit '(5 5) '(5 10) "coord")))
          (check-equal? (edits (workspace-rename (hash file text) file (hasheq 'line 3 'character 32) "u") file)
                        (list (edit '(3 32) '(3 33) "u") (edit '(5 11) '(5 12) "u")))
          (check-equal? (file->string file) text))))))

(define (accept-setters)
  (test-case "asl local setters and distinct fields retain exact scoped anchors and edits"
    (define text
      (string-append "#lang htdp/asl\n(define (outer n)\n"
                     "  (local [(define-struct point (x y))\n"
                     "          (define p (make-point n 0))]\n"
                     "    (begin (set-point-x! p 4) (+ (point-x p) (point-y p)))))\n(outer 3)\n"))
    (with-files text
      (lambda (file _root)
        (define uri (source-uri (path->source file)))
        (for ([column '(22 40 52)] [field '(32 32 34)])
          (check-equal? (navigation file text 'definition 4 column)
                        (list (hasheq 'uri uri 'range (written-range 2 field (add1 field))))))
        (parameterize ([current-language-adapter-resolver (lambda args (validate-language-profile (descriptor 'asl)))])
          (check-equal? (edits (workspace-rename (hash file text) file (hasheq 'line 2 'character 32) "u") file)
                        (list (edit '(2 32) '(2 33) "u") (edit '(4 22) '(4 23) "u")
                              (edit '(4 40) '(4 41) "u"))))))))

(define (accept-state)
  (define text
    (string-append "#lang htdp/asl\n(define counter\n"
                   "  (local [(define state 10)\n"
                   "          (define (bump delta)\n"
                   "            (begin\n"
                   "              (set! state (+ state delta))\n"
                   "              state))]\n"
                   "    bump))\n(check-expect 1 2)\n(check-expect (counter 2) 12)\n"))
  (test-case "asl captured state stays live in Variables, assignments, watches and console without changing test results"
    (with-adapter 'asl
      (lambda (adapter)
        (with-session text #:context #f #:adapter adapter #:entry #f #:test? #t #:timeout 90
          (lambda (file ask event seen)
            (define stopped (start file ask event (list (hasheq 'line 6))))
            (define frame (car (frames ask stopped)))
            (define reference (locals ask frame))
            (define (state)
              (define rows (hash-ref (ask "variables" (hasheq 'variablesReference reference)) 'variables))
              (define row (findf (lambda (row) (equal? (hash-ref row 'name) "state")) rows))
              (check-not-false row (format "Captured state at ~s: ~s" frame rows))
              (hash-ref row 'value))
            (check-equal? (state) "10")
            (check-equal? (hash-ref (ask "setVariable" (hasheq 'variablesReference reference 'name "state" 'value "20")) 'value) "20")
            (check-equal? (state) "20")
            (for ([context '("watch" "repl")] [value '(30 40)])
              (evaluate ask (format "(set! state ~a)" value) frame context)
              (check-equal? (state) (number->string value))
              (check-equal? (evaluate ask "state" frame context) (number->string value))
              (ask "evaluate" (hasheq 'expression "(posn-x 7)" 'context context 'frameId (hash-ref frame 'id)) #f))
            (ask "setVariable" (hasheq 'variablesReference reference 'name "state" 'value "10"))
            (ask "setBreakpoints" (hasheq 'source (hasheq 'path (path->string file)) 'breakpoints '()))
            (ask "continue" (hasheq 'threadId (hash-ref stopped 'threadId)))
            (define summary
              (let loop () (define e (event "racketdap/test"))
                (if (equal? (hash-ref e 'kind) "summary") e (loop))))
            (check-equal? summary (hasheq 'kind "summary" 'status "failed" 'total 2 'failed 1))
            (check-equal? (hash-ref (event "workerExit") 'exitCode) 1)))))))

(define (accept-refined-anchors)
  (test-case "confirmed provider definitions refine only containing anchors of the same scoped owner"
    (define text "#lang racket/base\n(define (f whole-field) whole-field)\n")
    (with-files text
      (lambda (file _root)
        (for ([certainty '(confirmed predicted)] [expected '(((35 . 40)) ((29 . 40)))])
          (define (provider request)
            (define definition
              (findf (lambda (n) (and (eq? (hash-ref n 'role) 'definition)
                                      (eq? (syntax-e (hash-ref n 'identifier)) 'whole-field)))
                     (hash-ref (hash-ref request 'facts) 'names)))
            (hasheq 'names (list (hash-set* definition 'range '(35 . 40) 'certainty certainty))))
          (parameterize ([current-extra-service-factories
                          (hasheq 'bindings (bindings-factory provider))])
            (define doc (make-doc (source-uri (path->source file)) text))
            (define result (doc-check-syntax doc))
            (check-true (CSResult-succeed? result))
            (define service (send (CSResult-trace result) get-extra-service 'bindings))
            (check-equal? (send service definition-ranges-at 43) expected)))))))

(define (accept-component-safety level)
  (for* ([local? (if (memq level '(isl isl+ asl)) '(#f #t) '(#f))]
         [column (if local? '(25 32) '(15 22))])
    (test-case (format "~a ~a same-spelling ~a component refuses" level
                       (if local? "local" "module")
                       (if (= column (if local? 25 15)) "type" "field"))
      (define text
        (string-append (format "#lang htdp/~a\n" level)
                       (if local? "(define (f n)\n  (local [" "")
                       "(define-struct point (point))\n"
                       (if local? "          (define p (make-point n))]\n    (point-point p)))\n(f 1)\n"
                           "(define p (make-point 1))\n(point-point p)\n")))
      (with-files text
        (lambda (file _root)
          (analyse file text #f)
          (check-exn #rx"Cannot distinguish.*component"
                     (lambda () (workspace-rename (hash file text) file
                                 (hasheq 'line (if local? 2 1) 'character column) "coord")))
          (check-equal? (file->string file) text)))))
  (test-case (format "~a component edits keep equally spelt functions and variables separate" level)
    (for ([function? '(#f #t)])
      (define text
        (string-append (format "#lang htdp/~a\n" level)
                       "(define-struct point (x))\n"
                       (if function? "(define (x n) (+ n 1))\n(define p (make-point (x 2)))\n(point-x p)\n(x 3)\n"
                           "(define x 2)\n(define p (make-point x))\n(point-x p)\nx\n")))
      (with-files text
        (lambda (file _root)
          (check-equal? (edits (workspace-rename (hash file text) file (hasheq 'line 1 'character 22) "u") file)
                        (list (edit '(1 22) '(1 23) "u") (edit '(4 7) '(4 8) "u")))
          (check-equal? (edits (workspace-rename (hash file text) file
                               (hasheq 'line 2 'character (if function? 9 8)) "v") file)
                        (if function?
                            (list (edit '(2 9) '(2 10) "v") (edit '(3 23) '(3 24) "v") (edit '(5 1) '(5 2) "v"))
                            (list (edit '(2 8) '(2 9) "v") (edit '(3 22) '(3 23) "v") (edit '(5 0) '(5 1) "v")))))))
    (with-files (format "#lang htdp/~a\n(define-struct point (make-point))\n(define p (make-point 1))\n(point-make-point p)\n" level)
      (lambda (file _root)
        (define text (file->string file))
        (analyse file text #f)
        (check-exn exn:fail? (lambda () (workspace-rename (hash file text) file (hasheq 'line 1 'character 22) "u")))))
    (with-files (format "#lang htdp/~a\n(define-struct point (x x))\n" level)
      (lambda (file _root)
        (check-false (doc-expand! (make-doc (source-uri (path->source file)) (file->string file))))))))

(define (accept-assignment-components)
  (test-case "asl assignment keeps equally spelt fields and mutable variables separate"
    (for ([local? '(#f #t)])
      (define text
        (string-append "#lang htdp/asl\n"
                       (if local? "(define (f n)\n  (local [" "")
                       "(define-struct point (state))\n"
                       "(define state 1)\n(define p (make-point state))"
                       (if local? "]\n    (begin (set! state 2) (+ state (point-state p)))))\n(f 1)\n"
                           "\n(set! state 2)\n(+ state (point-state p))\n")))
      (with-files text
        (lambda (file _root)
          (analyse file text #f)
          (check-exn exn:fail?
                     (lambda () (workspace-rename (hash file text) file
                                 (hasheq 'line (if local? 2 1) 'character (if local? 32 22)) "u")))
          (check-equal?
           (edits (workspace-rename (hash file text) file
                    (hasheq 'line (if local? 3 2) 'character 8) "v") file)
           (if local?
               (list (edit '(3 8) '(3 13) "v") (edit '(4 22) '(4 27) "v")
                     (edit '(5 17) '(5 22) "v") (edit '(5 29) '(5 34) "v"))
               (list (edit '(2 8) '(2 13) "v") (edit '(3 22) '(3 27) "v")
                     (edit '(4 6) '(4 11) "v") (edit '(5 3) '(5 8) "v")))))))))

(define (accept-lambda-signatures level)
  (for ([local? (if (memq level '(isl isl+ asl)) '(#f #t) '(#f))])
    (test-case (format "~a ~a lambda definitions retain source signatures" level (if local? "local" "module"))
      (define text
        (string-append (format "#lang htdp/~a\n" level)
                       (if local?
                           "(define (outer n)\n  (local [(define f (lambda (x y) (+ x y n)))]\n    (f 1 2)))\n(outer 3)\n"
                           "(define f (lambda (x y) (+ x y)))\n(f 1 2)\n")))
      (with-files text
        (lambda (file _root)
          (define doc (analyse file text #f))
          (define outline (car (doc-symbols-hierarchical doc)))
          (define f (if local? (car (DocumentSymbol-children outline)) outline))
          (check-equal? (DocumentSymbol-name f) "f")
          (check-equal? (DocumentSymbol-kind f) SymbolKind-Function)
          (define help (doc-signature-help doc (if local? (Pos 3 9) (Pos 2 5))))
          (check-not-false help)
          (define signature (car (SignatureHelp-signatures help)))
          (check-equal? (SignatureInformation-label signature) "(f x y)")
          (check-equal? (map ParameterInformation-label (SignatureInformation-parameters signature)) '("x" "y"))
          (check-equal? (SignatureHelp-activeParameter help) 1))))))

(module+ test
  (accept-refined-anchors)
  (for ([level '(bsl isl+ asl bsl+ isl)]) (accept-level level) (accept-cached level) (accept-imports level)
    (accept-component-safety level) (accept-lambda-signatures level))
  (for ([level '(isl+ asl isl)]) (accept-local level) (accept-structure level))
  (accept-state)
  (accept-assignment-components)
  (accept-setters))
