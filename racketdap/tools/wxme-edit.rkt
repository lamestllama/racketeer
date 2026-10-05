#lang racket/base

(require json net/base64 racket/port racket/runtime-path "wxme-view.rkt")

;; The GUI codec is loaded only after the input lease is established. No windows
;; are created, and source content is never read as Racket expressions.
(module codec racket/base
  (require racket/class racket/gui/base racket/list wxme framework
           "wxme-view.rkt")
  (provide encode-wxme)
  (define (normalize parts)
    (let loop ([rest parts] [text ""])
      (cond [(null? rest) (list (hasheq 'kind "text" 'text text))]
            [(equal? (hash-ref (car rest) 'kind) "text")
             (loop (cdr rest) (string-append text (hash-ref (car rest) 'text)))]
            [else (cons (hasheq 'kind "text" 'text text)
                        (cons (car rest) (loop (cdr rest) "")))])))
  (define (encode-wxme bytes edits)
    (define decoded (decode-wxme bytes))
    (define-values (classes data) (extract-used-classes (open-input-bytes bytes)))
    (define comment-class (send (send (new comment-box:snip%) get-snipclass) get-classname))
    ;; GUI and headless readers are separate class mappings. Validate both before
    ;; the GUI reader sees any document bytes.
    (unless (for/and ([name (in-list classes)])
              (or (member name '("wxtext" "wxtab" "wximage" "wxmedia"))
                  (equal? name comment-class)))
      (error 'wxme "Unsupported object class for WXME editing."))
    (define replacements (make-hash))
    (define edit-size 0)
    (for ([edit (in-list edits)])
      (define path (hash-ref edit 'path))
      (define text (hash-ref edit 'text))
      (unless (and (list? path) (pair? path) (<= (length path) 33)
                   (andmap exact-nonnegative-integer? path) (string? text)
                   (not (hash-has-key? replacements path)))
        (error 'wxme "Invalid or duplicate text edit."))
      (set! edit-size (+ edit-size (bytes-length (string->bytes/utf-8 text))))
      (when (> edit-size (* 32 1024 1024)) (error 'wxme "Edited text exceeds 32 MiB."))
      (hash-set! replacements path text))
    (define editor (new text%))
    (send editor insert-port (open-input-bytes bytes) 'standard)
    (define (apply-parts! editor parts prefix)
      (define position 0)
      (define operations '())
      (for ([part (in-list (normalize parts))] [index (in-naturals)])
        (define path (append prefix (list index)))
        (define kind (hash-ref part 'kind))
        (cond
          [(equal? kind "text")
           (define old (hash-ref part 'text))
           (define end (+ position (string-length old)))
           (unless (equal? old (send editor get-text position end))
             (error 'wxme "Text positions do not match the decoded document."))
           (when (hash-has-key? replacements path)
             (define text (hash-ref replacements path))
             (hash-remove! replacements path)
             ;; Retain styles outside the smallest changed range.
             (define common
               (let loop ([n 0])
                 (if (and (< n (min (string-length old) (string-length text)))
                          (char=? (string-ref old n) (string-ref text n)))
                     (loop (add1 n)) n)))
             (define suffix
               (let loop ([n 0])
                 (if (and (< n (- (min (string-length old) (string-length text)) common))
                          (char=? (string-ref old (- (string-length old) n 1))
                                  (string-ref text (- (string-length text) n 1))))
                     (loop (add1 n)) n)))
             (set! operations
                   (cons (list (+ position common) (- end suffix)
                               (substring text common (- (string-length text) suffix))) operations)))
           (set! position end)]
          [else
           (define snip (send editor find-snip position 'after-or-none))
           (unless (and snip (= (send editor get-snip-position snip) position)
                        (= (send snip get-count) 1))
             (error 'wxme "Embedded object positions do not match."))
           (cond [(member kind '("editor" "comment"))
                  (unless (is-a? snip editor-snip%) (error 'wxme "Expected nested editor."))
                  (apply-parts! (send snip get-editor) (hash-ref part 'parts) path)]
                 [(not (equal? kind "image"))
                  (error 'wxme "This document contains an object that cannot be edited safely.")])
           (set! position (add1 position))]))
      (unless (= position (send editor last-position)) (error 'wxme "Document length does not match."))
      (for ([op (in-list operations)])
        (send editor insert (caddr op) (car op) (cadr op))))
    (apply-parts! editor (hash-ref decoded 'parts) '())
    (unless (zero? (hash-count replacements)) (error 'wxme "Unknown text edit location."))
    (define out (open-output-bytes))
    (send editor save-port out 'standard)
    (define result (get-output-bytes out))
    ;; Recheck the output limits and supported structure before returning bytes.
    (define checked (decode-wxme result))
    (when (and (null? edits) (not (equal? (hash-ref decoded 'parts) (hash-ref checked 'parts))))
      (error 'wxme "The codec did not preserve this document. Editing is unavailable."))
    (values result checked)))

(define-runtime-module-path codec-module (submod "." codec))

(module+ main
  (with-handlers ([exn:fail? (lambda (e) (write-json (hasheq 'error (exn-message e))) (newline) (exit 1))])
    (define request (read-json (open-input-string (read-line))))
    (thread (lambda () (sync (current-input-port)) (exit 0)))
    (define bytes (base64-decode (string->bytes/utf-8 (hash-ref request 'bytes))))
    (void (decode-wxme bytes))
    (define encode-wxme
      (with-handlers ([exn:fail? (lambda (e)
                                 (error 'wxme "Editing requires Racket GUI libraries and a working display: ~a" (exn-message e)))])
        (dynamic-require codec-module 'encode-wxme)))
    (define-values (encoded result) (encode-wxme bytes (hash-ref request 'edits '())))
    (write-json (hash-set result 'bytes (bytes->string/utf-8 (base64-encode encoded #""))))
    (newline)
    (exit)))
