#lang racket/base
(require json racket/port racket/runtime-path "../tool-worker.rkt" "module-dependencies.rkt")
(define-runtime-path self "dependency-worker.rkt")
(module+ main
  (run-tool-worker self
    (lambda (request)
      (define out (current-output-port))
      (define result
        (parameterize ([current-output-port (current-error-port)]
                       [current-input-port (open-input-string "")])
          (unless (equal? (hash-ref request 'version #f) 1) (error 'dependencies "Unsupported request version."))
          (module-dependencies (hash-ref request 'path) (hash-ref request 'buffers) (hash-ref request 'roots))))
      (write-json result out) (newline out) (flush-output out))))
