#lang racket/base
(require json net/base64 racket/runtime-path "wxme-view.rkt")
(define-runtime-path codec "wxme-codec.rkt")

(module+ main
  (with-handlers ([exn:fail? (lambda (e) (write-json (hasheq 'error (exn-message e))) (newline) (exit 1))])
    (define request (read-json (open-input-string (read-line))))
    (thread (lambda () (sync (current-input-port)) (exit 0)))
    (unless (equal? (hash-ref request 'version #f) 1) (error 'wxme "Unsupported codec protocol version."))
    (define bytes (and (hash-has-key? request 'bytes)
                       (base64-decode (string->bytes/utf-8 (hash-ref request 'bytes)))))
    (when bytes (void (decode-wxme bytes)))
    (define encode
      (with-handlers ([exn:fail? (lambda (e) (error 'wxme "Editing requires Racket GUI libraries and a working display: ~a" (exn-message e)))])
        (dynamic-require codec 'encode-wxme)))
    (define-values (encoded result)
      (encode bytes (hash-ref request 'tree #f) (hash-ref request 'image #f)))
    (write-json (hash-set (hash-set result 'version 1) 'bytes (bytes->string/utf-8 (base64-encode encoded #""))))
    (newline)
    (exit)))
