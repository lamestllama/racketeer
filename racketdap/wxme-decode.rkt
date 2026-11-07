#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/port wxme "wxme-readers.rkt")
(provide wxme-source-text)

(define (wxme-source-text bytes)
  ;; Reader interfaces and dynamically loaded readers must share a registry,
  ;; even when a snapshot is requested inside the debuggee's fresh namespace.
  (call-with-wxme-readers (lambda () (decode-source-text bytes))))

(define (decode-source-text bytes)
  (cond
    [(is-wxme-stream? (open-input-bytes bytes))
     (check-wxme-readers! bytes)
     ;; A snip occupies one position in the reader's outer source. Replacing
     ;; it with one BMP character preserves positions without flattening its
     ;; nested contents or invoking its readable<%> method. This is display
     ;; text only; execution always receives the original bytes.
     (define input (wxme-port->port (open-input-bytes bytes) #t (lambda (_snip) #\uFFFC)))
     (define out (open-output-string))
     (dynamic-wind void
       (lambda ()
         (let loop ([size 0])
           (define c (read-char-or-special input))
           (unless (eof-object? c)
             (define next (+ size (char-utf-8-length c)))
             (when (> next (* 32 1024 1024)) (error 'wxme "Decoded source exceeds 32 MiB."))
             (write-char c out) (loop next))))
       (lambda () (close-input-port input)))
     (get-output-string out)]
    [else (bytes->string/utf-8 bytes #\uFFFD)]))
