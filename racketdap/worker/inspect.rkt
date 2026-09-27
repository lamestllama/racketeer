#lang racket/base
(require racket/list racket/promise "../instrumentation/instrument.rkt")
(provide value-preview value-type children expandable?)
(define (clip s [limit 160])
  (if (> (string-length s) limit) (string-append (substring s 0 limit) "…") s))
(define (value-type v)
  (cond [(unavailable? v) "unavailable"] [(impersonator? v) "wrapped value"]
        [(null? v) "null"] [(pair? v) "pair"] [(vector? v) "vector"]
        [(box? v) "box"] [(hash? v) "hash"] [(string? v) "string"]
        [(bytes? v) "bytes"] [(number? v) "number"] [(boolean? v) "boolean"]
        [(symbol? v) "symbol"] [(keyword? v) "keyword"] [(char? v) "character"]
        [(void? v) "void"] [(promise? v) "promise"] [(procedure? v) "procedure"]
        [(port? v) "port"] [(thread? v) "thread"] [else "opaque value"]))
(define (large-number? n)
  (and (exact? n)
       (if (real? n)
           (or (> (integer-length (numerator n)) 2048)
               (> (integer-length (denominator n)) 2048))
           (or (large-number? (real-part n)) (large-number? (imag-part n))))))
(define (value-preview v [depth 0])
  (cond
    [(unavailable? v) "<uninitialized>"]
    [(impersonator? v) "<wrapped value; inspect explicitly in the console>"]
    [(string? v) (format "~s" (clip v))]
    [(bytes? v) (format "~s" (subbytes v 0 (min 80 (bytes-length v))))]
    [(number? v) (if (large-number? v) "<large exact number>" (number->string v))]
    [(or (boolean? v) (char? v) (null? v)) (format "~s" v)]
    [(symbol? v) (clip (symbol->string v))]
    [(keyword? v) (string-append "#:" (clip (keyword->string v)))]
    [(void? v) "#<void>"]
    [(pair? v) (if (>= depth 2) "(…)"
                   (clip (format "(~a . ~a)" (value-preview (car v) (add1 depth))
                                 (value-preview (cdr v) (add1 depth)))))]
    [(vector? v) (format "#<vector: ~a elements>" (vector-length v))]
    [(box? v) (if (>= depth 2) "#&…" (string-append "#&" (value-preview (unbox v) (add1 depth))))]
    [(hash? v) (format "#<hash: ~a entries>" (hash-count v))]
    [else (format "#<~a>" (value-type v))]))
(define (expandable? v)
  (and (not (impersonator? v)) (or (pair? v) (vector? v) (box? v) (hash? v))))
(define (children value start count)
  (define end (+ start count))
  (cond
    [(impersonator? value) '()]
    [(pair? value) (take (drop (list (cons "car" (car value)) (cons "cdr" (cdr value))) (min start 2))
                       (max 0 (- (min end 2) (min start 2))))]
    [(vector? value)
     (for/list ([i (in-range (min start (vector-length value)) (min end (vector-length value)))])
       (cons (number->string i) (vector-ref value i)))]
    [(box? value) (if (and (zero? start) (positive? count)) (list (cons "value" (unbox value))) '())]
    [(hash? value)
     (let loop ([position (hash-iterate-first value)] [i 0] [items '()])
       (if (or (not position) (>= i end)) (reverse items)
           (loop (hash-iterate-next value position) (add1 i)
                 (if (< i start) items
                     (cons (cons (number->string i)
                                 (cons (hash-iterate-key value position) (hash-iterate-value value position))) items)))))]
    [else '()]))
