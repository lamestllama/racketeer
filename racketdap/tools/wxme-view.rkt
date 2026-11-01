#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require file/sha1 json net/base64 racket/class racket/draw racket/list racket/port
         wxme wxme/image wxme/editor wxme/comment
         (only-in wxme/xml xml-editor%) (only-in wxme/scheme scheme-editor%)
         "../wxme-readers.rkt")

(provide decode-wxme)

(define limit (* 32 1024 1024))
(define (unsupported label) (hasheq 'kind "unsupported" 'label label))

(define (image-part image)
  (define bitmap (send image get-bitmap))
  (cond
    [(send image get-filename) (unsupported "Linked image (not displayed)")]
    [(not (and bitmap (send bitmap ok?))) (unsupported "Image data unavailable")]
    [else
     (define (dimension requested actual)
       (define n (if (negative? requested) actual requested))
       (unless (and (real? n) (<= 1 n 4096))
         (error 'wxme "Image dimensions exceed the viewer limit (4096 pixels)."))
       (inexact->exact (ceiling n)))
     (define width (dimension (send image get-w) (send bitmap get-width)))
     (define height (dimension (send image get-h) (send bitmap get-height)))
     (define rendered (make-bitmap width height))
     (define dc (new bitmap-dc% [bitmap rendered]))
     (unless (send dc draw-bitmap-section bitmap 0 0
                   (send image get-dx) (send image get-dy) width height
                   'solid (make-object color% "black") (send image get-bitmap-mask))
       (error 'wxme "Cannot render embedded image."))
     (send dc set-bitmap #f)
     (define out (open-output-bytes))
     (unless (send rendered save-file out 'png) (error 'wxme "Cannot encode image."))
     (define data (get-output-bytes out))
     (when (> (bytes-length data) (* 8 1024 1024))
       (error 'wxme "Embedded image exceeds the viewer limit (8 MiB)."))
     (hasheq 'kind "image" 'width width 'height height
             'data (bytes->string/utf-8 (base64-encode data #"")))]))

(define (decode-wxme bytes)
  (call-with-wxme-readers (lambda () (decode-content bytes))))

(define (decode-content bytes)
  (when (> (bytes-length bytes) limit) (error 'wxme "File exceeds the viewer limit (32 MiB)."))
  (unless (is-wxme-stream? (open-input-bytes bytes))
    (error 'wxme "This is not a WXME document. Use the Text Editor to view ordinary source."))
  (check-wxme-readers! bytes)
  ;; Wrapping specials prevents the codec from invoking readable<%> methods.
  (define count 0)
  (define size 0)
  (define (charge! n)
    (set! size (+ size n))
    (when (> size limit) (error 'wxme "Decoded content exceeds the viewer limit (32 MiB).")))
  (define (read-parts in depth)
    (when (> depth 32) (error 'wxme "Nested editors exceed the viewer limit (32 levels)."))
    (define text (open-output-string))
    (define parts '())
    (define (push! part)
      (when (>= count 10000) (error 'wxme "Too many embedded objects."))
      (set! count (add1 count))
      (set! parts (cons part parts)))
    (define (flush-text!)
      (define s (get-output-string text))
      (unless (equal? s "") (push! (hasheq 'kind "text" 'text s)))
      (set! text (open-output-string)))
    (let loop ()
      (define v (read-char-or-special in))
      (cond
        [(eof-object? v) (flush-text!)]
        [(char? v) (charge! (char-utf-8-length v)) (write-char v text) (loop)]
        [else
         (flush-text!)
         (define object (vector-ref v 0))
         (define part
           (cond [(is-a? object image%) (image-part object)]
                 [(is-a? object editor%)
                  (define nested (read-parts (send object get-content-port) (add1 depth)))
                  (cond [(or (is-a? object xml-editor%) (is-a? object scheme-editor%))
                         (define mode (send object get-data))
                         (unless (boolean? mode) (error 'wxme "Invalid XML or Racket box mode."))
                         (if (is-a? object xml-editor%)
                             (hasheq 'kind "xml" 'eliminateWhitespace mode 'parts nested)
                             (hasheq 'kind "racket" 'splicing mode 'parts nested))]
                        [else (hasheq 'kind (if (is-a? object comment-editor%) "comment" "editor") 'parts nested)])]
                 [else (unsupported "Embedded object (not displayed)")]))
         (charge! (string-length (hash-ref part 'data "")))
         (push! part)
         (loop)]))
    (close-input-port in)
    (reverse parts))
  (hasheq 'parts (read-parts (wxme-port->port (open-input-bytes bytes) #t vector) 0)
          'sourceHash (bytes->hex-string (sha256-bytes bytes))))

(module+ main
  (with-handlers ([exn:fail? (lambda (e) (write-json (hasheq 'error (exn-message e))) (newline) (exit 1))])
    (define request (read-json (open-input-string (read-line))))
    ;; The extension keeps stdin open as a lease, including during decoding.
    (thread (lambda () (sync (current-input-port)) (exit 0)))
    (define bytes
      (call-with-input-file (hash-ref request 'path)
        (lambda (in) (read-bytes (add1 limit) in))))
    (write-json (decode-wxme (if (eof-object? bytes) #"" bytes)))
    (newline)))
