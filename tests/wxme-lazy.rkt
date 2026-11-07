#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/runtime-path racket/file json)
(define-runtime-path source "../racketdap/wxme-source.rkt")
(define-runtime-path fixtures "fixtures/wxme-debug")
(module+ test
  (test-case "plain text and near signatures do not load structured source readers"
    (define loaded '())
    (define load (current-load/use-compiled))
    (parameterize ([current-namespace (make-base-namespace)]
                   [current-load/use-compiled
                    (lambda (file name) (set! loaded (cons (path->string file) loaded)) (load file name))])
      (define text (dynamic-require source 'source-text))
      (for ([bytes '(#"#lang racket/base\r\n" #"\377" #"" #"WXME" #"WXME0108 ##"
                    #"WXME0108 ##\t" #" WXME0108 ## " #"WXME0208 ## "
                    #"#reader(lib\"read.ss\"\"wxme\")plain")])
        (check-equal? (text bytes) (bytes->string/utf-8 bytes #\uFFFD)))
      (check-false (ormap (lambda (file) (regexp-match? #rx"/(wxme|draw-lib)/" file)) loaded))
      ;; First use in a fresh namespace must retain both supported signatures
      ;; and the shared registry used by nested structured readers.
      (define bytes (file->bytes (build-path fixtures "objects.wxme")))
      (define expected (hash-ref (call-with-input-file (build-path fixtures "expected.json") read-json) 'objects))
      (check-equal? (text bytes) expected)
      (check-equal? (text (subbytes bytes (bytes-length #"#reader(lib\"read.ss\"\"wxme\")"))) expected))))
