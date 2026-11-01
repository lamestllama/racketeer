#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require json racket/string)
(provide read-message write-message)
(define max-message (* 16 1024 1024))
(define (read-exactly count in)
  (define buffer (make-bytes count))
  (let loop ([offset 0])
    (if (= offset count) buffer
        (let ([n (read-bytes! buffer in offset count)])
          (when (eof-object? n) (error 'protocol "truncated message"))
          (loop (+ offset n))))))
(define (read-message in)
  (define length #f)
  (let loop ([headers 0])
    (define line (read-bytes-line in 'any))
    (cond
      [(eof-object? line) (if (zero? headers) eof (error 'protocol "truncated headers"))]
      [(bytes=? line #"")
       (unless (and (exact-nonnegative-integer? length) (<= length max-message))
         (error 'protocol "invalid Content-Length"))
       (define message (bytes->jsexpr (read-exactly length in)))
       (unless (hash? message) (error 'protocol "message must be a JSON object"))
       message]
      [else
       (when (or (> headers 32) (> (bytes-length line) 8192)) (error 'protocol "oversized header"))
       (define match (regexp-match #rx#"^[Cc]ontent-[Ll]ength: *([0-9]+)$" line))
       (when match
         (when length (error 'protocol "duplicate Content-Length"))
         (set! length (string->number (bytes->string/utf-8 (cadr match)))))
       (loop (add1 headers))])))
(define (write-message message out)
  (define bytes (jsexpr->bytes message))
  (fprintf out "Content-Length: ~a\r\n\r\n" (bytes-length bytes))
  (write-bytes bytes out)
  (flush-output out))
