#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Present failures of the step interpreter separately from expansion errors.
(require racket/pretty "answer.rkt")
(provide internal-error-answer)

(define (internal-error-answer stage value original events snapshot retain-inspector partition)
  (define interrupted? (exn:break? value))
  (define details? (exn? value))
  (define title (if interrupted? "Macro stepper was interrupted" "Macro stepper internal error"))
  (define heading
    (string-append (if interrupted? "Macro stepper was interrupted" "Macro stepper error")
                   (format " (~a)" stage) (if details? " [details]" "")
                   (if (eq? stage 'steps) ".  Original syntax:\n" ".  \n")))
  (define message (and details? (string-append "Internal error:\n" (exn-message value))))
  (define render #f)
  (define base
    (expansion-answer null (hasheq) (hasheq) (and (eq? stage 'steps) original) #f original snapshot null
                      #:partition partition #:retain-inspector (lambda (q) (set! render q))))
  (retain-inspector
   (lambda (query)
     (cond
       [(equal? (hash-ref query 'mode #f) "internalDetails")
        (unless details? (error "No exception details are available."))
        (define report (open-output-string))
        (parameterize ([current-error-port report]) ((error-display-handler) (exn-message value) value))
        (hasheq 'title title 'message message
                'report (get-output-string report)
                'diagnostic (and events
                                 (string-append ";; Recorded expansion events\n" (pretty-format events)
                                                "\n;; Error message\n" (pretty-format (exn-message value))
                                                "\n;; Stack context\n"
                                                (pretty-format (continuation-mark-set->context
                                                                (exn-continuation-marks value))) "\n")))]
       [(equal? (hash-ref query 'mode #f) "position")
        (define position (render query))
        (hash-set* position 'final 'null 'error "internal"
                   'diagnostics
                   (hasheq 'internal
                           (hasheq 'id "internal" 'kind "internal" 'stage (symbol->string stage)
                                   'message heading 'details details? 'title title
                                   'program (if (eq? stage 'steps) (hash-ref position 'final) 'null)
                                   'syntax null 'contexts null)))]
       [else (render query)])))
  (hash-set* base 'final #f 'error "internal" 'message heading))
