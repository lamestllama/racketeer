#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; What a worker and the server say to each other. Compile-time code can reach a
;; worker's reply pipe, so a reader must not trust what a message declares: FASL names
;; the size of what it allocates ahead of the values, and a few bytes can ask for
;; gigabytes. JSON carries its elements, so what a reader allocates follows what arrived.
(require json racket/match racket/port)
(provide read-worker-message write-worker-message)

(define maximum-message-bytes (* 128 1024 1024))

;; Every compound value is a list whose first element names its kind.
(define (encode value)
  (define uninterned (make-hasheq))
  (let walk ([value value])
    (cond
      [(or (boolean? value) (string? value) (exact-integer? value) (flonum? value)) value]
      [(symbol? value)
       (cond
         [(symbol-interned? value) (list "symbol" (symbol->string value))]
         [(symbol-unreadable? value) (list "unreadable" (symbol->string value))]
         [else (list "uninterned" (hash-ref! uninterned value (lambda () (hash-count uninterned)))
                     (symbol->string value))])]
      [(bytes? value) (list "bytes" (bytes->string/latin-1 value))]
      [(path? value) (list "path" (bytes->string/latin-1 (path->bytes value)))]
      [(list? value) (cons "list" (map walk value))]
      [(pair? value) (list "pair" (walk (car value)) (walk (cdr value)))]
      [(hash? value)
       (list (if (hash-eq? value) "hasheq" "hash")
             (for/list ([(key val) (in-hash value)]) (list (walk key) (walk val))))]
      [else (error 'worker-message "cannot send: ~e" value)])))

(define (decode value)
  (define uninterned (make-hash))
  (let walk ([value value])
    (match value
      [(or (? boolean?) (? string?) (? exact-integer?) (? flonum?)) value]
      [(list "symbol" (? string? name)) (string->symbol name)]
      [(list "unreadable" (? string? name)) (string->unreadable-symbol name)]
      [(list "uninterned" (? exact-integer? id) (? string? name))
       (hash-ref! uninterned id (lambda () (string->uninterned-symbol name)))]
      [(list "bytes" (? string? text)) (string->bytes/latin-1 text)]
      [(list "path" (? string? text)) (bytes->path (string->bytes/latin-1 text))]
      [(cons "list" items) (map walk items)]
      [(list "pair" first rest) (cons (walk first) (walk rest))]
      [(list (and kind (or "hasheq" "hash")) (list (list keys vals) ...))
       ((if (equal? kind "hasheq") make-immutable-hasheq make-immutable-hash)
        (map (lambda (key val) (cons (walk key) (walk val))) keys vals))]
      [_ (error 'worker-message "cannot read: ~e" value)])))

(define (write-worker-message value out)
  (define bytes (jsexpr->bytes (encode value)))
  (when (> (bytes-length bytes) maximum-message-bytes)
    (error 'worker-message "a message of ~a bytes is over the limit of ~a" (bytes-length bytes) maximum-message-bytes))
  (write (bytes-length bytes) out)
  (newline out)
  (void (write-bytes bytes out)))

(define (read-worker-message in)
  (define length
    (let loop ([size 0] [digits 0])
      (define byte (read-byte in))
      (cond
        [(and (eqv? byte 10) (positive? digits)) size]
        [(and (byte? byte) (<= 48 byte 57) (< digits 9))
         (define next (+ (* size 10) (- byte 48)))
         (when (> next maximum-message-bytes) (error 'worker-message "a message over the limit"))
         (loop next (add1 digits))]
        [else (error 'worker-message "no valid length")])))
  (define bytes (port->bytes (make-limited-input-port in length #f) #:close? #f))
  (unless (= length (bytes-length bytes)) (error 'worker-message "a message cut short"))
  (decode (bytes->jsexpr bytes)))
