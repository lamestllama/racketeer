#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Track term identities, phases, bindings, scopes, properties and occurrence edges.
(require racket/class racket/list racket/path racket/string syntax/id-table syntax/modcollapse
         macro-debugger/model/stx-util
         (only-in macro-debugger/model/deriv node? node-z1 node-z2
                  p:module? p:module-body p:module-shift)
         (only-in macro-debugger/model/deriv-util for-subnodes)
         "limits.rkt" "printing.rkt")
(provide default-phases wire-phase nullable validate-phases display-value module-relocations derivation-phases
         current-inspection-observer make-syntax-identity make-source-registry make-term-inspector make-section-renderer)

(define (make-syntax-identity)
  (define identities (make-weak-hasheq))
  (define next 0)
  (lambda (stx)
    (hash-ref! identities stx
               (lambda () (set! next (add1 next)) (format "syntax~a" next)))))

(define default-phases '(0 1 -1 "label" 2 -2 3 -3 4 -4 5 -5))
(define (wire-phase phase) (if phase phase "label"))
(define (racket-phase phase) (if (equal? phase "label") #f phase))
(define (nullable value) (if value value 'null))
(define (compound? stx)
  (define value (syntax-e stx))
  (or (pair? value) (null? value) (vector? value) (box? value) (hash? value)
      (prefab-struct-key value)))

(define (validate-phases phases)
  (unless (and (list? phases) (<= (length phases) 256)
               (andmap (lambda (phase) (or (exact-integer? phase) (equal? phase "label"))) phases))
    (incompatible "Invalid inspection phases.")))

;; Use the native value printer after bounding containers and replacing unsafe
;; values. Only our own placeholder writer can run; syntax retains its source.
(struct display-token (text)
  #:property prop:custom-write (lambda (value out mode) (display (display-token-text value) out))
  #:property prop:custom-print-quotable 'always)
(define (display-value value #:expression? [expression? #t])
  (define-values (out content) (bounded-output 4096))
  (define seen (make-hasheq))
  (define reasons null)
  (define remaining 4096)
  (define (token text reason)
    (set! reasons (cons reason reasons))
    (display-token text))
  (define (container value depth work)
    (cond [(hash-ref seen value #f) (token "#<cycle>" "cycle")]
          [(>= depth 8) (token "#<depth limit>" "depth")]
          [else (hash-set! seen value #t)
                (begin0 (work) (hash-remove! seen value))]))
  (define (walk value depth)
    (set! remaining (sub1 remaining))
    (cond
      [(negative? remaining) (token "#<entry limit>" "entries")]
      [(or (boolean? value) (number? value) (char? value) (string? value)
           (bytes? value) (symbol? value) (keyword? value) (null? value)) value]
      [(syntax? value)
       (container value depth
                  (lambda ()
                    (define source (syntax-source value))
                    (datum->syntax #f (walk (syntax-e value) (add1 depth))
                                   (list (if (path? source) (file-name-from-path source) source)
                                         (syntax-line value) (syntax-column value)
                                         (syntax-position value) (syntax-span value)))))]
      [(pair? value)
       (define (tail value index)
         (cond [(null? value) null]
               [(or (= index 256) (negative? remaining)) (list (token "..." "entries"))]
               [(pair? value)
                (container value depth
                           (lambda () (cons (walk (car value) (add1 depth))
                                            (tail (cdr value) (add1 index)))))]
               [else (walk value (add1 depth))]))
       (tail value 0)]
      [(vector? value)
       (container value depth
                  (lambda () (list->vector (items (in-vector value) depth))))]
      [(box? value)
       (container value depth (lambda () (box (walk (unbox value) (add1 depth)))))]
      [(hash? value)
       (container value depth
                  (lambda ()
                    (for/fold ([result (hash-copy-clear value #:kind 'immutable)])
                              ([(key val) (in-hash value)] [index (in-range 257)])
                      (if (= index 256)
                          (hash-set result (token "..." "entries") (display-token "..."))
                          (hash-set result (walk key (add1 depth)) (walk val (add1 depth)))))))]
      [(prefab-struct-key value)
       (container value depth
                  (lambda () (apply make-prefab-struct (prefab-struct-key value)
                                    (items (cdr (vector->list (struct->vector value))) depth))))]
      [else (token "#<opaque>" "opaque")]))
  (define (items sequence depth)
    (for/list ([item sequence] [index (in-range 257)])
      (if (= index 256) (token "..." "entries") (walk item (add1 depth)))))
  (with-handlers ([exn:answer-size? (lambda (_) (set! reasons (cons "UTF-8 byte limit" reasons)))]
                  [exn:fail? (lambda (_) (set! reasons (cons "unavailable" reasons)))])
    (define safe (walk value 0))
    (if expression? (print safe out) (write safe out)))
  ;; A bounded port can stop between UTF-8 bytes. Trim that incomplete scalar.
  (define bytes (content))
  (define text
    (let loop ([end (bytes-length bytes)])
      (with-handlers ([exn:fail? (lambda (_) (loop (sub1 end)))])
        (bytes->string/utf-8 bytes #f 0 end))))
  (hasheq 'text text 'truncated (pair? reasons)
          'reason (if (null? reasons) 'null (string-join (reverse (remove-duplicates reasons)) ", "))))

(define (module-description value)
  ;; A self base contributes no display path. Collapse the remaining chain so
  ;; collection-relative imports use one canonical (lib ...) path.
  (define (without-self mpi)
    (cond [(module-path-index? mpi)
           (define-values (path base) (module-path-index-split mpi))
           (and path (module-path-index-join path (without-self base)))]
          [else mpi]))
  (cond [(not value) 'null]
        [(module-path-index? value)
         (define-values (path base) (module-path-index-split value))
         (if path
             (hash-ref (display-value (collapse-module-path-index (without-self value))
                                      #:expression? #f) 'text)
             "this module")]
        [(resolved-module-path? value) (module-description (resolved-module-path-name value))]
        [(path? value) (path->string value)]
        [else (hash-ref (display-value value #:expression? #f) 'text)]))

;; Relocations are directed identifier associations from the complete model,
;; independent of hiding. Later pairings take precedence; only list structure
;; participates, and finding a module stops descent into that module.
(define (for-module-relocations derivation proc)
  (let walk ([node derivation])
    (cond [(p:module? node)
           (define body (p:module-body node))
           (define shift (p:module-shift node))
           (when (and body shift)
             (proc (node-z2 body)
                   (stxd-car (stxd-cdr (stxd-cdr (stxd-cdr shift))))))]
          [node (for-subnodes node #:recur walk #:recur/phase-up walk)])))

(define (module-relocations derivation)
  (define targets (make-hasheq))
  (define (pair-terms before after)
    (cond [(and (identifier? before) (identifier? after))
           (hash-update! targets before (lambda (old) (cons after old)) null)]
          [(syntax? before) (pair-terms (syntax-e before) after)]
          [(syntax? after) (pair-terms before (syntax-e after))]
          [(and (pair? before) (pair? after))
           (pair-terms (car before) (car after))
           (pair-terms (cdr before) (cdr after))]))
  (for-module-relocations derivation pair-terms)
  targets)

;; Record the engine's phase transitions, including transformer right-hand
;; sides and begin-for-syntax bodies. Annotate node roots, then let printed
;; children inherit the nearest recorded context; never infer phase from names.
(define (derivation-phases derivation)
  (define roots (make-hasheq))
  (define (record term phase)
    (cond [(syntax? term)
           (hash-update! roots term (lambda (old) (remove-duplicates (cons phase old))) null)]
          [(list? term) (for-each (lambda (term) (record term phase)) term)]))
  (let walk ([node derivation] [phase 0])
    (when node
      (when (node? node) (record (node-z1 node) phase) (record (node-z2 node) phase))
      (for-subnodes node #:recur (lambda (child) (walk child phase))
                    #:recur/phase-up (lambda (child) (walk child (add1 phase))))))
  ;; Some literals and quoted compounds have no derivation node of their own.
  ;; Propagate the nearest root's phase through retained syntax, stopping at
  ;; more specific roots. Visit each object once per phase rather than walking
  ;; every whole subtree again for every enclosing derivation node.
  (define phases (make-hasheq))
  (define seen (make-hash))
  (define (inherit value context)
    (cond
      [(syntax? value)
       (for ([phase (hash-ref roots value context)])
         (define visited (hash-ref! seen phase make-hasheq))
         (unless (hash-ref visited value #f)
           (hash-set! visited value #t)
           (hash-update! phases value (lambda (old) (remove-duplicates (cons phase old))) null)
           (inherit (syntax-e value) (list phase))))]
      [(pair? value) (inherit (car value) context) (inherit (cdr value) context)]
      [(vector? value) (for ([child (in-vector value)]) (inherit child context))]
      [(box? value) (inherit (unbox value) context)]
      [(hash? value) (for ([child (in-hash-values value)]) (inherit child context))]
      [(prefab-struct-key value)
       (for ([child (in-list (cdr (vector->list (struct->vector value))))]) (inherit child context))]))
  (for ([(root context) (in-hash roots)]) (inherit root context))
  ;; Inspection also needs the phases of relocated compounds and literals.
  ;; Copy those annotations forward through corresponding syntax structure;
  ;; this neither merges identities nor supplies any resolved-use facts.
  (define (relocate-phases before after)
    (cond [(and (syntax? before) (syntax? after))
           (define known (hash-ref phases before null))
           (hash-update! phases after (lambda (old) (remove-duplicates (append old known))) null)
           (relocate-phases (syntax-e before) (syntax-e after))]
          [(syntax? before) (relocate-phases (syntax-e before) after)]
          [(syntax? after) (relocate-phases before (syntax-e after))]
          [(and (pair? before) (pair? after))
           (relocate-phases (car before) (car after))
           (relocate-phases (cdr before) (cdr after))]
          [(and (vector? before) (vector? after))
           (for ([a (in-vector before)] [b (in-vector after)]) (relocate-phases a b))]
          [(and (box? before) (box? after)) (relocate-phases (unbox before) (unbox after))]
          [(and (hash? before) (hash? after))
           (for ([(key value) (in-hash before)] #:when (hash-has-key? after key))
             (relocate-phases value (hash-ref after key)))]
          [(and (prefab-struct-key before) (equal? (prefab-struct-key before) (prefab-struct-key after)))
           (for ([a (in-list (cdr (vector->list (struct->vector before))))]
                 [b (in-list (cdr (vector->list (struct->vector after))))])
             (relocate-phases a b))]))
  (for-module-relocations derivation relocate-phases)
  phases)

(define current-inspection-observer (make-parameter void))

(define (make-source-registry original snapshot)
  (define source-serial 0)
  (define sources (make-hasheq))
  (define source-ids (make-hash))
  (define (source-location stx)
    (cond
      [(not (syntax? stx)) 'null]
      [else
       (define source (syntax-source stx))
       (define sid
         (and source
              (hash-ref! source-ids source
                         (lambda ()
                           (set! source-serial (add1 source-serial))
                           (define sid (string->symbol (format "source~a" source-serial)))
                           (define value (if (path? source) (path->string source)
                                             (if (string? source) source (hash-ref (display-value source #:expression? #f) 'text))))
                           (hash-set! sources sid
                                      (hasheq 'kind (cond [(path? source) "file"]
                                                          [(and (string? source) (string-prefix? source "untitled:")) "untitled"]
                                                          [else "other"])
                                              'value value
                                              ;; No fingerprint is inferred from a later disk read.
                                              'fingerprint
                                              (if (and (equal? source (syntax-source original)) (hash? snapshot))
                                                  (hash-ref snapshot 'sourceHash 'null) 'null)))
                           sid))))
       (if (or sid (syntax-line stx) (syntax-position stx))
           (hasheq 'sourceId (if sid (symbol->string sid) 'null)
                   'line (nullable (syntax-line stx)) 'column (nullable (syntax-column stx))
                   'position (nullable (syntax-position stx)) 'span (nullable (syntax-span stx)))
           'null)]))
  (values source-location sources))

;; A position owns its syntax and relation tables; reset before rendering another.
(define (make-term-inspector fresh id source-location requested-phases)
  (define syntax-ids #f)
  (define retained #f)
  (define term-phases #f)
  (define bound-classes #f)
  (define free-classes #f)
  (define binding-tables #f)
  (define (reset!)
    (set! syntax-ids (make-hasheq))
    (set! retained (make-hasheq))
    (set! term-phases (make-hasheq))
    (set! bound-classes (make-bound-id-table #:phase 0))
    (set! free-classes (make-free-id-table #:phase 0))
    (set! binding-tables (make-hash)))
  (reset!)
  (define (binding term phase)
    (define actual (racket-phase phase))
    (define base
      (hasheq 'phase phase 'status "absent" 'kind 'null 'bindingId 'null
              'definedIn 'null 'importedFrom 'null 'name 'null 'originalName 'null 'providedName 'null
              'definitionPhase 'null 'description 'null 'reason 'null))
    (with-handlers ([exn:fail? (lambda (e) (hash-set* base 'status "unavailable" 'reason (exn-message e)))])
      (cond
        [(not (identifier? term)) (hash-set base 'status "not-applicable")]
        [else
         (define info (identifier-binding term actual #t))
         (cond [(not info) base]
               [else
                (define table (hash-ref! binding-tables phase (lambda () (make-free-id-table #:phase actual))))
                (define bid (free-id-table-ref table term #f))
                (unless bid (set! bid (id "binding")) (free-id-table-set! table term bid))
                (define result
                  (hash-set* base 'status "known" 'bindingId bid 'name (symbol->string (syntax-e term))))
                (cond [(eq? info 'lexical) (hash-set result 'kind "lexical")]
                      [(= (length info) 1)
                       (hash-set* result 'kind "top-level" 'originalName (symbol->string (car info)))]
                      [else
                       (hash-set* result 'kind "module"
                                  'definedIn (module-description (list-ref info 0))
                                  'originalName (symbol->string (list-ref info 1))
                                  'importedFrom (module-description (list-ref info 2))
                                  'providedName (symbol->string (list-ref info 3))
                                  'definitionPhase (wire-phase (list-ref info 4)))])])])))
  (define (scope-phase term phase)
    (with-handlers ([exn:fail? (lambda (e) (hasheq 'phase phase 'status "unavailable" 'scopes null 'reason (exn-message e)))])
      (define scopes (hash-ref (syntax-debug-info term (racket-phase phase)) 'context null))
      (hasheq 'phase phase 'status "known" 'reason 'null
              'scopes (for/list ([scope scopes])
                        (hasheq 'id (format "scope~a" (vector-ref scope 0))
                                'kind (if (> (vector-length scope) 1) (symbol->string (vector-ref scope 1)) 'null)
                                'description (hash-ref (display-value scope #:expression? #f) 'text))))))
  ;; Registration is separate from inspection: a syntax object may appear at
  ;; several engine-known phases. Accumulate them before encoding its one record.
  (define (term-id term phase context-phases)
    (define tid
      (hash-ref! syntax-ids term
                 (lambda ()
                   (define tid (fresh "term"))
                   (hash-set! retained tid term)
                   tid)))
    (hash-update! term-phases tid
                  (lambda (old) (remove-duplicates (append old context-phases (if (eq? phase 'null) null (list phase)))))
                  (remove-duplicates (cons 0 requested-phases)))
    (symbol->string tid))
  (define (describe term partition)
    (define identifier (identifier? term))
    (define (class table ref set prefix)
      (or (ref table term #f)
          (let ([cid (id prefix)]) (set table term cid) cid)))
    (hasheq 'kind (cond [identifier "identifier"] [(compound? term) "compound"] [else "atom"])
           'name (if identifier (symbol->string (syntax-e term)) 'null)
           'artificial (and (syntax-artificial? term) #t)
           'source (source-location term) 'macroScopeGroup (send partition get-partition term)
           'relations (if identifier
                          (hasheq 'bound (class bound-classes bound-id-table-ref bound-id-table-set! "bound")
                                  'free (class free-classes free-id-table-ref free-id-table-set! "free")) 'null)))
  (define (inspect term phases partition #:initial? [initial? #f])
    (define identifier (identifier? term))
    (define binding-phases (if initial? (remove-duplicates (append '(0 1) phases)) phases))
    (define bindings (map (lambda (phase) (binding term phase)) binding-phases))
    (define implicit
      (for/hasheq ([key '(top app datum)] [name '(#%top #%app #%datum)])
        (values key (map (lambda (phase) (binding (datum->syntax term name) phase)) binding-phases))))
    (define scopes (map (lambda (phase) (scope-phase term phase)) phases))
    (define properties
      (for/list ([key (in-list (syntax-property-symbol-keys term))])
        (hasheq 'name (symbol->string key) 'value (display-value (syntax-property term key)))))
    (define notes
      (remove-duplicates
       (append
        (for/list ([b (append bindings (append-map values (hash-values implicit)))]
                   #:when (equal? (hash-ref b 'status) "unavailable"))
          (hash-ref b 'reason))
        (for/list ([s scopes] #:when (equal? (hash-ref s 'status) "unavailable"))
          (hash-ref s 'reason))
        (for/list ([p properties] #:when (hash-ref (hash-ref p 'value) 'truncated))
          (string-append "Property " (hash-ref p 'name) ": " (hash-ref (hash-ref p 'value) 'reason))))))
    (define source-module
      (with-handlers ([exn:fail? (lambda (e)
                                (set! notes (cons (string-append "Source module inspection: " (exn-message e)) notes))
                                'null)])
        (module-description (syntax-source-module term))))
    (hash-set*
     (describe term partition)
     'symbolStatus (cond [(not identifier) "not-applicable"]
                         [(symbol-interned? (syntax-e term)) "interned"]
                         [(symbol-unreadable? (syntax-e term)) "unreadable"] [else "uninterned"])
     'inspectedPhases phases
     'bindings bindings 'implicitBindings implicit 'scopes scopes
     'builtins (hasheq 'tamperStatus (cond [(syntax-property term property:unlocked-by-expander) "unlocked"]
                                          [(syntax-tainted? term) "tainted"] [(syntax-armed? term) "armed"]
                                          [else "unarmed"])
                       'original (syntax-original? term) 'sourceModule source-module)
     'properties properties 'inspectionStatus (if (null? notes) "complete" "partial")
     'inspectionNotes notes))
  (values term-id describe inspect reset!
          (lambda () retained) (lambda () term-phases)))

;; Occurrence identities and edges follow the printer's traversal order.
(define (make-section-renderer id term-id relocations adjusted-phases)
  (define (part term foci binders uses #:contents [contents #f]
                #:partition partition #:suffix-option [suffix-option 'over-limit] #:frontier [frontier #f] #:columns [columns 60])
    (define sid (id "section"))
    (define appearances (box null))
    (define-values (text _legacy-ranges)
      (layout term #:appearances appearances #:partition partition #:contents contents
              #:suffix-option suffix-option #:columns columns))
    (define nodes (reverse (unbox appearances)))
    ;; Printer hooks expose byte offsets. Translate once after delimiter edits;
    ;; UTF-16 counts both CR and LF, unlike the old port-location ranges.
    (define text-bytes (string->bytes/utf-8 text))
    (define offsets (make-hasheqv))
    (define byte-position 0)
    (define unit-position 0)
    (hash-set! offsets 0 0)
    (for ([char (in-string text)])
      (set! byte-position (+ byte-position (char-utf-8-length char)))
      (set! unit-position (+ unit-position (if (> (char->integer char) #xffff) 2 1)))
      (hash-set! offsets byte-position unit-position))
    (define node-ids (make-hasheq))
    (define visible (make-hasheq))
    ;; Certainty belongs to this exact displayed object. Only its directly
    ;; listed forward targets can supply a missing numeric resolution phase.
    (define (resolved-phase term)
      (or (hash-ref uses term #f)
          (for/or ([target (in-list (hash-ref relocations term null))])
            (hash-ref uses target #f))))
    (define origin-cache (make-hasheq))
    (define (origins binder)
      (hash-ref! origin-cache binder
                 (lambda ()
                   (append-map (lambda (term) (reverse (hash-ref visible term null)))
                               (cons binder (hash-ref relocations binder null))))))
    (for ([node nodes])
      (hash-set! node-ids node (id "occurrence"))
      (hash-update! visible (appearance-stx node) (lambda (old) (cons node old)) null))
    (define (span node)
      (list (hash-ref offsets (appearance-start node)) (hash-ref offsets (appearance-end node))))
    (define (delimiters node)
      (define value (syntax-e (appearance-stx node)))
      (define start (appearance-start node))
      (define end (appearance-end node))
      (define bytes text-bytes)
      (define open
        (cond [(or (pair? value) (null? value))
               (and (< start end) (memv (bytes-ref bytes start) '(40 91 123)) start)]
              [(or (vector? value) (hash? value) (prefab-struct-key value))
               (for/first ([pos (in-range start (min end (+ start 12)))]
                           #:when (= (bytes-ref bytes pos) 40)) pos)]
              [else #f]))
      (if (and open (> end open) (memv (bytes-ref bytes (sub1 end)) '(41 93 125)))
          (list (list (hash-ref offsets open) (hash-ref offsets (add1 open)))
                (list (hash-ref offsets (sub1 end)) (hash-ref offsets end))) null))
    (define context-phases (make-hasheq))
    (define occurrences
      (for/list ([node nodes])
        (define term (appearance-stx node))
        (define known-phases
          (hash-ref adjusted-phases term
                    (lambda () (hash-ref context-phases (appearance-parent node) '(0)))))
        (hash-set! context-phases node known-phases)
        (define phase
          (cond [(hash-has-key? uses term) (wire-phase (hash-ref uses term))]
                [(hash-has-key? binders term) (wire-phase (hash-ref binders term))]
                [else 'null]))
        (define occurrence
          (hasheq 'id (hash-ref node-ids node) 'syntaxId (term-id term phase known-phases) 'range (span node)
                'parentId (if (appearance-parent node) (hash-ref node-ids (appearance-parent node)) 'null)
                'delimiterRanges (delimiters node)
                'macroScopeGroup (send partition get-partition term)
                'colorRange (list (hash-ref offsets (appearance-start node))
                                  (hash-ref offsets (appearance-full-end node)))
                'phase phase))
        (if (appearance-taint node)
            (hash-set* occurrence 'taint (appearance-taint node) 'taintCount (appearance-taint-count node))
            occurrence)))
    ;; Binding identity is broader than object identity, but it is used only
    ;; to find origins, grouped by the binding sites' recorded phases.
    (define tables (make-hash))
    (for ([(binder phase) (in-hash binders)])
      (define table (hash-ref! tables phase (lambda () (make-free-id-table #:phase phase))))
      (free-id-table-set! table binder binder))
    (define binding-appearances
      (for*/hasheq ([binder (in-hash-keys binders)] [node (in-list (origins binder))])
        (values node #t)))
    (define binder-nodes (filter (lambda (node) (hash-ref binding-appearances node #f)) nodes))
    (define edges
      (remove-duplicates
       (for*/list ([node nodes] #:when (identifier? (appearance-stx node))
                   [resolved (in-value (resolved-phase (appearance-stx node)))]
                   [(phase table) (in-hash tables)]
                   #:when (or (not resolved) (equal? phase resolved))
                   [representative (in-value (free-id-table-ref table (appearance-stx node) #f))]
                   #:when representative
                   [binder (in-list (origins representative))]
                   #:unless (eq? node binder))
         (list (hash-ref node-ids binder) (hash-ref node-ids node)
               (if resolved "definite" "possible") (wire-phase phase)))))
    (define section
      (hasheq 'id sid 'text text
            'focus (append-map (lambda (focus) (map span (reverse (hash-ref visible focus null)))) foci)
            'occurrences occurrences 'binderOccurrences (map (lambda (node) (hash-ref node-ids node)) binder-nodes)
            'edges (for/list ([edge edges])
                     (hasheq 'id (id "edge") 'binder (car edge) 'reference (cadr edge)
                             'certainty (caddr edge) 'phase (cadddr edge)))))
    (if frontier
        (hash-set section 'frontier
                  (append-map (lambda (term) (map span (reverse (hash-ref visible term null))))
                              (if (hash? frontier) (hash-keys frontier) frontier)))
        section))
  part)
