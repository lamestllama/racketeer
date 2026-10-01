#lang racket/base
(require file/convertible net/base64)
(provide image-value? render-image)

;; Detect the protocol without invoking a value's converter or wrapper hooks.
(define (image-value? value)
  (and (not (impersonator? value)) (convertible? value)))

;; Conversion runs only on explicit request, inside the existing cancellable
;; evaluation on the value's owning thread.
(define (render-image value)
  (unless (image-value? value)
    (error 'image "This value does not support image conversion."))
  (define data (convert value 'png-bytes #f))
  (unless (and (bytes? data) (>= (bytes-length data) 8)
               (bytes=? (subbytes data 0 8) #"\211PNG\r\n\032\n"))
    (error 'image "This value does not provide a PNG image."))
  ;; Leave room for base64 and JSON framing within the protocol's 16 MiB limit.
  (when (> (bytes-length data) (* 8 1024 1024))
    (error 'image "The PNG exceeds the 8 MiB preview limit."))
  (hasheq 'mimeType "image/png"
          'data (bytes->string/latin-1 (base64-encode data #""))))
