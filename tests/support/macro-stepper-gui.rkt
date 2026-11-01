#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Acceptance through public GUI APIs only. No macro-debugger internals.
(require json racket/class racket/gui/base racket/string
         "../../racketdap/tools/macro-stepper.rkt")

(define request (read-json))
(open-macro-stepper request)
(define (descendants window)
  (cons window (if (is-a? window area-container<%>)
                   (append-map descendants (send window get-children)) '())))
(define (append-map f xs) (apply append (map f xs)))
(define (widgets) (append-map descendants (get-top-level-windows)))
(define (text)
  (string-join
   (for/list ([widget (widgets)] #:when (is-a? widget editor-canvas%))
     (send (send widget get-editor) get-text)) "\n"))
(define (until predicate)
  (define deadline (+ (current-inexact-monotonic-milliseconds) 15000))
  (let loop ()
    (or (predicate)
        (begin
          (when (> (current-inexact-monotonic-milliseconds) deadline)
            (error 'acceptance "Timed out waiting for visible macro-stepper content: ~s" (text)))
          (sleep/yield 0.05)
          (loop)))))
(void (until (lambda () (not (string=? (text) "")))))
(define before (text))
(define end-button
  (for/first ([widget (widgets)]
              #:when (and (is-a? widget button%)
                          (let ([label (send widget get-label)])
                            (and (list? label) (equal? (cadr label) "End")))))
    widget))
(when (and end-button (send end-button is-enabled?))
  (send end-button command (new control-event% [event-type 'button]))
  (void (until (lambda () (not (equal? before (text)))))))
(define result (hasheq 'before before 'after (text)
                        'labels (map (lambda (w) (send w get-label)) (get-top-level-windows))))
(for ([window (get-top-level-windows)]) (send window on-close) (send window show #f))
(wait-for-macro-stepper)
(write-json result)
(newline)
(exit 0)
