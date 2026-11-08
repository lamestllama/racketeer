#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Build schema 1 and lazy schema 2 answers and encode compact inspection records.
(require racket/class racket/list syntax/id-table
         macro-debugger/model/steps
         "printing.rkt" "policy.rkt" "facts.rkt" "limits.rkt" "checkpoint.rkt")
(provide expansion-answer step->json visible-step? decode-term)

(define (section term foci binders uses partition #:contents [contents #f]
                 #:suffix-option [suffix-option 'over-limit])
  (define-values (text ranges) (layout term #:partition partition #:contents contents #:suffix-option suffix-option))
  (define (ranges-of id) (hash-ref ranges id null))
  ;; Each phase has one recorded representative of each visible binding.
  (define tables (make-hash))
  (for ([(id phase) (in-hash binders)] #:when (pair? (ranges-of id)))
    (define table (hash-ref! tables phase (lambda () (make-free-id-table #:phase phase))))
    (free-id-table-set! table id id))
  (define links
    (for*/list ([(id spans) (in-hash ranges)] #:when (identifier? id)
                [(phase table) (in-hash tables)]
                #:when (or (not (hash-has-key? uses id)) (equal? phase (hash-ref uses id)))
                [binder (in-value (free-id-table-ref table id #f))] #:when binder
                [use (in-list spans)] [target (in-list (ranges-of binder))]
                #:unless (equal? use target))
      (append use target)))
  (hasheq 'text text
          'focus (append-map ranges-of foci)
          'binders (sort (append-map ranges-of (hash-keys binders)) < #:key car)
          'links (sort (remove-duplicates links) < #:key car)
          'names (sort (for*/list ([(id spans) (in-hash ranges)] #:when (identifier? id)
                                  [span (in-list spans)])
                         (append span (list (symbol->string (syntax-e id))
                                            (send partition get-partition id))))
                       < #:key car)))

;; Action remarks (including lifts) occupy positions just like rewrites.
;; The model has already applied hiding, including local-expansion exceptions.
(define (visible-step? step [include-renaming? #f])
  (or (rewrite-step? step) (misstep? step) (remarkstep? step)
      (and include-renaming? (rename-step? step))))

(define (step->json step partition #:suffix-option [suffix-option 'over-limit])
  (define s1 (protostep-s1 step))
  (define foci (state-foci s1))
  (define focus (and (pair? foci) (car foci)))
  (define (part state)
    (section (context-fill (state-ctx state) (state-e state))
             (state-foci state) (state-binders state) (state-uses state) partition
             #:suffix-option suffix-option))
  (define result
    (hasheq 'label (step-type->string (protostep-type step))
            'macro (and (eq? (protostep-type step) 'macro) (macro-name focus))
            'source (source-of focus)))
  (define rendered
    (cond [(remarkstep? step)
           (hash-set* result 'kind "remark"
                      'before (section #f null (state-binders s1) (state-uses s1) partition
                                       #:contents (remarkstep-contents step) #:suffix-option suffix-option)
                      'after #f
                      'contexts
                      (for/list ([frame (in-list (state-lctx s1))])
                        (section (bigframe-term frame) (bigframe-foci frame)
                                 (state-binders s1) (state-uses s1) partition #:suffix-option suffix-option)))]
          [(misstep? step)
           (hash-set* result 'before (part s1)
                      'error (exn-message (misstep-exn step)))]
          [else
           (define s2 (step-s2 step))
           (hash-set* result 'before (part s1) 'after (part s2))]))
  ;; Suspended transformer terms are displayed after both sides. They share
  ;; the partition even in the compact schema that omits their sections.
  (for ([frame (in-list (state-lctx s1))])
    (layout (bigframe-term frame) #:partition partition #:suffix-option suffix-option))
  rendered)

(define (source-of stx)
  (define file (and stx (syntax-source stx)))
  (and (or (path? file) (string? file)) (syntax-line stx) (syntax-column stx)
       (hasheq 'path (if (path? file) (path->string file) file)
               'line (syntax-line stx) 'column (syntax-column stx) 'span (or (syntax-span stx) 0))))

(define (macro-name stx)
  (define datum (and stx (syntax-e stx)))
  (define head (if (pair? datum) (car datum) stx))
  (and head (identifier? head) (symbol->string (syntax-e head))))

;; Compact term records only; Sections keep their existing UTF-16 wire shape.
;; terms maps syntax IDs to zero-based shared indices. Each shared entry is a
;; string, object or array; its children use [index] for a reference and literal
;; numbers/booleans otherwise. Arrays are always interned, so [index] is
;; unambiguous even for a one-element numeric array. Equal structures share an
;; index after their children have been interned. Table entries are immutable.
;;
;; Omitted defaults (restored by decode-term): nullable fields -> null; arrays
;; -> []; artificial, original and truncated -> false; phase/macroScopeGroup ->
;; 0; inspectionStatus -> complete; tamperStatus -> unarmed; symbolStatus ->
;; interned for identifiers, not-applicable otherwise. Binding status defaults
;; to absent, scope status to known. Missing phase records mean NOT INSPECTED;
;; a present empty ScopePhase means inspected and no scopes. Numeric 0 and
;; false are never interchangeable (coordinates and label phases matter).
(define scalar-defaults
  (hasheq 'phase 0 'macroScopeGroup 0 'inspectionStatus "complete"
          'tamperStatus "unarmed" 'symbolStatus "interned"))
(define (make-shared-table)
  (define indices (make-hash))
  (define entries null)
  (define count 0)
  (define (omit? key value record)
    (or (eq? value 'null) (eq? value #f) (null? value)
        (and (eq? key 'status)
             (or (equal? value "absent")
                 (and (equal? value "known") (hash-has-key? record 'scopes))))
        (and (eq? key 'symbolStatus) (equal? value "not-applicable")
             (not (equal? (hash-ref record 'kind #f) "identifier")))
        (equal? value (hash-ref scalar-defaults key 'no-default))))
  (define (intern value)
    (define entry
      (cond [(hash? value)
             (for/hasheq ([(key child) (in-hash value)]
                          #:unless (or (omit? key child value)
                                       (and (hash? child)
                                            (for/and ([(k v) (in-hash child)]) (omit? k v child)))))
               (values key (encode child)))]
            [(list? value) (map encode value)]
            [else value]))
    (hash-ref! indices entry
               (lambda ()
                 (define index count)
                 (set! count (add1 count))
                 (set! entries (cons entry entries))
                 index)))
  (define (encode value)
    (if (or (string? value) (hash? value) (list? value)) (list (intern value)) value))
  (values intern (lambda (start) (reverse (take entries (- count start))))))

;; Restore the semantic Term shape, for consumers that need a selected term.
;; Decode on selection, rather than inflating the complete answer in the host.
(define (decode-term shared index)
  (define table (if (vector? shared) shared (list->vector shared)))
  (define (decode value)
    (cond [(list? value) (entry (vector-ref table (car value)))]
          [else value]))
  (define (entry value)
    (cond [(hash? value) (for/hasheq ([(k v) (in-hash value)]) (values k (decode v)))]
          [(list? value) (map decode value)]
          [else value]))
  (define (defaults value fields)
    (for/fold ([value value]) ([(key fallback) (in-hash fields)])
      (if (hash-has-key? value key) value (hash-set value key fallback))))
  (define (binding b)
    (defaults b (hasheq 'phase 0 'status "absent" 'kind 'null 'bindingId 'null
                       'definedIn 'null 'importedFrom 'null 'name 'null 'originalName 'null
                       'providedName 'null 'definitionPhase 'null 'description 'null 'reason 'null)))
  (define term (entry (vector-ref table index)))
  (define base
    (defaults term (hasheq 'name 'null 'source 'null 'relations 'null 'artificial #f
                           'macroScopeGroup 0 'properties null 'inspectionStatus "complete"
                           'inspectionNotes null 'inspectedPhases null
                           'symbolStatus (if (equal? (hash-ref term 'kind) "identifier") "interned" "not-applicable"))))
  (hash-set* base
    'source (if (eq? (hash-ref base 'source) 'null) 'null
                (defaults (hash-ref base 'source)
                          (hasheq 'sourceId 'null 'line 'null 'column 'null 'position 'null 'span 'null)))
    'bindings (map binding (hash-ref base 'bindings null))
    'implicitBindings (for/hasheq ([key '(top app datum)])
                        (values key (map binding (hash-ref (hash-ref base 'implicitBindings (hasheq)) key null))))
    'scopes (for/list ([scope (hash-ref base 'scopes null)])
              (define restored (defaults scope (hasheq 'phase 0 'status "known" 'reason 'null 'scopes null)))
              (hash-set restored 'scopes
                        (map (lambda (s) (defaults s (hasheq 'kind 'null))) (hash-ref restored 'scopes))))
    'builtins (defaults (hash-ref base 'builtins (hasheq))
                        (hasheq 'tamperStatus "unarmed" 'original #f 'sourceModule 'null))
    'properties (for/list ([property (hash-ref base 'properties)])
                  (hash-set property 'value
                            (defaults (hash-ref property 'value) (hasheq 'truncated #f 'reason 'null))))))

;; The model's contexts are inner-to-outer frame lists. Only preserved frame
;; identities at their outer ends can be shared; printed equality is irrelevant.
(define (factor-states before after)
  (define c1 (state-ctx before))
  (define c2 (state-ctx after))
  (define shared
    (let loop ([a (reverse c1)] [b (reverse c2)] [result null])
      (if (and (pair? a) (pair? b) (eq? (car a) (car b)))
          (loop (cdr a) (cdr b) (cons (car a) result)) result)))
  (values (context-fill (drop-right c1 (length shared)) (state-e before))
          (context-fill (drop-right c2 (length shared)) (state-e after))
          (and (pair? shared)
               (context-fill shared (syntax-property (datum->syntax #f '#:hole) 'macro-stepper-hole #t)))))

(define (expansion-answer steps final-binders final-uses expanded failure original snapshot requested-phases
                          #:retain-inspector [retain-inspector void]
                          #:rule-context [rule-context #f]
                          #:expanded-phases [expanded-phases (hasheq)]
                          #:relocations [relocations (hasheq)]
                          #:partition [partition (new-foreground-partition)]
                          #:include-renaming? [include-renaming? #f]
                          #:one-term? [one-term? #f]
                          #:syntax-identity [syntax-identity (make-syntax-identity)]
                          #:suffix-option [suffix-option 'over-limit])
  (define serial 0)
  (define current-position #f)
  (define paired-positions (make-hasheqv))
  (define displayed-positions (make-hasheqv))
  (define (fresh prefix)
    (set! serial (add1 serial))
    (string->symbol (format "p~a-~a~a" current-position prefix serial)))
  (define (id prefix) (symbol->string (fresh prefix)))
  (define terms (make-hasheq))
  (define-values (source-location sources) (make-source-registry original snapshot))
  (define diagnostics (make-hasheq))
  (define-values (term-id describe inspect reset-inspection! retained-terms retained-phases)
    (make-term-inspector fresh id source-location requested-phases))
  (define adjusted-phases (make-hasheq))
  (for ([(term phases) (in-hash expanded-phases)])
    (hash-update! adjusted-phases term
                  (lambda (old) (remove-duplicates (append old phases))) null))
  ;; Preserve phases shared by an engine identity across positions without
  ;; printing or inspecting any term. Identical state tables are visited once.
  (define seen-facts (make-hasheq))
  (define (record-facts facts)
    (unless (hash-ref seen-facts facts #f)
      (hash-set! seen-facts facts #t)
      (for ([(term phase) (in-hash facts)])
        (hash-update! adjusted-phases term
                      (lambda (old) (remove-duplicates (cons (wire-phase phase) old))) null))))
  (record-facts final-binders)
  (record-facts final-uses)
  (for ([step steps])
    (define before (protostep-s1 step))
    (record-facts (state-binders before))
    (record-facts (state-uses before))
    (when (step? step)
      (record-facts (state-binders (step-s2 step)))
      (record-facts (state-uses (step-s2 step)))))
  (define observed
    (append (hash-values final-binders) (hash-values final-uses)
            (append-map (lambda (step)
                          (define s (protostep-s1 step))
                          (append (hash-values (state-binders s)) (hash-values (state-uses s)))) steps)))
  (define available-phases
    (remove-duplicates
     (append default-phases requested-phases
             (append-map values (hash-values expanded-phases)) (map wire-phase observed))))
  (define factor? #f)
  (define identities? #f)
  (define columns 60)
  (define render-section (make-section-renderer id term-id relocations adjusted-phases))
  (define (part term foci binders uses #:contents [contents #f] #:frontier [frontier #f])
    (render-section term foci binders uses #:contents contents #:partition partition
                    #:suffix-option suffix-option #:frontier frontier #:columns columns))
  (define (state-part state [term (state-term state)] #:highlight-frontier? [highlight-frontier? #f])
    (part term (state-foci state) (state-binders state) (state-uses state) #:frontier (and highlight-frontier? (state-frontier state))))
  (define (step-before step)
    (define state (protostep-s1 step))
    (if (remarkstep? step)
        (part #f null (state-binders state) (state-uses state)
              #:contents (remarkstep-contents step))
        (state-part state)))
  (define (contexts-of state)
    (for/list ([frame (in-list (state-lctx state))])
      (hasheq 'label "While executing macro transformer in:"
              'section (part (bigframe-term frame) (bigframe-foci frame)
                             (state-binders state) (state-uses state)))))
  (define positions
    (list->vector
     (append-map (lambda (step)
                   (if (and one-term? (step? step))
                       (list (cons step "before") (cons step "after"))
                       (list (cons step #f))))
                 (filter (lambda (step) (visible-step? step include-renaming?)) steps))))
  (define (position-step index) (car (vector-ref positions (sub1 index))))
  (define (error-id index) (format "diagnostic~a" index))
  (define records
    (for/list ([entry (in-vector positions)] [index (in-naturals 1)])
      (define step (car entry))
      (define side (cdr entry))
      (define state (if (equal? side "after") (step-s2 step) (protostep-s1 step)))
      (define foci (state-foci (protostep-s1 step)))
      (define focus (and (pair? foci) (car foci)))
      (define metadata
        (hasheq 'id (format "step~a" index) 'eventKey 'null 'expansionPoint (state-seq state)
              'kind (cond [(misstep? step) "error"] [(remarkstep? step) "remark"] [else "rewrite"])
              'label (step-type->string (protostep-type step))
              'macro (nullable (and (eq? (protostep-type step) 'macro) (macro-name focus)))
              'source (source-location focus)
              'sourceFoci (filter (lambda (source) (not (eq? source 'null))) (map source-location foci))
              'error (if (misstep? step) (error-id index) 'null)))
      (if side (hash-set metadata 'side side) metadata)))
  (define terminal-index
    (for/last ([entry (in-vector positions)] [index (in-naturals 1)] #:when (misstep? (car entry))) index))
  (define terminal-error (if (exn? failure) (error-id (or terminal-index 0)) 'null))
  (define count (add1 (length records)))
  (define (diagnostic exception did program contexts binders uses)
    (define record
      (hasheq 'id did 'kind (if (exn:fail:syntax? exception) "syntax" "expansion")
              'message (exn-message exception) 'program (if (exn:fail:step-stop? exception) 'null program)
              'syntax (if (exn:fail:syntax? exception)
                          (for/list ([stx (in-list (exn:fail:syntax-exprs exception))])
                            (part stx (list stx) binders uses)) null)
              'contexts contexts))
    (hash-set! diagnostics (string->symbol did) record))
  (define (position-answer position [panes? (hash-ref paired-positions position #f)])
    (unless (and (exact-positive-integer? position) (<= position count))
      (incompatible "Invalid expansion position."))
    ;; Position-local identities are deterministic, including reconstructed
    ;; syntax. Only this position's syntax is retained; printed text never is.
    (set! current-position position)
    (hash-set! paired-positions position panes?)
    (set! serial 0)
    (set! terms (make-hasheq))
    (set! diagnostics (make-hasheq))
    (reset-inspection!)
    (define step (and (< position count) (position-step position)))
    (define record
      (and step
           (let* ([metadata (list-ref records (sub1 position))]
                  [side (hash-ref metadata 'side #f)]
                  [s1 (protostep-s1 step)]
                  [state (if (equal? side "after") (step-s2 step) s1)])
             (define-values (fragment1 fragment2 common)
               (if (and factor? (not one-term?) (step? step))
                   (factor-states s1 (step-s2 step))
                   (values #f #f #f)))
             ;; Render in encounter order: Before, After, common, transformer contexts.
             (define before
               (cond [(equal? side "after") 'null]
                     [(and common (step? step)) (state-part s1 fragment1 #:highlight-frontier? #t)]
                     [side (state-part s1 #:highlight-frontier? #t)]
                     [else (step-before step)]))
             (define after
               (if (and (step? step) (not (equal? side "before")))
                   (state-part (step-s2 step) (if common fragment2 (state-term (step-s2 step)))
                               #:highlight-frontier? (or side common)) 'null))
             (define context
               (if common (part common null (state-binders s1) (state-uses s1)) 'null))
             (define contexts (contexts-of state))
             (when (misstep? step)
               (diagnostic (misstep-exn step) (hash-ref metadata 'error) before contexts
                           (state-binders state) (state-uses state)))
             (define record (hash-set* metadata 'before before 'after after 'contexts contexts))
             (if common (hash-set record 'commonContext context) record))))
    (define final
      (if (and (not step) (syntax? expanded))
          ;; Completion facts apply to the finished syntax objects.
          (part expanded null final-binders final-uses)
          'null))
    ;; The paired view can retain an already displayed last input. A direct
    ;; jump to completion must not discover groups in an unvisited reduction.
    ;; Prepare the finished term first, just as at an ordinary final position.
    (define terminal-before
      (and panes? (not step) (hash-ref displayed-positions (sub1 count) #f)
           (step-before (position-step (sub1 count)))))
    (hash-set! displayed-positions position #t)
    (when (and (not step) (exn? failure))
      (if terminal-index
          (let* ([state (protostep-s1 (position-step terminal-index))]
                 [program (state-part state)] [contexts (contexts-of state)])
            (diagnostic failure terminal-error program contexts (state-binders state) (state-uses state)))
          (diagnostic failure terminal-error 'null null final-binders final-uses)))
    (for ([tid (in-list (sort (hash-keys (retained-terms)) symbol<?))])
      (define description (describe (hash-ref (retained-terms) tid) partition))
      (hash-set! terms tid (if identities?
                               (hash-set description 'identity (syntax-identity (hash-ref (retained-terms) tid)))
                               description)))
    (define answer
      (hasheq 'schemaVersion 2 'snapshot snapshot 'mode "position" 'position position 'count count
              'record (or record 'null) 'final final 'terminalBefore (or terminal-before 'null)
              'error (if step (hash-ref record 'error) terminal-error)
              'terms terms 'diagnostics diagnostics 'sources (hash-copy sources) 'nextGroup (send partition next-number) 'relationPhase 0
              'inspectedPhases null 'availablePhases available-phases))
    ;; No session closure holds the returned printed sections or term records.
    (set! diagnostics (make-hasheq))
    (set! terms (make-hasheq))
    answer)
  (retain-inspector
   (lambda (query)
     (define position (hash-ref query 'position #f))
     (cond
       [(equal? (hash-ref query 'mode #f) "configure")
        (define grouping (hash-ref query 'grouping "macro"))
        (unless (member grouping '("macro" "all")) (incompatible "Invalid foreground grouping."))
        (set! partition (new-foreground-partition (string->symbol grouping)))
        (hash-clear! displayed-positions)
        (set! current-position #f)
        (hasheq 'mode "configured")]
       [(equal? (hash-ref query 'mode #f) "position")
        (define option (hash-ref query 'suffixOption (symbol->string suffix-option)))
        (unless (member option '("over-limit" "always")) (incompatible "Invalid suffix option."))
        (set! suffix-option (string->symbol option))
        (unless (boolean? (hash-ref query 'factorCommonContext #f)) (incompatible "Invalid common context option."))
        (set! factor? (hash-ref query 'factorCommonContext #f))
        (set! identities? (hash-ref query 'syntaxIdentities #f))
        (define width (hash-ref query 'columns columns))
        (unless (and (exact-positive-integer? width) (<= width 10000)) (incompatible "Invalid syntax display width."))
        (set! columns width)
        (when (and (eq? (hash-ref query 'retainTerminalBefore #f) #t) (> count 1) (equal? position count))
          (hash-set! displayed-positions (sub1 count) #t))
        (position-answer position (hash-ref query 'panes #f))]
       [(equal? (hash-ref query 'mode #f) "hidingRule")
        (unless (equal? position current-position) (position-answer position))
        (define identifier (hash-ref (retained-terms) (string->symbol (hash-ref query 'term)) #f))
        (unless (and (identifier? identifier) (member (hash-ref query 'action) '("show" "hide")))
          (incompatible "Select an identifier for a macro hiding rule."))
        (make-hiding-rule identifier query rule-context)]
       [(equal? (hash-ref query 'mode #f) "inspect")
        (unless (equal? position current-position) (position-answer position))
        (define tid (hash-ref query 'term #f))
        (unless (and (string? tid) (hash-has-key? (retained-terms) (string->symbol tid)))
          (incompatible "Unknown syntax identity in inspection request."))
        (define phases (hash-ref query 'phases (hash-ref (retained-phases) (string->symbol tid))))
        (validate-phases phases)
        (define facts (inspect (hash-ref (retained-terms) (string->symbol tid)) (remove-duplicates phases) partition
                               #:initial? (not (hash-has-key? query 'phases))))
        ((current-inspection-observer) tid facts)
        ;; Inspection tables belong to one answer, never accumulate in a session.
        (define-values (intern since) (make-shared-table))
        (define index (intern facts))
        (hasheq 'schemaVersion 2 'snapshot snapshot 'mode "inspect" 'position position 'term tid
                'termData index 'shared (since 0) 'sources (hash-copy sources))]
       [else (incompatible "Unknown expansion session request.")])))
  (hasheq 'schemaVersion 2 'snapshot snapshot 'mode "summary" 'stepCount (length records)
          'steps records 'final (and (syntax? expanded) #t) 'error terminal-error
          'message (if (exn? failure) (exn-message failure) 'null)
          'nextGroup (send partition next-number)
          'sources (hash-copy sources) 'relationPhase 0 'availablePhases available-phases
          'capabilities '("syntax-selection" "relations" "binding-edges" "properties" "error-contexts"
                         "interactive-final" "phase-inspection" "lazy-positions")))
