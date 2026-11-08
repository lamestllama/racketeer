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
  (define consumed 0)
  (define (header-byte)
    (define byte (read-byte in))
    (unless (eof-object? byte)
      (set! consumed (add1 consumed))
      (when (> consumed 32768) (error 'protocol "oversized header")))
    byte)
  (define (header-line)
    (define buffer (make-bytes 8192))
    (let loop ([offset 0])
      (define byte (header-byte))
      (cond
        [(eof-object? byte) (if (zero? offset) eof (subbytes buffer 0 offset))]
        [(or (= byte 10) (= byte 13))
         (when (and (= byte 13) (equal? (peek-byte in) 10)) (header-byte))
         (subbytes buffer 0 offset)]
        [else
         (when (= offset 8192) (error 'protocol "oversized header"))
         (bytes-set! buffer offset byte)
         (loop (add1 offset))])))
  (let loop ([headers 0])
    (define line (header-line))
    (cond
      [(eof-object? line) (if (zero? headers) eof (error 'protocol "truncated headers"))]
      [(bytes=? line #"")
       (unless (and (exact-nonnegative-integer? length) (<= length max-message))
         (error 'protocol "invalid Content-Length"))
       (define message (bytes->jsexpr (read-exactly length in)))
       (unless (hash? message) (error 'protocol "message must be a JSON object"))
       message]
      [else
       (when (> headers 32) (error 'protocol "oversized header"))
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
