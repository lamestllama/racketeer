#lang racket/base
(require racket/class racket/gui/base racket/list racket/string net/base64 wxme framework "wxme-view.rkt" "wxme-editable.rkt" "wxme-xml.rkt")
(provide encode-wxme)

(struct source (part editor start snip) #:transparent)
(define limit (* 32 1024 1024))
(define (normalize parts)
  (let loop ([rest parts] [text ""])
    (cond [(null? rest) (list (hasheq 'kind "text" 'text text))]
          [(equal? (hash-ref (car rest) 'kind) "text") (loop (cdr rest) (string-append text (hash-ref (car rest) 'text)))]
          [else (list* (hasheq 'kind "text" 'text text) (car rest) (loop (cdr rest) ""))])))
(define (utf16-position text wanted)
  (unless (exact-nonnegative-integer? wanted) (error 'wxme "Invalid UTF-16 position."))
  (let loop ([position 0] [units 0])
    (cond [(= wanted units) position]
          [(or (> units wanted) (= position (string-length text))) (error 'wxme "Text span splits a Unicode character or is out of range.")]
          [else (loop (add1 position) (+ units (if (> (char->integer (string-ref text position)) #xffff) 2 1)))])))
(define (png-snip data)
  (define bytes (base64-decode (string->bytes/utf-8 data)))
  (unless (and (<= 8 (bytes-length bytes) (* 8 1024 1024))
               (bytes=? (subbytes bytes 0 8) #"\211PNG\r\n\32\n"))
    (error 'wxme "Choose a PNG image no larger than 8 MiB."))
  (define bitmap (read-bitmap (open-input-bytes bytes) 'png/alpha))
  (unless (and (send bitmap ok?) (<= 1 (send bitmap get-width) 4096) (<= 1 (send bitmap get-height) 4096))
    (error 'wxme "Image dimensions exceed 4096 pixels."))
  (make-object image-snip% bitmap))

(define (encode-wxme bytes tree image)
  (register-xml-boxes!)
  (define decoded (and bytes (decode-wxme bytes)))
  (when decoded
    (check-editable-content! (hash-ref decoded 'parts))
    (define-values (classes data) (extract-used-classes (open-input-bytes bytes)))
    (define comment-class (send (send (new comment-box:snip%) get-snipclass) get-classname))
    (unless (for/and ([name (in-list classes)])
              (or (member name '("wxtext" "wxtab" "wximage" "wxmedia")) (member name xml-box-classnames) (equal? name comment-class)))
      (error 'wxme "Unsupported object class for WXME editing.")))
  (define original (new text%))
  (when bytes
    ;; Every supported GUI class is registered before loading. Nested streams
    ;; must not load a different GUI reader paired with an allowed text reader.
    (define resolve (current-module-name-resolver))
    (parameterize ([current-module-name-resolver
                    (case-lambda
                      [(path namespace) (resolve path namespace)]
                      [(path relative syntax load?) (error 'wxme "Unsupported GUI object reader: ~s" path)])])
      (send original insert-port (open-input-bytes bytes) 'standard)))
  (define sources (make-hash))
  (define (index! editor parts prefix)
    (define position 0)
    (for ([part (in-list (normalize parts))] [index (in-naturals)])
      (define path (append prefix (list index)))
      (define key (string-join (map number->string path) "/"))
      (define text? (equal? (hash-ref part 'kind) "text"))
      (define snip (and (not text?) (send editor find-snip position 'after-or-none)))
      (hash-set! sources key (source part editor position snip))
      (cond [text?
             (define text (hash-ref part 'text))
             (unless (equal? text (send editor get-text position (+ position (string-length text)))) (error 'wxme "Original text positions do not match."))
             (set! position (+ position (string-length text)))]
            [else
             (unless (and snip (= (send editor get-snip-position snip) position) (= (send snip get-count) 1)) (error 'wxme "Original object positions do not match."))
             (when (hash-has-key? part 'parts) (index! (send snip get-editor) (hash-ref part 'parts) path))
             (set! position (add1 position))]))
    (unless (= position (send editor last-position)) (error 'wxme "Original document length does not match.")))
  (when decoded (index! original (hash-ref decoded 'parts) '()))
  (define seen (make-hash))
  (define count 0)
  (define pieces 0)
  (define size 0)
  (define (charge! n) (set! size (+ size n)) (when (> size limit) (error 'wxme "Document content exceeds 32 MiB.")))
  (define (lookup id kind)
    (define found (hash-ref sources id (lambda () (error 'wxme "Unknown original content reference."))))
    (unless (equal? (hash-ref (source-part found) 'kind) kind) (error 'wxme "Original content type does not match."))
    found)
  (define (copy-span! target piece)
    (set! pieces (add1 pieces))
    (when (> pieces 100000) (error 'wxme "Too many text spans."))
    (cond [(hash-has-key? piece 'text)
           (define text (hash-ref piece 'text))
           (charge! (bytes-length (string->bytes/utf-8 text)))
           (send target insert text (send target last-position))]
          [else
           (define ref (lookup (hash-ref piece 'source) "text"))
           (define text (hash-ref (source-part ref) 'text))
           (define start (utf16-position text (hash-ref piece 'start)))
           (define end (utf16-position text (hash-ref piece 'end)))
           (unless (<= start end) (error 'wxme "Invalid text span."))
           (charge! (bytes-length (string->bytes/utf-8 (substring text start end))))
           (define from (+ (source-start ref) start))
           (define to (+ (source-start ref) end))
           (define editor (source-editor ref))
           (send editor split-snip from) (send editor split-snip to)
           (let loop ([position from])
             (when (< position to)
               (define snip (send editor find-snip position 'after-or-none))
               (unless (and snip (or (is-a? snip string-snip%) (is-a? snip tab-snip%)) (positive? (send snip get-count))
                            (<= (+ position (send snip get-count)) to)) (error 'wxme "Cannot copy original text span."))
               (send target insert (send snip copy) (send target last-position))
               (loop (+ position (send snip get-count)))))]))
  (define (fill! target nodes depth)
    (unless (and (<= depth 32) (list? nodes) (positive? (length nodes)) (odd? (length nodes))) (error 'wxme "Invalid editor structure (maximum 32 levels)."))
    (send target erase)
    (for ([node (in-list nodes)] [index (in-naturals)])
      (set! count (add1 count))
      (when (> count 10000) (error 'wxme "Document exceeds 10000 elements."))
      (define id (hash-ref node 'id))
      (unless (and (string? id) (<= (string-length id) 128) (not (hash-has-key? seen id))) (error 'wxme "Invalid or duplicate element identity."))
      (hash-set! seen id #t)
      (define kind (hash-ref node 'kind))
      (unless (equal? (even? index) (equal? kind "text")) (error 'wxme "Text and object boundaries must alternate."))
      (cond [(equal? kind "text") (for ([piece (in-list (hash-ref node 'pieces))]) (copy-span! target piece))]
            [else
             (unless (member kind '("image" "editor" "comment" "xml" "racket")) (error 'wxme "Unsupported object type."))
             (define box? (member kind '("xml" "racket")))
             (define mode (and box? (hash-ref node (if (equal? kind "xml") 'eliminateWhitespace 'splicing))))
             (when (and box? (not (boolean? mode))) (error 'wxme "Invalid XML or Racket box mode."))
             (define origin (hash-ref node 'source #f))
             (define object
               (cond [origin
                      (define ref (lookup origin kind))
                      (when (equal? kind "image") (charge! (string-length (hash-ref (source-part ref) 'data))))
                      (send (source-snip ref) copy)]
                     [(equal? kind "image") (charge! (string-length (hash-ref node 'data))) (png-snip (hash-ref node 'data))]
                     [(equal? kind "comment") (new comment-box:snip%)]
                     [box? (new xml-box-snip% [kind kind] [mode mode])]
                     [else (make-object editor-snip% (new text%))]))
             (when box? (send object set-box-mode mode))
             (when (member kind '("editor" "comment" "xml" "racket")) (fill! (send object get-editor) (hash-ref node 'parts) (add1 depth)))
             (send target insert object (send target last-position))])))
  (define target (send original copy-self))
  (cond [image (send target erase) (send target insert (png-snip image))]
        [tree (fill! target tree 0)])
  (define out (open-output-bytes))
  (send target save-port out 'standard)
  (define encoded (get-output-bytes out))
  (define checked (decode-wxme encoded))
  (when (and decoded (not tree) (not image) (not (equal? (hash-ref decoded 'parts) (hash-ref checked 'parts))))
    (error 'wxme "The codec did not preserve this document. Editing is unavailable."))
  (values encoded checked))
