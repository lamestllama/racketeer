#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Macro steps facts tests.
(require racket/promise
         macro-debugger/model/hiding-policies
         macro-debugger/model/trace
         macro-debugger/model/reductions
         macro-debugger/model/reductions-util
         macro-debugger/model/steps
         racket/shared
         racket/list
         racket/string
         rackunit
         (only-in "../racketdap/tools/macro-source.rkt" call-with-macro-source)
         (only-in "../racketdap/tools/macro-steps/facts.rkt" display-value module-relocations default-phases)
         (only-in "../racketdap/tools/macro-steps/expansion.rkt" expansion-steps)
         (only-in "../racketdap/tools/macro-steps/answer.rkt" decode-term)
         (only-in "support/macro-stepper.rkt" request steps-of sample focused-text without-name-suffixes
                  model-fixture syntax-objects model-program final-binding-program try-program
                  known-use-program transformer-error-program expansion-answer view-of term-of utf16-slice
                  appearance-text term-named))

(module+ test
  (define (check-final-result-binding hiding)
    (define answer (view-of final-binding-program #:hiding hiding))
    (define final (hash-ref answer 'final))
    (define results (term-named answer final "result"))
    (check-equal? (length results) 2)
    (define binder (car results))
    (define use (cadr results))
    (check-not-false
     (findf (lambda (edge)
              (and (equal? (hash-ref edge 'binder) (hash-ref binder 'id))
                   (equal? (hash-ref edge 'reference) (hash-ref use 'id))
                   (equal? (hash-ref edge 'phase) 0)))
            (hash-ref final 'edges)))
    (check-not-false (member (hash-ref binder 'id) (hash-ref final 'binderOccurrences))))

  (test-case "finished try program retains possible edges under either policy"
    (for ([hiding '("standard" "none")])
      ;; Query only completion to avoid retaining every intermediate position.
      (call-with-macro-source
       (request try-program #:mode "module")
       (lambda (stx)
         (define query #f)
         (define summary (expansion-steps stx hiding #:schema-version 2
                                          #:retain-inspector (lambda (q) (set! query q))))
         (define final (hash-ref (query (hasheq 'mode "position" 'position (add1 (hash-ref summary 'stepCount)))) 'final))
         (check-true (pair? (hash-ref final 'edges)))
         (check-not-false (findf (lambda (edge) (equal? (hash-ref edge 'certainty) "possible"))
                                (hash-ref final 'edges)))))))

  (test-case "final edges retain destination certainty and signed resolution phase"
    (define binder (datum->syntax #f 'x))
    (define use (datum->syntax #f 'x))
    (define unresolved ((make-syntax-introducer) (datum->syntax #f 'x)))
    (check-false (bound-identifier=? unresolved use))
    (check-true (free-identifier=? unresolved binder))
    (define tree (datum->syntax #f (list binder use unresolved)))
    (for ([phase '(-1 0 1 8)])
      (define answer (expansion-answer null (hasheq binder phase) (hasheq use phase)
                                       tree #f tree 'null null))
      (define final (hash-ref answer 'final))
      (define occurrences (term-named answer final "x"))
      (define (incoming occurrence)
        (filter (lambda (edge) (equal? (hash-ref edge 'reference) (hash-ref occurrence 'id)))
                (hash-ref final 'edges)))
      (define definite (incoming (cadr occurrences)))
      (define possible (incoming (caddr occurrences)))
      (check-equal? (length definite) 1)
      (check-equal? (length possible) 1)
      (check-equal? (hash-ref (car definite) 'certainty) "definite")
      (check-equal? (hash-ref (car definite) 'phase) phase)
      (check-equal? (hash-ref (car possible) 'certainty) "possible")))

  (test-case "scope-equivalent intermediate inputs remain possible without their own use facts"
    (define facts (model-fixture known-use-program "standard"))
    (define steps (car facts))
    (define rewrite (findf (lambda (s) (and (rewrite-step? s) (eq? (protostep-type s) 'macro))) steps))
    (check-not-false rewrite)
    (define before (protostep-s1 rewrite))
    (define xs (filter (lambda (s) (and (identifier? s) (eq? (syntax-e s) 'x)))
                       (syntax-objects (state-term before))))
    ;; Binder, ordinary use, then the argument of keep. The variable reducer
    ;; records a distinct resolved output; its visible input remains possible.
    (for ([ordinary (cdr xs)])
      (check-not-false
       (for/first ([(known phase) (in-hash (state-uses before))]
                   #:when (and (equal? phase 0) (bound-identifier=? ordinary known phase))) known)))
    (define answer (view-of known-use-program))
    (define section (hash-ref (car (hash-ref answer 'steps)) 'before))
    (define occurrences (cdr (term-named answer section "x")))
    (define edges (filter (lambda (e) (member (hash-ref e 'reference) (map (lambda (o) (hash-ref o 'id)) occurrences)))
                          (hash-ref section 'edges)))
    (check-equal? (length edges) 2)
    (for ([edge edges] [ordinary (cdr xs)])
      (check-equal? (hash-ref edge 'certainty)
                    (if (hash-ref (state-uses before) ordinary #f) "definite" "possible"))))

  (test-case "certainty uses only the current state's facts at the edge's phase"
    (define binder (datum->syntax #f 'x))
    (define use (datum->syntax #f 'x))
    (define known (syntax-property use 'resolved-copy #t))
    (check-false (eq? use known))
    (check-true (bound-identifier=? use known))
    (define tree (datum->syntax #f (list binder use)))
    (define binders (hasheq binder 0))
    (define (at uses) (state tree null null null binders uses (hasheq) 0))
    (define before (at (hasheq)))
    (for ([phase '(0 1)])
      (define after (at (hasheq known phase)))
      (define answer (expansion-answer (list (step 'macro before after)) binders (hasheq known phase)
                                       tree #f tree 'null null))
      (define record (car (hash-ref answer 'steps)))
      (define (certainties key) (map (lambda (e) (hash-ref e 'certainty)) (hash-ref (hash-ref record key) 'edges)))
      (check-equal? (certainties 'before) '("possible"))
      (check-equal? (certainties 'after) '("possible"))))

  (test-case "model fixtures expose uses, final facts, adjustment, phases and inspection"
    (define facts (model-fixture model-program))
    (define steps (car facts))
    (define binders (cadr facts))
    (define uses (caddr facts))
    (define final (cadddr facts))
    (check-false (list-ref facts 4))
    (check-true (syntax? final))
    (check-true (positive? (hash-count binders)))
    (check-true (positive? (hash-count uses)))
    (check-not-false (member 1 (hash-values uses)))
    (check-not-false (findf (lambda (s) (eq? (protostep-type s) 'rename-mod-shift)) steps))
    (define ids (filter identifier? (syntax-objects final)))
    (check-true (for/or ([id ids])
                  (for/or ([(use phase) (in-hash uses)])
                    (free-identifier=? id use phase))))
    (define selected (findf (lambda (id) (eq? (syntax-e id) 'y)) ids))
    (check-equal? (identifier-binding selected 0) 'lexical)
    (check-true (hash? (syntax-debug-info selected 0)))
    (check-true (pair? (hash-ref (syntax-debug-info selected 0) 'context)))
    (check-equal? (syntax-property (syntax-property selected 'fixture 42) 'fixture) 42)
    (define relocations
      (call-with-macro-source
       (request model-program #:mode "module")
       (lambda (stx)
         (define-values (_result _events derivation) (trace* stx))
         (module-relocations (force derivation)))))
    (check-true (positive? (hash-count relocations)))
    (check-true (for/or ([(original targets) (in-hash relocations)])
                  (and (eq? (syntax-e original) 'x)
                       (for/or ([target targets])
                         (and (not (eq? original target))
                              (free-identifier=? original target 0)))))))

  (test-case "model fixture exposes nested transformer inputs on failure"
    (define facts (model-fixture transformer-error-program))
    (define stopped (findf misstep? (car facts)))
    (check-not-false stopped)
    (check-true (exn:fail:syntax? (misstep-exn stopped)))
    (check-true (pair? (exn:fail:syntax-exprs (misstep-exn stopped))))
    (define contexts (state-lctx (protostep-s1 stopped)))
    (check-true (>= (length contexts) 2))
    (check-true (andmap (lambda (frame) (and (syntax? (bigframe-term frame))
                                          (pair? (bigframe-foci frame)))) contexts))
    (check-equal? (take (map (lambda (frame) (syntax->datum (bigframe-e frame))) contexts) 3)
                  '((bad) (middle) (outer))))

  (test-case "Standard final connects the result use to its definition"
    (check-final-result-binding "standard"))

  (test-case "unhidden final still connects the result use to its definition"
    (check-final-result-binding "none"))

  (test-case "occurrences preserve identity, parents, delimiters and UTF-16 including CRLF"
    (define answer (view-of "#lang racket/base\n(define-syntax-rule (keep x) x)\n[keep (list '|😀\r\nx| '[] '#(1 2) '#&3 '{a . b} '#hash((key . val)) '#s(point 1 2))]\n"))
    (define step (car (hash-ref answer 'steps)))
    (define before (hash-ref step 'before))
    (define after (hash-ref step 'after))
    (define ids-before (map (lambda (o) (hash-ref o 'syntaxId)) (hash-ref before 'occurrences)))
    (check-true (for/or ([o (hash-ref after 'occurrences)]) (and (member (hash-ref o 'syntaxId) ids-before) #t)))
    (for ([part (list before after)])
      (define occurrences (hash-ref part 'occurrences))
      (define by-id (for/hash ([o occurrences]) (values (hash-ref o 'id) o)))
      (for ([o occurrences])
        (define term (term-of answer o))
        (define range (hash-ref o 'range))
        (check-not-exn (lambda () (appearance-text part o)))
        (when (equal? (hash-ref term 'kind) "identifier")
          (check-true (positive? (string-length (appearance-text part o)))))
        (unless (eq? (hash-ref o 'parentId) 'null)
          (define parent (hash-ref by-id (hash-ref o 'parentId)))
          (check-true (<= (car (hash-ref parent 'range)) (car range) (cadr range) (cadr (hash-ref parent 'range)))))
        (for ([delimiter (hash-ref o 'delimiterRanges)])
          (check-not-false (member (utf16-slice (hash-ref part 'text) delimiter) '("(" ")" "[" "]" "{" "}")))))
      (check-true (for/or ([o occurrences])
                    (and (regexp-match? #rx"^\\[(keep|list)" (appearance-text part o))
                         (= (length (hash-ref o 'delimiterRanges)) 2))))
      (define b (car (term-named answer part "b")))
      (check-equal? (appearance-text part b) "b"))
    ;; The same input object is deliberately used twice. An engine rewrite may
    ;; copy equal-looking syntax, which must retain its distinct identities.
    (define atom (datum->syntax #f 42))
    (define tree (datum->syntax #f (list atom atom)))
    (define repeated (expansion-answer null (hasheq) (hasheq) tree #f tree 'null null))
    (define output (hash-ref repeated 'final))
    (define repeated-atoms
      (filter (lambda (o) (equal? (appearance-text output o) "42")) (hash-ref output 'occurrences)))
    (check-equal? (length repeated-atoms) 2)
    (check-equal? (hash-ref (car repeated-atoms) 'syntaxId) (hash-ref (cadr repeated-atoms) 'syntaxId))
    (check-not-equal? (hash-ref (car repeated-atoms) 'id) (hash-ref (cadr repeated-atoms) 'id))
    (check-true (for/or ([term (in-hash-values (hash-ref answer 'terms))]) (hash-ref term 'artificial))))

  (test-case "identifier relations distinguish hygiene independently of syntax identity"
    (define answer (view-of sample))
    (define part (hash-ref (cadr (hash-ref answer 'steps)) 'after))
    (define tmps (map (lambda (o) (term-of answer o)) (term-named answer part "tmp")))
    (check-equal? (length (remove-duplicates (map (lambda (t) (hash-ref (hash-ref t 'relations) 'bound)) tmps))) 3)
    (check-equal? (length (remove-duplicates (map (lambda (t) (hash-ref t 'macroScopeGroup)) tmps))) 2)
    (check-equal? (length (remove-duplicates (map (lambda (t) (hash-ref (hash-ref t 'relations) 'free)) tmps))) 2)
    (define compound (findf (lambda (t) (equal? (hash-ref t 'kind) "compound")) (hash-values (hash-ref answer 'terms))))
    (check-equal? (hash-ref compound 'relations) 'null)
    (check-true (andmap (lambda (b) (equal? (hash-ref b 'status) "not-applicable")) (hash-ref compound 'bindings))))

  (test-case "every printed occurrence reports its group including introduced compound delimiters"
    (define answer (view-of sample))
    (define guard (car (hash-ref answer 'steps)))
    (define after (hash-ref guard 'after))
    (define form
      (findf (lambda (o) (equal? (without-name-suffixes (appearance-text after o)) "(unless (number? n) 'no)"))
             (hash-ref after 'occurrences)))
    (check-not-false form)
    (check-equal? (hash-ref (term-of answer form) 'kind) "compound")
    (define group (hash-ref form 'macroScopeGroup))
    (check-true (positive? group))
    (check-equal? (map (lambda (r) (utf16-slice (hash-ref after 'text) r))
                       (hash-ref form 'delimiterRanges)) '("(" ")"))
    (define head (findf (lambda (o) (and (equal? (appearance-text after o) "unless")
                                        (equal? (hash-ref o 'parentId) (hash-ref form 'id))))
                        (hash-ref after 'occurrences)))
    (check-not-false head)
    (check-equal? (hash-ref head 'macroScopeGroup) group)
    (define written
      (findf (lambda (o) (and (equal? (appearance-text after o) "(number? n)")
                              (equal? (hash-ref o 'parentId) (hash-ref form 'id))))
             (hash-ref after 'occurrences)))
    (check-not-false written)
    (check-equal? (hash-ref written 'macroScopeGroup) 0)
    (for ([part (append (append-map (lambda (s) (list (hash-ref s 'before) (hash-ref s 'after)))
                                   (hash-ref answer 'steps)) (list (hash-ref answer 'final)))])
      (for ([o (hash-ref part 'occurrences)])
        (check-true (exact-nonnegative-integer? (hash-ref o 'macroScopeGroup)))
        (check-equal? (hash-ref o 'macroScopeGroup) (hash-ref (term-of answer o) 'macroScopeGroup)))))

  (test-case "recorded uses are definite, provisional matches possible, final module binders survive adjustment"
    (define answer (view-of model-program #:hiding "none"))
    (define parts (append (append-map (lambda (s) (list (hash-ref s 'before) (hash-ref s 'after)))
                                     (hash-ref answer 'steps)) (list (hash-ref answer 'final))))
    (define edges (append-map (lambda (p) (hash-ref p 'edges)) parts))
    (check-not-false (findf (lambda (e) (equal? (hash-ref e 'certainty) "definite")) edges))
    (check-not-false (findf (lambda (e) (equal? (hash-ref e 'certainty) "possible")) edges))
    (check-not-false (findf (lambda (e) (and (equal? (hash-ref e 'certainty) "definite") (= (hash-ref e 'phase) 1))) edges))
    (define final (hash-ref answer 'final))
    (define binders (hash-ref final 'binderOccurrences))
    (check-true (for/or ([o (term-named answer final "x")]) (and (member (hash-ref o 'id) binders) #t)))
    (check-true (for/or ([e (hash-ref final 'edges)]) (equal? (hash-ref e 'certainty) "possible")))
    (for ([part parts])
      (define ids (map (lambda (o) (hash-ref o 'id)) (hash-ref part 'occurrences)))
      (for ([e (hash-ref part 'edges)])
        (check-not-false (member (hash-ref e 'binder) ids))
        (check-not-false (member (hash-ref e 'reference) ids)))))

  (test-case "property values use native expression printing including nested syntax"
    (define annotate (datum->syntax #f 'annotate '(details-fixture.rkt 9 1 267 8)))
    (for ([value (list '(alpha 7) (list annotate) annotate 'alpha #t #f
                       '#(alpha 7) '#&alpha '#hash((alpha . 7)) '#s(point 1 2)
                       '(quote alpha) '(alpha . 7) "hello" 7)])
      (define out (open-output-string))
      (print value out)
      (define result (display-value value))
      (check-equal? (hash-ref result 'text) (get-output-string out))
      (check-false (hash-ref result 'truncated)))
    (check-equal? (hash-ref (display-value (list annotate)) 'text)
                  "'(#<syntax:details-fixture.rkt:9:1 annotate>)")
    (check-equal?
     (hash-ref (display-value (list (datum->syntax #f 'annotate
                                                  (list (string->path "/project/details-fixture.rkt") 9 1 267 8)))) 'text)
     "'(#<syntax:details-fixture.rkt:9:1 annotate>)")
    ;; The syntax printer must not expose a property's custom writer either.
    (struct hostile () #:property prop:custom-write (lambda args (error "custom writer ran")))
    (define result (display-value (list (datum->syntax #f (hostile)))))
    (check-equal? (hash-ref result 'reason) "opaque")
    (check-true (string-contains? (hash-ref result 'text) "#<opaque>")))

  (test-case "term inspection includes phases, implicit bindings, properties, scopes and null coordinates"
    (define term (syntax-property (datum->syntax #f '(x 1)) 'fixture '(hello 42)))
    (define answer (expansion-answer null (hasheq) (hasheq) term #f term 'null '(8)))
    (define root (term-of answer (car (hash-ref (hash-ref answer 'final) 'occurrences))))
    (check-equal? (hash-ref root 'inspectedPhases) '(0 8))
    (check-equal? (hash-ref answer 'availablePhases) (append default-phases '(8)))
    (check-equal? (hash-ref root 'source) 'null)
    (check-equal? (hash-ref root 'symbolStatus) "not-applicable")
    (check-equal? (hash-ref root 'inspectionStatus) "complete")
    (check-equal? (hash-ref (hash-ref root 'builtins) 'tamperStatus) "unarmed")
    (check-equal? (hash-ref (car (hash-ref root 'properties)) 'name) "fixture")
    (check-equal? (hash-ref (hash-ref (car (hash-ref root 'properties)) 'value) 'text) "'(hello 42)")
    (for ([scope (hash-ref root 'scopes)])
      (check-equal? (hash-ref scope 'status) "known")
      (check-equal? (hash-ref scope 'scopes) null))
    (for ([bindings (in-hash-values (hash-ref root 'implicitBindings))])
      (check-equal? (map (lambda (b) (hash-ref b 'phase)) bindings) '(0 1 8))
      (check-true (andmap (lambda (b) (equal? (hash-ref b 'status) "absent")) bindings))))

  (test-case "property displays bound cycles, depth, entries and UTF-8 without executing custom writers"
    (struct hostile () #:property prop:custom-write (lambda args (error "custom writer ran")))
    (define cyclic (shared ([v (cons 'cycle v)]) v))
    (define examples (list cyclic (hostile) (make-list 257 1) (make-string 5000 #\λ)
                           (for/fold ([value 1]) ([_ (in-range 9)]) (vector value))))
    (for ([value examples] [reason '("cycle" "opaque" "entries" "UTF-8 byte limit" "depth")])
      (define printed (display-value value))
      (check-true (hash-ref printed 'truncated))
      (check-true (string-contains? (hash-ref printed 'reason) reason))
      (check-true (<= (string-utf-8-length (hash-ref printed 'text)) 4096)))
    (define term (syntax-property #'x 'opaque (hostile)))
    (define answer (expansion-answer null (hasheq) (hasheq) term #f term 'null null))
    (check-equal? (hash-ref (term-of answer (car (hash-ref (hash-ref answer 'final) 'occurrences))) 'inspectionStatus) "partial"))

  (test-case "engine final syntax retains named properties, lexical scopes and label bindings"
    (define query #f)
    (define answer
      (view-of (string-append
                "#lang racket/base\n(require (for-syntax racket/base) (for-label racket/base))\n"
                "(define-syntax (marked stx) (syntax-property #'(let ([value 1]) value) 'fixture 'kept))\n"
                "(marked)\n") #:hiding "none" #:retain-inspector (lambda (inspect) (set! query inspect))))
    (define final (hash-ref answer 'final))
    (define terms (map (lambda (o) (term-of answer o)) (hash-ref final 'occurrences)))
    (check-true (for/or ([term terms])
                  (for/or ([property (hash-ref term 'properties)])
                    (and (equal? (hash-ref property 'name) "fixture")
                         (equal? (hash-ref (hash-ref property 'value) 'text) "'kept")))))
    (define selected
      (findf (lambda (term) (equal? (hash-ref (car (hash-ref term 'bindings)) 'kind) "lexical"))
             (map (lambda (o) (term-of answer o)) (term-named answer final "value"))))
    (check-not-false selected)
    (check-equal? (hash-ref (car (hash-ref selected 'bindings)) 'kind) "lexical")
    (check-true (pair? (hash-ref (car (hash-ref selected 'scopes)) 'scopes)))
    (define tid (hash-ref (car (term-named answer final "value")) 'syntaxId))
    (define more (query tid '("label")))
    (define inspected (decode-term (hash-ref more 'shared)
                                  (hash-ref more 'termData)))
    (check-true (for/or ([binding (hash-ref (hash-ref inspected 'implicitBindings) 'app)])
                  (and (equal? (hash-ref binding 'phase) "label")
                       (equal? (hash-ref binding 'kind) "module")))))

  (test-case "adapter transports label and extra phases without assigning a phase to provisional uses"
    ;; Explicit model values isolate the adapter's phase encoding. These are
    ;; not claimed to be label-use records generated by the expansion engine.
    (define binder (datum->syntax #f 'target))
    (define use (datum->syntax #f 'target))
    (define possible (datum->syntax #f 'target))
    (define high-binder (datum->syntax #f 'higher))
    (define high-use (datum->syntax #f 'higher))
    (define term (datum->syntax #f (list binder use possible high-binder high-use
                                        (datum->syntax #f (gensym 'private))
                                        (datum->syntax #f (string->unreadable-symbol "hidden")))))
    (define answer (expansion-answer null (hasheq binder #f high-binder 8)
                                     (hasheq use #f high-use 8) term #f term 'null null))
    (define final (hash-ref answer 'final))
    (define edges (hash-ref final 'edges))
    (check-not-false (member 8 (hash-ref answer 'inspectedPhases)))
    (check-not-false (findf (lambda (e) (and (equal? (hash-ref e 'phase) "label")
                                          (equal? (hash-ref e 'certainty) "possible"))) edges))
    (check-not-false (findf (lambda (e) (and (equal? (hash-ref e 'phase) 8)
                                          (equal? (hash-ref e 'certainty) "definite"))) edges))
    (check-not-false (findf (lambda (o) (and (equal? (hash-ref (term-of answer o) 'name) "target")
                                          (eq? (hash-ref o 'phase) 'null))) (hash-ref final 'occurrences)))
    (define statuses (map (lambda (t) (hash-ref t 'symbolStatus)) (hash-values (hash-ref answer 'terms))))
    (check-not-false (member "uninterned" statuses))
    (check-not-false (member "unreadable" statuses)))

  (test-case "two variables that print alike are in different hygiene groups"
    (define swap (cadr (hash-ref (steps-of sample) 'steps)))
    (define names (hash-ref (hash-ref swap 'after) 'names))
    (define groups (remove-duplicates (for/list ([name names] #:when (equal? (caddr name) "tmp")) (cadddr name))))
    (check-equal? (length groups) 2)
    (check-not-false (memv 0 groups) "One of them is the variable the program wrote"))

  (test-case "a name is connected to its binder once expansion has made the binding, as in Racket's window"
    (define swap (cadr (hash-ref (steps-of sample) 'steps)))
    (define after (hash-ref swap 'after))
    (define text (hash-ref after 'text))
    (define names (hash-ref after 'names))
    (define caller-start (+ 8 (caar (regexp-match-positions #rx"[(]define tmp 1[)]" text))))
    (define caller-tmps (filter (lambda (name) (and (equal? (caddr name) "tmp") (zero? (cadddr name))
                                                 (>= (car name) caller-start))) names))
    (define caller-binder (take (car caller-tmps) 2))
    (check-not-false (member caller-binder (hash-ref after 'binders)))
    (check-not-false (member (append (take (last caller-tmps) 2) caller-binder) (hash-ref after 'links)))
    ;; The introduced let has not expanded, so its tmp still binds nothing.
    (define introduced-tmps (filter (lambda (name) (and (equal? (caddr name) "tmp") (not (zero? (cadddr name))))) names))
    (for ([name (in-list introduced-tmps)])
      (check-false (member (take name 2) (hash-ref after 'binders)))
      (check-false (findf (lambda (link) (equal? (drop link 2) (take name 2))) (hash-ref after 'links)))))

  (test-case "a section without binders has no binding ranges or links"
    (define step (car (hash-ref (steps-of "(or #f 42)" #:mode "fragment" #:hiding "none") 'steps)))
    (for ([key '(before after)])
      (check-equal? (hash-ref (hash-ref step key) 'binders) '())
      (check-equal? (hash-ref (hash-ref step key) 'links) '())))

  (test-case "a compile-time definition is not a binder before its binding is recorded"
    (define steps
      (hash-ref (steps-of "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (define x 1) x)"
                          #:hiding "none") 'steps))
    (define definition
      (for/first ([step (in-list steps)]
                  #:when (and (equal? (focused-text (hash-ref step 'before)) '("(define x 1)"))
                              (equal? (focused-text (hash-ref step 'after)) '("(define-values (x) 1)"))))
        step))
    (check-not-false definition)
    (for ([key '(before after)])
      (define part (hash-ref definition key))
      (check-equal? (filter (lambda (range) (equal? (apply substring (hash-ref part 'text) range) "x"))
                            (hash-ref part 'binders))
                    '() (symbol->string key))))
)
