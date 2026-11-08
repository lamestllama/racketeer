#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/lazy-require)
(provide source-text)
(lazy-require ["wxme-decode.rkt" (wxme-source-text)])

(define (source-text bytes)
  ;; Match the two signatures accepted by wxme's is-wxme-stream? without
  ;; initializing its readers and drawing libraries for ordinary source.
  (if (regexp-match? #rx#"^(?:#reader[(]lib\"read[.]ss\"\"wxme\"[)])?WXME01[0-9][0-9] ##[ \r\n]" bytes)
      (wxme-source-text bytes)
      (bytes->string/utf-8 bytes #\uFFFD)))
