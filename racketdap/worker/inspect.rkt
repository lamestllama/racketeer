#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/keyword racket/list racket/promise racket/string racket/symbol racket/unsafe/undefined
         "../instrumentation/instrument.rkt")
(provide value-preview value-type children expandable? child-counts value-rows page)
;; Retain the inspector above the debuggee's structure types.
(define debugger-inspector (current-inspector))
(define (visible-structure-type value)
  (parameterize ([current-inspector debugger-inspector])
    (define-values (type skipped?) (struct-info value))
    (and (not (unavailable? value)) (not skipped?) type)))
(define wrapped? program-wrapped?)
(define (clip s [limit 160])
  (if (> (string-length s) limit) (string-append (substring s 0 limit) "…") s))
(define (name-atom-preview value)
  ;; Print only a bounded, primitive atom. In particular, never hand a whole
  ;; debuggee value to the generic printer or let its reader settings change
  ;; which symbol spellings are ambiguous.
  (define keyword-value? (keyword? value))
  (define text ((if keyword-value? keyword->immutable-string symbol->immutable-string) value))
  (define shortened? (> (string-length text) 160))
  (define atom
    (if shortened?
        ((if keyword-value? string->keyword string->uninterned-symbol) (substring text 0 160))
        value))
  (parameterize ([current-readtable #f] [read-case-sensitive #t]
                 [read-accept-bar-quote #t] [read-accept-dot #t])
    (clip (string-append (format "~s" atom) (if shortened? "…" "")))))
(define (port-direction value)
  (cond [(and (input-port? value) (output-port? value)) "input-output-port"]
        [(input-port? value) "input-port"]
        [else "output-port"]))
(define (structure-name type)
  ;; This is the type descriptor, never the instance's prop:object-name.
  (clip (symbol->string (object-name type))))
(define (safe-procedure-name value)
  ;; Neither struct? nor struct-info can rule out an opaque callable structure.
  ;; Restrict object-name to procedure kinds that cannot have prop:object-name.
  (or (plain-procedure-name value)
      (and (or (primitive? value) (struct-constructor-procedure? value)
               (struct-predicate-procedure? value) (struct-accessor-procedure? value)
               (struct-mutator-procedure? value))
           (object-name value))))
(define (value-type v)
  (cond [(or (unavailable? v) (eq? v unsafe-undefined)) "unavailable"] [(wrapped? v) "wrapped value"]
        [(null? v) "null"] [(pair? v) "pair"] [(vector? v) "vector"]
        [(box? v) "box"] [(hash? v) "hash"] [(string? v) "string"]
        [(bytes? v) "bytes"] [(number? v) "number"] [(boolean? v) "boolean"]
        [(symbol? v) "symbol"] [(keyword? v) "keyword"] [(char? v) "character"]
        [(void? v) "void"] [(promise? v) "promise"] [(syntax? v) "syntax"]
        [(path? v) "path"] [(procedure? v) "procedure"]
        [(port? v) "port"] [(thread? v) "thread"]
        [(visible-structure-type v) => structure-name]
        [else "opaque value"]))
(define (large-number? n)
  (and (exact? n)
       (if (real? n)
           (or (> (integer-length (numerator n)) 2048)
               (> (integer-length (denominator n)) 2048))
           (or (large-number? (real-part n)) (large-number? (imag-part n))))))

(define wrapped-preview "<wrapped value; inspect explicitly in the console>")
(define preview-items 6)
(define preview-depth 3)
(define preview-hierarchy 32)
;; A guarded object refuses to read a field before its initialiser has run.
(define (field-value ref value i)
  (with-handlers ([exn:fail:contract:variable? (lambda (_) (unavailable 'uninitialized))])
    (ref value i)))
;; Fetch only the requested fields. The optional hierarchy limit is used for
;; previews: an unusually deep hierarchy must not defeat their work budget.
;; Returning #f means the hierarchy limit was reached, not an opaque field.
(define (structure-children value start count [hierarchy-limit +inf.0])
  (parameterize ([current-inspector debugger-inspector])
    (define type (visible-structure-type value))
    (define end (+ start count))
    (define-values (_ fields)
      (let loop ([type type] [remaining hierarchy-limit])
        (cond [(not type) (values 0 '())]
              [(zero? remaining) (values 0 #f)]
              [else
               (define-values (name init auto ref set immutable super skipped?) (struct-type-info type))
               (define-values (offset fields) (loop super (sub1 remaining)))
               (values (+ offset init auto)
                       (and fields
                            (append fields
                                    (for/list ([i (in-range (max 0 (- start offset))
                                                           (max 0 (min (+ init auto) (- end offset))))])
                                      (cons (number->string (+ offset i)) (field-value ref value i))))))])))
    fields))

(define (value-preview value [initial-depth 0])
  ;; A per-preview node budget bounds shared graphs as well as individual
  ;; containers. No generic printing, list-length walk, or syntax->datum here.
  (define remaining 64)
  (define (visit!)
    (and (positive? remaining) (begin (set! remaining (sub1 remaining)) #t)))
  (define (joined items more?)
    (string-join (if more? (append items '("…")) items) " "))
  (define (preview v depth ancestors [datum? #f])
    (define (nested item [next-ancestors ancestors])
      (preview item (add1 depth) next-ancestors datum?))
    (define (container render abbreviated)
      (cond [(hash-ref ancestors v #f) "#<cycle>"]
            [(>= depth preview-depth) abbreviated]
            [else (render (hash-set ancestors v #t))]))
    (clip
     (cond
       [(not (visit!)) "…"]
       [(and (unavailable? v) (eq? (unavailable-reason v) 'wrapped)) wrapped-preview]
       ;; A field holds the undefined value until its initialiser has run.
       [(or (unavailable? v) (eq? v unsafe-undefined)) "<uninitialized>"]
       [(wrapped? v) wrapped-preview]
       [(string? v) (format "~s" (clip v))]
       [(bytes? v) (string-append (format "~s" (subbytes v 0 (min 80 (bytes-length v))))
                                 (if (> (bytes-length v) 80) "…" ""))]
       [(number? v) (if (large-number? v) "<large exact number>" (number->string v))]
       [(or (boolean? v) (char? v) (null? v)) (format "~s" v)]
       [(or (symbol? v) (keyword? v)) (name-atom-preview v)]
       [(void? v) "#<void>"]
       [(path? v) (format "#<path:~a>" (clip (path->string v)))]
       [(syntax? v)
        (if datum? (preview (syntax-e v) depth ancestors #t)
            (container (lambda (seen)
                         (string-append "#<syntax: " (preview (syntax-e v) depth seen #t) ">"))
                       "#<syntax: …>"))]
       [(pair? v)
        (container
         (lambda (seen)
           (string-append
            "("
            (let loop ([tail v] [i 0] [seen seen])
              (cond
                [(null? tail) ""]
                [(and datum? (syntax? tail))
                 (if (visit!) (loop (syntax-e tail) i seen) " . …")]
                [(not (pair? tail)) (string-append " . " (nested tail seen))]
                [(and (positive? i) (hash-ref seen tail #f)) " . #<cycle>"]
                [(or (= i preview-items) (and (positive? i) (not (visit!)))) " …"]
                [else
                 (define next-seen (hash-set seen tail #t))
                 (string-append (if (zero? i) "" " ") (nested (car tail) next-seen)
                                (loop (cdr tail) (add1 i) next-seen))]))
            ")"))
         "(…)")]
       [(vector? v)
        (container
         (lambda (seen)
           (string-append "#(" (joined (for/list ([i (in-range (min preview-items (vector-length v)))])
                                         (nested (vector-ref v i) seen))
                                       (> (vector-length v) preview-items)) ")"))
         "#(…)")]
       [(box? v) (container (lambda (seen) (string-append "#&" (nested (unbox v) seen))) "#&…")]
       [(hash? v)
        (define prefix (cond [(hash-eq? v) "#hasheq("] [(hash-eqv? v) "#hasheqv("]
                             [(hash-equal-always? v) "#hashalw("] [else "#hash("]))
        (container
         (lambda (seen)
           (string-append
            prefix
            (let loop ([position (hash-iterate-first v)] [i 0] [items '()])
              (cond [(not position) (joined (reverse items) #f)]
                    [(or (= i preview-items) (zero? remaining)) (joined (reverse items) #t)]
                    [else
                     (define entry
                       (string-append "(" (nested (hash-iterate-key v position) seen) " . "
                                      (nested (hash-iterate-value v position) seen) ")"))
                     (loop (hash-iterate-next v position) (add1 i) (cons entry items))]))
            ")"))
         (string-append prefix "…)"))]
       [(promise? v) "#<promise>"]
       [(port? v)
        ;; Port predicates also accept opaque structures with prop:input-port
        ;; or prop:output-port. Even port-closed? can call a delegated wrapped
        ;; accessor, and object-name can call their prop:object-name. Only a
        ;; constructor result whose provenance is known may supply metadata.
        (if (instrumented-port? v)
            (container (lambda (seen)
                         (define name (object-name v))
                         (string-append "#<" (port-direction v) ":"
                                        (if (path? name) (clip (path->string name)) (nested name seen)) ">"))
                       (string-append "#<" (port-direction v) ":…>"))
            (string-append "#<" (port-direction v) ">"))]
       [(visible-structure-type v)
        => (lambda (type)
             (define name (structure-name type))
             (container
              (lambda (seen)
                (define fields (structure-children v 0 (add1 preview-items) preview-hierarchy))
                (if fields
                    (string-append "#<" name
                                   (if (null? fields) ""
                                       (string-append " "
                                                      (joined (map (lambda (field) (nested (cdr field) seen))
                                                                   (take fields (min preview-items (length fields))))
                                                              (> (length fields) preview-items)))) ">")
                    (string-append "#<" name " …>")))
              (string-append "#<" name " …>")))]
       [(procedure? v)
        (define name (safe-procedure-name v))
        (if name (string-append "#<procedure:" (clip (symbol->string name)) ">") "#<procedure>")]
       [else (format "#<~a>" (value-type v))])))
  (preview value initial-depth (hasheq)))

(define (expandable? v)
  (and (not (unavailable? v)) (not (wrapped? v))
       (or (pair? v) (vector? v) (box? v) (hash? v) (syntax? v) (procedure? v) (instrumented-port? v)
           (and (visible-structure-type v) #t))))
(define (page items start count)
  (define length* (length items))
  (take (drop items (min start length*)) (max 0 (- (min (+ start count) length*) (min start length*)))))
;; Count fields once per structure type, without reading their values. The preview
;; budget does not limit container sizes or paging. Weak keys release unused types.
(define structure-counts (make-weak-hasheq))
(define (structure-field-count type)
  (hash-ref! structure-counts type
    (lambda ()
      (parameterize ([current-inspector debugger-inspector])
        (let loop ([type type] [fields 0])
          (cond [(not type) fields]
                [else
                 (define-values (name init auto ref set immutable super skipped?) (struct-type-info type))
                 (loop super (+ fields init auto))]))))))
;; How many rows a value opens to, indexed and named, without visiting them.
(define (child-counts value)
  (cond
    [(or (unavailable? value) (wrapped? value)) (values 0 0)]
    [(pair? value) (values 0 2)]
    [(vector? value) (values (vector-length value) 0)]
    [(box? value) (values 0 1)]
    [(hash? value) (values (hash-count value) 0)]
    [(syntax? value) (values 0 6)]
    [(instrumented-port? value) (values 0 3)]
    [(visible-structure-type value)
     => (lambda (type)
          (values (structure-field-count type) 0))]
    [(procedure? value) (values 0 1)]
    [else (values 0 0)]))
;; A request with no count asks for every row. Past this many a reply stops being a page a
;; client can hold, so it ends where it says it ends. The sizes a row reports tell a client
;; to page instead.
(define unpaged-row-limit 10000)
;; The rows a variables request gets, and how many more an unpaged one left out.
(define (value-rows value filter start count)
  (define-values (indexed named) (child-counts value))
  (cond
    [(or (and (equal? filter "indexed") (zero? indexed))
         (and (equal? filter "named") (zero? named)))
     (values '() 0)]
    [count (values (children value start count) 0)]
    [else
     (values (children value start unpaged-row-limit)
             (max 0 (- (+ indexed named) start unpaged-row-limit)))]))
(define (children value start count)
  (define end (+ start count))
  (cond
    [(or (unavailable? value) (wrapped? value) (zero? count)) '()]
    [(pair? value) (page (list (cons "car" (car value)) (cons "cdr" (cdr value))) start count)]
    [(vector? value)
     (for/list ([i (in-range (min start (vector-length value)) (min end (vector-length value)))])
       (cons (number->string i) (vector-ref value i)))]
    [(box? value) (if (zero? start) (list (cons "value" (unbox value))) '())]
    [(hash? value)
     (let loop ([position (hash-iterate-first value)] [i 0] [items '()])
       (if (or (not position) (>= i end)) (reverse items)
           (loop (hash-iterate-next value position) (add1 i)
                 (if (< i start) items
                     (cons (cons (number->string i)
                                 (cons (hash-iterate-key value position) (hash-iterate-value value position))) items)))))]
    [(syntax? value)
     ;; The immediate datum retains nested syntax objects for further expansion.
     (page (list (cons "datum" (syntax-e value)) (cons "source" (syntax-source value))
                 (cons "line" (syntax-line value)) (cons "column" (syntax-column value))
                 (cons "position" (syntax-position value)) (cons "span" (syntax-span value))) start count)]
    [(instrumented-port? value)
     (page (list (cons "direction" (string->symbol (port-direction value)))
                 (cons "name" (object-name value)) (cons "closed?" (port-closed? value))) start count)]
    [(visible-structure-type value) (structure-children value start count)]
    [(procedure? value)
     ;; Arity reflection does not call the procedure or prop:arity-string.
     (page (list (cons "arity" (procedure-arity value))) start count)]
    [else '()]))
