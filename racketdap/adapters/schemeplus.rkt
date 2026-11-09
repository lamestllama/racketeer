#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/port)
(provide interactions)

;; The reader installs its interaction hook when instantiated. A fresh instance
;; per interaction keeps parser declarations and pragmas out of the programme.
(define (interactions request _data)
  (define text (hash-ref request 'text))
  (unless text (error 'Scheme+ "Native interactions require the module source."))
  (define enter (hash-ref (hash-ref request 'hooks) 'call-with-interaction-context))
  (hasheq
   'read-interaction (lambda (source in) ((current-read-interaction) source in))
   'call-with-interaction-context
   (lambda (thunk)
     (define reader
       (parameterize ([current-namespace (make-base-namespace)]
                      [current-read-interaction (current-read-interaction)]
                      [current-output-port (open-output-nowhere)]
                      [current-error-port (open-output-nowhere)]
                      [read-accept-reader #t] [read-accept-lang #t])
         (define in (open-input-string text))
         (port-count-lines! in)
         (read-syntax #f in)
         (current-read-interaction)))
     (enter (lambda () (parameterize ([current-read-interaction reader]) (thunk)))))))
