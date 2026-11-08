;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

(require rackunit racket/async-channel racket/list
         "../racketdap/tools/macro-steps/expansion.rkt"
         (submod "../racketdap/tools/macro-steps/expansion.rkt" test-support)
         "../racketdap/tools/macro-steps/limits.rkt")

(define stop-message "Macro expansion was stopped because it took too many steps.")
(define (fixture form drive)
  (define ns (make-base-namespace))
  (define (evaluate expression) (parameterize ([current-namespace ns]) (eval expression)))
  (evaluate '(require (for-syntax racket/base)))
  (evaluate '(begin-for-syntax (define effects 0)))
  (evaluate '(define-syntax (effect-count stx) (datum->syntax stx effects)))
  (evaluate '(define-syntax (forever stx)
               (set! effects (add1 effects)) #'(forever)))
  (evaluate '(define-syntax (countdown stx)
               (set! effects (add1 effects))
               (define n (syntax-e (cadr (syntax->list stx))))
               (if (zero? n) #'0 #`(countdown #,(sub1 n)))))
  (evaluate '(define-syntax (huge stx)
               (set! effects (add1 effects))
               #`(quote #,(make-string 1000000 #\x))))
  (define stx (parameterize ([current-namespace ns]) (namespace-syntax-introduce (datum->syntax #f form))))
  (define custodian (make-custodian))
  (define events (make-async-channel))
  (define decisions (make-channel))
  (define inspector #f)
  (define derivation #f)
  (define (next)
    (define event (sync/timeout 10 events))
    (unless event (error "Expansion did not reach the expected checkpoint or result."))
    (when (exn? event) (raise event))
    event)
  (dynamic-wind
    void
    (lambda ()
      (parameterize ([current-custodian custodian] [current-namespace ns] [current-step-checkpoint 16])
        (thread
         (lambda ()
           (with-handlers ([exn? (lambda (e) (async-channel-put events e))])
             (async-channel-put
              events
              (expansion-steps stx "none" #:schema-version 2
                               #:checkpoint (lambda (count)
                                              (async-channel-put events count)
                                              (channel-get decisions))
                               #:retain-derivation (lambda (d) (set! derivation d))
                               #:retain-inspector (lambda (q) (set! inspector q))))))))
      (drive next (lambda (choice)
                    (unless (sync/timeout 10 (channel-put-evt decisions choice))
                      (error "Expansion was not waiting for a decision.")))
             (lambda () (evaluate '(effect-count)))
             (lambda (position) (inspector (hasheq 'mode "position" 'position position 'panes #t)))
             (lambda (hiding one? rename?)
               (parameterize ([current-namespace ns])
                 (expansion-steps stx hiding #:schema-version 2 #:derivation derivation
                                  #:one-term? one? #:include-renaming? rename?
                                  #:checkpoint (lambda (_) (error "Recorded history restarted expansion.")))))))
    (lambda () (custodian-shutdown-all custodian))))

(define (check-stopped summary get completed)
  (check-false (hash-ref summary 'final))
  (check-equal? (hash-ref summary 'message) stop-message)
  (define steps (hash-ref summary 'steps))
  (check-equal? (length steps) (add1 completed))
  (check-true (andmap (lambda (step) (equal? (hash-ref step 'kind) "rewrite")) (take steps completed)))
  (check-true (andmap (lambda (step) (equal? (hash-ref step 'label) "Macro transformation")) (take steps completed)))
  (check-equal? (hash-ref (last steps) 'kind) "error")
  (check-equal? (hash-ref (last steps) 'label) "Error")
  (for ([position (list (add1 completed) (+ 2 completed))])
    (define answer (get position))
    (check-equal? (hash-ref answer 'final) 'null)
    (define diagnostic (hash-ref (hash-ref answer 'diagnostics) (string->symbol (hash-ref answer 'error))))
    (check-equal? (hash-ref diagnostic 'message) stop-message)
    (check-equal? (hash-ref diagnostic 'program) 'null)
    (check-equal? (hash-ref diagnostic 'syntax) null)
    (if (= position (add1 completed))
        (check-equal? (hash-ref (hash-ref answer 'record) 'after) 'null)
        (check-equal? (hash-ref answer 'record) 'null))))

(module+ test
  (test-case "the default checkpoint is 40,000 and a large single application needs no decision"
    (check-equal? (current-step-checkpoint) 40000)
    (fixture '(huge)
             (lambda (next decide effects get redraw)
               (define summary (next))
               (check-true (hash-ref summary 'final))
               (check-equal? (effects) 1)
               (define final (get (add1 (hash-ref summary 'stepCount))))
               (check-true (>= (string-length (hash-ref (hash-ref final 'final) 'text)) 1000000)))))

  (test-case "loop waits on entry, Continue retains transformer effects and doubles the next checkpoint"
    (fixture
     '(forever)
     (lambda (next decide effects get redraw)
       (check-equal? (next) 16)
       (check-equal? (effects) 15)
       (decide 'continue)
       (check-equal? (next) 32)
       (check-equal? (effects) 31)
       (decide 'stop)
       (define summary (next))
       (check-stopped summary get 31)
       (check-equal? (effects) 31)
       (for ([one? '(#f #t)] [expected '(32 63)])
         (define changed (redraw "none" one? #f))
         (check-equal? (hash-ref changed 'stepCount) expected)
         (check-equal? (hash-ref changed 'message) stop-message))
       (check-equal? (hash-ref (redraw "standard" #f #t) 'message) stop-message)
       (check-equal? (effects) 31))))

  (test-case "a long finite macro also checkpoints, then Continue completes the full expansion"
    (fixture
     '(countdown 25)
     (lambda (next decide effects get redraw)
       (check-equal? (next) 16)
       (check-equal? (effects) 15)
       (decide 'continue)
       (define summary (next))
       (check-true (hash-ref summary 'final))
       (check-equal? (hash-ref summary 'message) 'null)
       (check-equal? (effects) 26)
       (check-equal? (count (lambda (s) (equal? (hash-ref s 'macro) "countdown")) (hash-ref summary 'steps)) 26)
       (check-not-equal? (hash-ref (get (add1 (hash-ref summary 'stepCount))) 'final) 'null)
       (redraw "standard" #t #t)
       (check-equal? (effects) 26))))

  (test-case "Stop at the first checkpoint retains only completed rewrites"
    (for ([form '((forever) (countdown 25))])
      (fixture form (lambda (next decide effects get redraw)
                      (check-equal? (next) 16)
                      (decide 'stop)
                      (check-stopped (next) get 15)
                      (check-equal? (effects) 15)))))

  (test-case "resource ceilings keep their resource meanings"
    (check-equal? memory-limit (* 1000 1024 1024))
    ;; Run allocation pressure uninstrumented, as an expansion does. Debugger
    ;; marks can keep its values outside the limited custodian's accounting.
    (define namespace (make-base-namespace))
    (check-false (call-with-memory-limit (* 20 1024 1024)
                                       (lambda ()
                                         (eval '(let loop ([held null] [left 100])
                                                  (cond [(zero? left) (length held)]
                                                        [else (collect-garbage)
                                                              (loop (cons (make-bytes 1048576) held)
                                                                    (sub1 left))]))
                                               namespace))))
    (check-equal? (answer-text (hasheq 'text (make-string 1000 #\x)) 100)
                  "{\"failed\":\"These macro steps are too long to show.\",\"failureCode\":\"answer-size\"}")))
