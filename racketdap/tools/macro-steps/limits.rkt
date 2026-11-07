#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Bound expansion memory and JSON output, and report worker failures.
(require json)
(provide memory-limit call-with-memory-limit answer-text bounded-output
         exn:answer-size? exn:worker? exn:worker-code incompatible failure-answer)

(define memory-limit (* 1000 1024 1024))
(define answer-limit (* 64 1024 1024))

(struct exn:answer-size exn:fail ())
(struct exn:worker exn:fail (code))
(define (incompatible message)
  (raise (exn:worker message (current-continuation-marks) "incompatible")))
(define (bounded-output limit)
  (define storage (open-output-bytes))
  (define count 0)
  (define port
    (make-output-port
     'bounded always-evt
     (lambda (bytes start end _non-block? _breakable?)
       (define size (- end start))
       (when (> (+ count size) limit)
         (raise (exn:answer-size "Answer byte limit exceeded" (current-continuation-marks))))
       (set! count (+ count size))
       (write-bytes bytes storage start end)
       size)
     void))
  (values port (lambda () (get-output-bytes storage))))

(define (call-with-memory-limit limit work)
  (define custodian (make-custodian))
  (define alive (make-custodian-box custodian #t))
  (define result #f)
  (define completed? #f)
  (define failure #f)
  (dynamic-wind
    void
    (lambda ()
      (custodian-limit-memory custodian limit)
      (parameterize ([current-custodian custodian])
        (thread-wait
         (thread
          (lambda ()
            (with-handlers ([exn:fail:out-of-memory? void]
                            [exn? (lambda (e) (set! failure e))])
              (set! result (work))
              (set! completed? #t))))))
      (cond [failure (raise failure)]
            [(not (custodian-box-value alive)) #f]
            [(not completed?) (error "The expansion stopped before it finished.")]
            [else result]))
    (lambda () (custodian-shutdown-all custodian))))

(define (failure-answer code message)
  (hasheq 'failed message 'failureCode code))

(define (answer-text result [limit answer-limit])
  (with-handlers ([exn:answer-size?
                   (lambda (_) (jsexpr->string
                                (failure-answer "answer-size" "These macro steps are too long to show.")))]
                  [exn:fail? (lambda (_) (jsexpr->string (failure-answer "serialization" "Unable to serialize these macro steps.")))])
    (define-values (out content) (bounded-output limit))
    (write-json result out)
    (bytes->string/utf-8 (content))))
