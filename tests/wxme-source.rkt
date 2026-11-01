#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/runtime-path json
         "../racketdap/wxme-source.rkt" "../racketdap/worker/load.rkt")
(define-runtime-path fixtures "fixtures/wxme-debug")
(define-runtime-path other-fixtures "fixtures/wxme")
(define expected (call-with-input-file (build-path fixtures "expected.json") read-json))
(module+ test
  (test-case "ordinary source retains its reader bytes as text"
    (check-equal? (source-text (string->bytes/utf-8 "#lang racket/base\r\nλ😀\t")) "#lang racket/base\r\nλ😀\t"))
  (for ([(name text) (in-hash expected)])
    (test-case (format "one source position per object: ~a" name)
      (check-equal? (source-text (file->bytes (build-path fixtures (format "~a.wxme" name)))) text)))
  (for ([name '("custom" "nested-custom")])
    (test-case (format "refuse document-supplied reader: ~a" name)
      (check-exn #rx"Unsupported WXME object classes"
                 (lambda () (source-text (file->bytes (build-path other-fixtures (string-append name ".wxme"))))))))
  (test-case "WXME snapshot and execution share bytes even if callbacks replace the source"
    (define directory (make-temporary-file "wxme-source-~a" 'directory))
    (dynamic-wind void
      (lambda ()
        (define file (build-path directory "source.rkt"))
        (copy-file (build-path fixtures "objects.wxme") file)
        (define snapshot #f)
        (define output (open-output-string))
        (parameterize ([current-output-port output])
          (run-module file
            #:on-source (lambda (path) (display-to-file "#lang racket/base\n(error 'replacement)\n" path #:exists 'truncate/replace))
            #:on-source-snapshot (lambda (_path text) (set! snapshot text))))
        (check-equal? snapshot (hash-ref expected 'objects))
        (check-true (immutable? snapshot))
        (check-equal? (get-output-string output) "42\n"))
      (lambda () (delete-directory/files directory)))))
