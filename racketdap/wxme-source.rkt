#lang racket/base
(require racket/list racket/port wxme)
(provide source-text check-wxme-readers!)
(define-namespace-anchor anchor)

;; Share the supported reader boundary with the viewer. Never instantiate a
;; document-supplied reader while constructing a source snapshot.
(define (check-wxme-readers! bytes)
  (when (> (bytes-length bytes) (* 32 1024 1024)) (error 'wxme "File exceeds 32 MiB."))
  (define-values (snips data) (extract-used-classes (open-input-bytes bytes)))
  (define unknown
    (filter (lambda (name)
              (not (or (member name '("wxtext" "wxtab" "wximage" "wxmedia"))
                       (member (string->lib-path name #f)
                               '((lib "comment.ss" "wxme") (lib "comment.rkt" "wxme"))))))
            snips))
  (unless (and (null? unknown) (null? data))
    (error 'wxme "Unsupported WXME object classes: ~a. The file has not been changed."
           (append unknown data))))

(define (source-text bytes)
  ;; Reader interfaces and dynamically loaded readers must share a registry,
  ;; even when a snapshot is requested inside the debuggee's fresh namespace.
  (parameterize ([current-namespace (namespace-anchor->namespace anchor)])
    (decode-source-text bytes)))

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
