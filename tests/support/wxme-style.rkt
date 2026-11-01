#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/class racket/gui/base json net/base64 framework "../../racketdap/tools/wxme-xml.rkt")
(register-xml-boxes!)

;; Original fixture and inspection through public editor and style APIs.
(define editor (new text%))
(case (string->symbol (vector-ref (current-command-line-arguments) 0))
  [(create create-comment)
   (send editor insert "A😀\tBC\n")
   (send editor change-style (make-object style-delta% 'change-bold) 1 4)
   (when (equal? (vector-ref (current-command-line-arguments) 0) "create-comment")
     (define comment (new comment-box:snip%))
     (send (send comment get-editor) insert "😀\tB")
     (send (send comment get-editor) change-style (make-object style-delta% 'change-bold) 0 3)
     (send editor erase)
     (send editor insert comment))
   (define out (open-output-bytes))
   (send editor save-port out 'standard)
   (write-json (bytes->string/utf-8 (base64-encode (get-output-bytes out) #"")))]
  [(inspect)
   (send editor insert-port (open-input-bytes (base64-decode (string->bytes/utf-8 (read-json)))) 'standard)
   (define (inspect editor)
     (for/list ([position (in-range (send editor last-position))])
       (define snip (send editor find-snip position 'after-or-none))
       (if (is-a? snip editor-snip%)
           (hasheq 'parts (inspect (send snip get-editor)))
           (hasheq 'text (send editor get-text position (add1 position))
                   'weight (symbol->string (send (send snip get-style) get-weight))))))
   (write-json (inspect editor))])
(newline)
(exit 0)
