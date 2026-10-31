#lang racket/base
(require net/base64 "images.rkt" "inspect.rkt")
(provide interaction-output-port)

;; Keep the terminal stream while sending ordered rich output to the editor.
;; Bytes are decoded incrementally by the receiver, including split UTF-8 writes.
(define (interaction-output-port original category emit)
  (define port
    (make-output-port
     (object-name original) always-evt
     (lambda (bytes start end _non-block? _breakable?)
       (if (= start end)
           (begin (flush-output original) 0)
           (let ([count (min 4096 (- end start))])
             (write-bytes bytes original start (+ start count))
             (emit (hasheq 'category category
                           'data (bytes->string/latin-1
                                  (base64-encode (subbytes bytes start (+ start count)) #""))))
             count)))
     void))
  (define default-print (port-print-handler original))
  (port-print-handler
   port
   (lambda (value out [mode 0])
     (if (image-value? value)
         (with-handlers ([exn:fail?
                          (lambda (error)
                            (emit (hasheq 'category "stderr"
                                          'text (format "~a — image preview unavailable: ~a\n"
                                                        (value-preview value) (exn-message error)))))])
           (emit (hash-set (render-image value) 'category "image")))
         (default-print value out mode))))
  port)
