#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Macro steps session tests.
(require racket/class
         macro-debugger/model/steps
         json
         racket/list
         racket/string
         rackunit
         (only-in "../racketdap/tools/macro-source.rkt" call-with-macro-source)
         (only-in "../racketdap/tools/macro-steps/printing.rkt" new-foreground-partition)
         (only-in "../racketdap/tools/macro-steps/facts.rkt" current-inspection-observer)
         (only-in "../racketdap/tools/macro-steps/expansion.rkt" expansion-steps)
         (only-in "../racketdap/tools/macro-steps/answer.rkt" decode-term [expansion-answer
                  compact-expansion-answer])
         (only-in "../racketdap/tools/macro-steps/limits.rkt" call-with-memory-limit answer-text)
         (only-in "support/macro-stepper.rkt" request steps-of sample text-of without-name-suffixes
                  transformer-error-program snapshot-of view-of term-of utf16-slice appearance-text))

(module+ test
  (test-case "display history persists across navigation and reset redraws current terms in order"
    (define first ((make-syntax-introducer) (datum->syntax #f 'first)))
    (define second ((make-syntax-introducer) (datum->syntax #f 'second)))
    (define (state-of term) (state term null null null (hasheq) (hasheq) (hasheq) 0))
    (define query #f)
    (define summary
      (compact-expansion-answer (list (step 'macro (state-of first) (state-of second)))
                                (hasheq) (hasheq) second #f first 'null null
                                #:retain-inspector (lambda (q) (set! query q))))
    (define (at position) (query (hasheq 'mode "position" 'position position)))
    (define end (at 2))
    (define begin (at 1))
    (check-equal? (hash-ref (car (hash-ref (hash-ref end 'final) 'occurrences)) 'macroScopeGroup) 1)
    (check-equal? (hash-ref (car (hash-ref (hash-ref (hash-ref begin 'record) 'before) 'occurrences)) 'macroScopeGroup) 2)
    (check-equal? (hash-ref (at 2) 'final) (hash-ref end 'final))
    (query (hasheq 'mode "configure" 'grouping "macro"))
    (define reset (at 1))
    (check-equal? (hash-ref (car (hash-ref (hash-ref (hash-ref reset 'record) 'before) 'occurrences)) 'macroScopeGroup) 1)
    (check-equal? (hash-ref (car (hash-ref (hash-ref (hash-ref reset 'record) 'after) 'occurrences)) 'macroScopeGroup) 2))

  (test-case "lazy display history follows requested positions, sides, and nearest-first contexts"
    (define (fresh name) ((make-syntax-introducer) (datum->syntax #f name)))
    (define a (fresh 'a))
    (define b (fresh 'b))
    (define c (fresh 'c))
    (define d (fresh 'd))
    (define e (fresh 'e))
    (define near (fresh 'near))
    (define far (fresh 'far))
    (define frames (list (bigframe null (list near) near) (bigframe null (list far) far)))
    (define (state-of term [contexts null]) (state term (list term) null contexts (hasheq) (hasheq) (hasheq) 0))
    (define reductions (list (step 'macro (state-of a frames) (state-of b frames))
                             (step 'macro (state-of c) (state-of d))
                             (step 'rename-lambda (state-of d) (state-of e))))
    (define (session)
      (define query #f)
      (define partition (new-foreground-partition))
      (define summary
        (compact-expansion-answer reductions (hasheq) (hasheq) e #f a 'null null
                                  #:partition partition
                                  #:retain-inspector (lambda (q) (set! query q))))
      (check-equal? (hash-ref summary 'nextGroup) 1)
      (values query partition))
    (define-values (forward partition) (session))
    (define first (forward (hasheq 'mode "position" 'position 1)))
    (for ([term (list a b near far)] [group (in-naturals 1)])
      (check-equal? (send partition get-partition term) group))
    (check-equal? (hash-ref first 'nextGroup) 5)
    (forward (hasheq 'mode "position" 'position 2))
    (check-equal? (send partition get-partition c) 5)
    (check-equal? (send partition get-partition d) 6)
    (define finish (forward (hasheq 'mode "position" 'position 3)))
    (check-equal? (send partition get-partition e) 7)
    (check-equal? (hash-ref (forward (hasheq 'mode "position" 'position 1)) 'record) (hash-ref first 'record))
    (check-equal? (hash-ref (forward (hasheq 'mode "position" 'position 3)) 'final) (hash-ref finish 'final))
    (define-values (jump jump-partition) (session))
    (jump (hasheq 'mode "position" 'position 1))
    (define jumped (jump (hasheq 'mode "position" 'position 3 'panes #t)))
    (check-equal? (hash-ref jumped 'nextGroup) 6)
    (check-equal? (send jump-partition get-partition e) 5)
    (check-equal? (hash-ref jumped 'terminalBefore) 'null)
    (jump (hasheq 'mode "position" 'position 2))
    (check-equal? (send jump-partition get-partition c) 6)
    (check-equal? (send jump-partition get-partition d) 7))

  (test-case "a small all-macros expansion crosses the palette boundary in both schemas"
    (define program
      "#lang racket/base\n(define-syntax-rule (literal) 'a)\n(define result (literal))\n(list result)\n")
    (define eager (steps-of program #:hiding "none"))
    (define lazy (view-of program #:hiding "none"))
    (define (normalized text) (regexp-replace* #px":[0-9]+" text ":N"))
    (define final (hash-ref (hash-ref lazy 'final) 'text))
    ;; The worked examples apply per occurrence: late define-values, #%app,
    ;; quote and quoted a are suffixed; earlier let-values and source result
    ;; remain unsuffixed even in a term containing overflow groups.
    (check-regexp-match #px"define-values:N \\(result\\) \\(quote:N a:N\\)" (normalized final))
    (check-regexp-match #px"#%app:N" (normalized final))
    (check-regexp-match #px"let-values \\(" final)
    (check-false (regexp-match? #px"result:[0-9]+" final))
    (check-false (regexp-match? #px"let-values:[0-9]+" final))
    (check-equal? final (hash-ref eager 'final))
    (for ([early (in-list (hash-ref eager 'steps))] [late (in-list (hash-ref lazy 'steps))])
      (for ([side '(before after)])
        (check-equal? (text-of late side) (text-of early side))))
    (check-true (for/or ([occurrence (in-list (hash-ref (hash-ref lazy 'final) 'occurrences))])
                  (> (hash-ref occurrence 'macroScopeGroup) 17))))

  (test-case "jumping to completion numbers only the finished term"
    (define first ((make-syntax-introducer) (datum->syntax #f 'first)))
    (define second ((make-syntax-introducer) (datum->syntax #f 'second)))
    (define (state-of term) (state term null null null (hasheq) (hasheq) (hasheq) 0))
    (define query #f)
    (compact-expansion-answer (list (step 'macro (state-of first) (state-of second)))
                              (hasheq) (hasheq) second #f first 'null null
                              #:retain-inspector (lambda (q) (set! query q)))
    (define answer (query (hasheq 'mode "position" 'position 2 'panes #t)))
    (define (group key) (hash-ref (car (hash-ref (hash-ref answer key) 'occurrences)) 'macroScopeGroup))
    (check-equal? (hash-ref answer 'terminalBefore) 'null)
    (check-equal? (group 'final) 1)
    (check-equal? (hash-ref answer 'nextGroup) 2)
    (define beginning (query (hasheq 'mode "position" 'position 1 'panes #t)))
    (check-equal? (hash-ref (car (hash-ref (hash-ref (hash-ref beginning 'record) 'before) 'occurrences))
                            'macroScopeGroup) 2)
    (define completed (query (hasheq 'mode "position" 'position 2 'panes #t)))
    (check-equal? (hash-ref completed 'final) (hash-ref answer 'final))
    (check-equal? (hash-ref (car (hash-ref (hash-ref completed 'terminalBefore) 'occurrences))
                            'macroScopeGroup) 2))

  (test-case "schema 2 retains whole rewrites, final inspection and source provenance"
    (define answer (view-of sample))
    (check-equal? (hash-ref answer 'schemaVersion) 2)
    (check-equal? (hash-ref answer 'snapshot) (snapshot-of sample))
    (check-equal? (hash-ref answer 'relationPhase) 0)
    (check-equal? (map (lambda (s) (hash-ref s 'macro)) (hash-ref answer 'steps)) '("guard" "swap!"))
    (check-equal? (hash-ref answer 'error) 'null)
    (define final (hash-ref answer 'final))
    (check-true (pair? (hash-ref final 'occurrences)))
    (check-true (pair? (hash-ref final 'edges)))
    (for ([source (in-hash-values (hash-ref answer 'sources))])
      (when (equal? (hash-ref source 'kind) "untitled")
        (check-equal? (hash-ref source 'fingerprint) (hash-ref (snapshot-of sample) 'sourceHash))))
    (define first (car (hash-ref answer 'steps)))
    (check-equal? (hash-ref first 'kind) "rewrite")
    (check-equal? (hash-ref first 'eventKey) 'null)
    (check-equal? (hash-ref (hash-ref first 'source) 'position) 170)
    (check-equal? (length (hash-ref first 'sourceFoci)) 1)
    (check-not-false (member "interactive-final" (hash-ref answer 'capabilities))))

  (test-case "zero rewrites still have an interactive policy-dependent final"
    (define answer (view-of "#lang racket/base\n(or #f 1)\n"))
    (check-equal? (hash-ref answer 'steps) null)
    (check-regexp-match #rx"or" (hash-ref (hash-ref answer 'final) 'text))
    (check-true (pair? (hash-ref (hash-ref answer 'final) 'occurrences))))

  (for ([version '(1 2)])
    (test-case (format "schema ~a finished quotes and suffixes match the window text" version)
      (define program
        (string-append "#lang racket/base\n"
                       "(define-syntax-rule (q1) 'a)\n"
                       "(define-syntax-rule (q2) (quote b))\n"
                       "(define x1 'c)\n(define x2 (quote d))\n(define x3 5)\n"
                       "(list (q1) (q2))\n"))
      (call-with-macro-source
       (request program #:mode "module")
       (lambda (stx)
         (define query #f)
         (define answer (expansion-steps stx "none" #:schema-version version
                                         #:retain-inspector (lambda (q) (set! query q))))
         (define reply (and (= version 2)
                            (query (hasheq 'mode "position" 'position (add1 (hash-ref answer 'stepCount))))))
         (define final (if reply (hash-ref reply 'final) (hash-ref answer 'final)))
         (define text (regexp-replace* #px"\\s+" (if reply (hash-ref final 'text) final) " "))
         ;; Numbers depend on partition visitation; presence follows the window.
         (for ([expected (list #px"\\(define-values:[0-9]+ \\(x1\\) 'c\\)"
                               #px"\\(define-values:[0-9]+ \\(x2\\) \\(quote d\\)\\)"
                               #px"\\(define-values:[0-9]+ \\(x3\\) \\(quote 5\\)\\)"
                               #px"\\(#%app:[0-9]+ list \\(quote:[0-9]+ a:[0-9]+\\) \\(quote:[0-9]+ b:[0-9]+\\)\\)"
                               #px"\\(module configure-runtime '#%kernel"
                               #px"'syntax/loc" #px"'\\(\\)")])
           (check-regexp-match expected text))
         (when reply
           (for ([o (hash-ref final 'occurrences)])
             (define term (hash-ref (hash-ref reply 'terms) (string->symbol (hash-ref o 'syntaxId))))
             (when (equal? (hash-ref term 'kind) "identifier")
               (check-equal? (appearance-text final o) (hash-ref term 'name))
               (define group (hash-ref o 'macroScopeGroup))
               (define after (substring (hash-ref final 'text) (cadr (hash-ref o 'range))))
               (when (regexp-match? #px"^:[0-9]+" after)
                 (check-true (positive? group))
                 (check-true (string-prefix? after (format ":~a" group)))))))))))

  (test-case "lazy error summary requests a selectable error position and inspection"
    (define query #f)
    (define summary
      (call-with-macro-source (request transformer-error-program #:mode "module")
        (lambda (stx) (expansion-steps stx "none" #:schema-version 2
                                       #:retain-inspector (lambda (q) (set! query q))))))
    (check-false (hash-ref summary 'final))
    (check-equal? (hash-ref (last (hash-ref summary 'steps)) 'kind) "error")
    (define position (hash-ref summary 'stepCount))
    (define error-position (query (hasheq 'mode "position" 'position position)))
    (check-equal? (hash-ref error-position 'error) (hash-ref summary 'error))
    (check-equal? (hash-ref (hash-ref error-position 'record) 'after) 'null)
    (define tid (car (hash-keys (hash-ref error-position 'terms))))
    (check-equal? (hash-ref (query (hasheq 'mode "inspect" 'position position 'term (symbol->string tid))) 'mode) "inspect"))

  (test-case "error diagnostic retains failing syntax and nearest-first transformer contexts"
    (define answer (view-of transformer-error-program #:hiding "none"))
    (check-equal? (hash-ref answer 'final) 'null)
    (define stopped (last (hash-ref answer 'steps)))
    (check-equal? (hash-ref stopped 'kind) "error")
    (check-equal? (hash-ref stopped 'after) 'null)
    (check-equal? (hash-ref stopped 'error) (hash-ref answer 'error))
    (define diagnostic (hash-ref (hash-ref answer 'diagnostics) (string->symbol (hash-ref answer 'error))))
    (check-equal? (hash-ref diagnostic 'program) (hash-ref stopped 'before))
    (check-equal? (hash-ref diagnostic 'contexts) (hash-ref stopped 'contexts))
    (check-true (pair? (hash-ref diagnostic 'syntax)))
    (define focused
      (map (lambda (c) (define s (hash-ref c 'section))
             (map (lambda (r) (without-name-suffixes (utf16-slice (hash-ref s 'text) r))) (hash-ref s 'focus)))
           (hash-ref diagnostic 'contexts)))
    (check-equal? (take focused 3) '(("(bad)") ("(middle)") ("(outer)"))))

  (test-case "lazy count, position and compact inspection preserve defaults and all facts"
    (define original (syntax-property (datum->syntax #f '(x 1)) 'fixture '(hello 42)))
    (define facts (make-hash))
    (define query #f)
    (parameterize ([current-inspection-observer (lambda (tid record) (hash-set! facts tid record))])
      (define answer
        (compact-expansion-answer null (hasheq) (hasheq) original #f original 'null null
                                  #:retain-inspector (lambda (q) (set! query q))))
      (check-equal? (hash-ref answer 'mode) "summary")
      (check-equal? (hash-ref answer 'stepCount) 0)
      (check-true (hash-ref answer 'final))
      (check-false (hash-has-key? answer 'terms))
      (check-equal? (hash-count facts) 0)
      (define position (query (hasheq 'mode "position" 'position 1)))
      (check-equal? (hash-count facts) 0)
      (define tid (hash-ref (car (hash-ref (hash-ref position 'final) 'occurrences)) 'syntaxId))
      (define inspection (query (hasheq 'mode "inspect" 'position 1 'term tid)))
      (define shared (hash-ref inspection 'shared))
      (define decoded (decode-term shared (hash-ref inspection 'termData)))
      (check-equal? (hash-count facts) 1)
      (check-equal? decoded (hash-ref facts tid))
      (check-equal? (hash-ref decoded 'inspectedPhases) '(0))
      (check-equal? (length shared) (length (remove-duplicates shared)))
      (define more (query (hasheq 'mode "inspect" 'position 1 'term tid 'phases '(1 -1 "label" 8))))
      (define extra (decode-term (hash-ref more 'shared) (hash-ref more 'termData)))
      (check-equal? (hash-ref extra 'inspectedPhases) '(1 -1 "label" 8))
      (check-equal? (map (lambda (scope) (hash-ref scope 'phase)) (hash-ref extra 'scopes)) '(1 -1 "label" 8))
      (check-equal? (hash-ref extra 'properties) (hash-ref decoded 'properties))
      (check-exn exn:fail? (lambda () (query (hasheq 'mode "position" 'position 2))))
      (for ([bad (list (hasheq 'term "unknown") (hasheq 'term tid 'phases '("invalid"))
                       (hasheq 'term tid 'phases (make-list 257 0)))])
        (check-exn exn:fail? (lambda () (query (hash-set* bad 'mode "inspect" 'position 1))))))
    ;; Literal/compound inspection inherits an actual phase transition even
    ;; when there is no binder/use phase on that occurrence.
    (define phase-answer
      (view-of "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (define phase-value 42))\n" #:hiding "none"))
    (define phase-final (hash-ref phase-answer 'final))
    (define literal
      (findf (lambda (o) (equal? (appearance-text phase-final o) "42")) (hash-ref phase-final 'occurrences)))
    (check-not-false literal)
    (check-not-false (member 1 (hash-ref (term-of phase-answer literal) 'inspectedPhases))))

  (test-case "answer writer stops at the byte ceiling before inspecting the remaining answer"
    ;; An invalid JSON tail is never visited once the text exceeds the budget.
    (define answer (string->jsexpr (answer-text (list (make-string 2000 #\λ) (lambda () 1)) 100)))
    (check-equal? (hash-ref answer 'failureCode) "answer-size")
    (define invalid (string->jsexpr (answer-text (lambda () 1))))
    (check-equal? (hash-ref invalid 'failureCode) "serialization"))

  (test-case "a memory limit returns small results and stops retained allocations"
    (define mb (* 1024 1024))
    (check-equal? (call-with-memory-limit (* 20 mb) (lambda () 42)) 42)
    (check-exn #rx"work failed"
               (lambda () (call-with-memory-limit (* 20 mb) (lambda () (error "work failed")))))
    ;; The debugger keeps an instrumented program's values where the limit does not count them, so
    ;; this runs uninstrumented, as an expansion does when this file itself is being debugged.
    (define namespace (make-base-namespace))
    (check-false
     (call-with-memory-limit
      (* 20 mb)
      (lambda ()
        (eval '(let loop ([held '()] [left 100])
                 (cond [(zero? left) (length held)]
                       [else (collect-garbage)
                             (loop (cons (make-bytes 1048576) held) (sub1 left))]))
              namespace)))))

  (test-case "work that ends its own thread is not a memory limit"
    (check-exn #rx"^The expansion stopped before it finished[.]$"
               (lambda ()
                 (call-with-memory-limit (* 20 1024 1024)
                                         (lambda () (kill-thread (current-thread)))))))

  (test-case "answer text is JSON within the limit and a failure above it"
    (define result (hasheq 'final "λ"))
    (define size (string-utf-8-length (jsexpr->string result)))
    (check-equal? (answer-text result size) (jsexpr->string result))
    (check-equal? (string->jsexpr (answer-text result (sub1 size)))
                  (hasheq 'failed "These macro steps are too long to show." 'failureCode "answer-size")))
)
