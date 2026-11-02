#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/runtime-path racket/file
         "../racketdap/worker/load.rkt"
         "../racketdap/worker/stepping.rkt"
         "../racketdap/instrumentation/instrument.rkt")

(define-runtime-path target "fixtures/instrumentation-marks.rkt")
(define (execute entry instrument? [on-event #f])
  (call-with-values
   (lambda () (run-module target #:entry entry #:instrument? instrument?
                         #:on-event on-event))
   list))
(define (outer-mark? descriptor)
  (define expression (site-expression descriptor))
  (and (pair? expression)
       (eq? (car expression) 'with-continuation-mark)
       (equal? (caddr expression) '(quote outer))))
(define (collect-target instrument?)
  (define references #f)
  (run-module target #:entry 'nested/non-tail #:instrument? instrument?
              #:on-ready
              (lambda (namespace)
                (set! references
                      (list (make-weak-box namespace)
                            (make-weak-box (namespace-module-registry namespace))))))
  references)
(define (register-target context)
  (define namespace (make-base-namespace))
  (eval `(module registration racket/base
           (provide reference context)
           (define context (quote ,context))
           (define reference (#%variable-reference)))
        namespace)
  (define reference
    (parameterize ([current-namespace namespace])
      (dynamic-require ''registration 'reference)))
  (register-module-context! context reference '())
  (define module-namespace (variable-reference->namespace reference))
  (list (make-weak-box module-namespace)
        (make-weak-box (namespace-module-registry module-namespace))))
(define (collect-repeatedly)
  (for ([i (in-range 6)]) (collect-garbage)))

(module+ test
  (test-case "nested marks preserve the program's continuation boundaries"
    (for ([entry '(nested/non-tail nested/tail separate-continuations)]
          [expected '((((2))) ((2)) (((2 1))))])
      (check-equal? (execute entry #f) expected)
      (check-equal? (execute entry #t) expected)
      (define deliveries 0)
      (check-equal? (execute entry #t (lambda (_s) (set! deliveries (add1 deliveries))))
                    expected)
      (check-true (positive? deliveries))))

  (test-case "marked compound tail paths share the original continuation"
    (check-equal? (execute 'compound-path #f) '((2)))
    (check-equal? (execute 'compound-path #t void) '((2))))

  (test-case "marked bodies preserve value counts and key/value evaluation order"
    (for ([entry '(values-result zero-result evaluation-order)]
          [expected '(((2) second)
                      ()
                      (((2) (outer-key outer-value inner-key inner-value body))))])
      (check-equal? (execute entry #f) expected)
      (check-equal? (execute entry #t void) expected)))

  (test-case "marked tail recursion keeps bounded debugger frames and user marks"
    (define max-depth 0)
    (define deliveries 0)
    (check-equal?
     (execute 'marked-loop #t
              (lambda (stop)
                (set! deliveries (add1 deliveries))
                (set! max-depth (max max-depth (stop-frame-count stop)))))
     (execute 'marked-loop #f))
    (check-true (> deliveries 5000))
    (check-true (<= max-depth 3)))

  (test-case "marked tail sites skip values and their enclosing completion replaces them"
    (define enclosing-token #f)
    (define skipped? #f)
    (define replaced? #f)
    (check-equal?
     (execute
      'controlled-values #t
      (lambda (stop)
        (define descriptor (stop-site stop))
        (cond
          [(outer-mark? descriptor)
           (cond
             [(eq? (stop-kind stop) 'before)
              (set! enclosing-token (stop-token stop))
              (check-not-false enclosing-token)]
             [else
              (check-eq? (stop-token stop) enclosing-token)
              (check-equal? (stop-results stop) '(7 8))
              (stop-replace-results! stop '(9 10))
              (set! replaced? #t)])]
          [(equal? (site-expression descriptor) '(#%app values '1 '2))
           (check-equal? (site-phases descriptor) '(before))
           (check-eq? (stop-kind stop) 'before)
           (check-false (stop-token stop))
           (check-eq? (car (stop-contexts stop)) enclosing-token)
           (stop-skip! stop '(7 8))
           (set! skipped? #t)])))
     '((9 10)))
    (check-true skipped?)
    (check-true replaced?))

  (test-case "step out from a marked tail call follows its enclosing completion"
    (define command #f)
    (define returned? #f)
    (check-equal?
     (execute
      'marked-call #t
      (lambda (stop)
        (cond
          [(and command (step-reason command stop))
           (check-equal? (step-reason command stop) "Expression returned")
           (check-true (outer-mark? (stop-site stop)))
           (check-equal? (stop-results stop) '(5))
           (set! command #f)
           (set! returned? #t)]
          [(and (not returned?) (eq? (stop-kind stop) 'before)
                (equal? (site-expression (stop-site stop)) '(#%app + value '1)))
           (set! command (make-step 'stepOut stop))])))
     '(5))
    (check-true returned?))

  (test-case "completed target namespaces collect with and without instrumentation"
    (define ordinary (collect-target #f))
    (define instrumented (collect-target #t))
    ;; One expansion context may outlive an individual execution registry.
    (define retained-context (make-module-binding-context #f 'retained-context))
    (define registered (register-target 'retained-context))
    (collect-repeatedly)
    (for ([reference (in-list ordinary)]) (check-false (weak-box-value reference)))
    (for ([reference (in-list instrumented)]) (check-false (weak-box-value reference)))
    (for ([reference (in-list registered)]) (check-false (weak-box-value reference)))
    (check-equal? (module-binding-context-identifiers retained-context) '()))

  (test-case "live target namespaces retain module binding access across collection"
    (define inspected? #f)
    (check-equal?
     (execute
      'read-private #t
      (lambda (stop)
        (when (and (eq? (stop-kind stop) 'before)
                   (equal? (site-expression (stop-site stop)) '(#%app + private-value '1)))
          (collect-repeatedly)
          (check-equal? (stop-binding-value stop 'private-value) 11)
          (check-equal? (stop-evaluate stop 'private-value) 11)
          (set! inspected? #t))))
     '(12))
    (check-true inspected?))

  (test-case "instrumented code grows linearly with a function's local definitions"
    ;; Racket expands and compiles the instrumented form, so its size sets the
    ;; load time. Quoted data and syntax count as one node each.
    (define (code-size value)
      (cond [(syntax? value) (code-size (syntax-e value))]
            [(pair? value)
             (define head (if (syntax? (car value)) (syntax-e (car value)) (car value)))
             (if (memq head '(quote quote-syntax)) 1
                 (+ 1 (code-size (car value)) (code-size (cdr value))))]
            [else 1]))
    (define (instrumented definitions)
      (define text
        (string-append
         "(module long racket/base\n  (define (run x)\n"
         (apply string-append
                (for/list ([i (in-range definitions)])
                  (format "    (define v~a (+ x ~a (if (even? x) 1 2)))\n" i i)))
         "    x))\n"))
      (define expanded
        (parameterize ([current-namespace (make-base-namespace)])
          (expand (read-syntax 'long (open-input-string text)))))
      (define body
        (syntax-case expanded () [(_ _ _ (_ form ...)) (syntax->list #'(form ...))]))
      (define rhs
        (for/or ([form (in-list body)])
          (syntax-case form (define-values) [(define-values (_) rhs) #'rhs] [_ #f])))
      (define next 0)
      (define-values (annotated sites _table)
        (instrument-module rhs 'long (lambda () (set! next (add1 next)) next)))
      (values (length sites) (code-size annotated)))
    (define-values (sites size) (instrumented 40))
    (define-values (doubled-sites doubled-size) (instrumented 80))
    (check-equal? doubled-sites (* 2 sites))
    (check-true (< doubled-size (* 5/2 size))
                (format "40 definitions: ~a nodes; 80 definitions: ~a nodes" size doubled-size)))

  (test-case "a stop deep inside a long function sees every local, innermost first, and assigns them"
    (define program (make-temporary-file "long-function-~a.rkt"))
    (define definitions 200)
    (dynamic-wind
      (lambda ()
        (call-with-output-file program #:exists 'truncate
          (lambda (out)
            (fprintf out "#lang racket/base\n(provide run)\n(define (long x)\n")
            (for ([i (in-range definitions)])
              (fprintf out "  (define v~a (+ x ~a))\n" i i))
            (fprintf out "  (let ([x 'shadow])\n    (list x v0 v~a)))\n(define (run) (long 1))\n"
                     (sub1 definitions)))))
      (lambda ()
        (define seen #f)
        (define result
          (run-module program #:entry 'run
                      #:on-event
                      (lambda (stop)
                        (when (and (eq? (stop-kind stop) 'before) (not seen)
                                   (equal? (site-expression (stop-site stop))
                                           (list '#%app 'list 'x 'v0 (string->symbol (format "v~a" (sub1 definitions))))))
                          (set! seen (stop-locals stop))
                          (stop-evaluate stop '(set! v0 'assigned)))
                        #f)))
        (check-equal? seen
                      (cons '(x . shadow)
                            (for/list ([i (in-range (sub1 definitions) -1 -1)])
                              (cons (string->symbol (format "v~a" i)) (+ 1 i)))))
        (check-equal? result (list 'shadow 'assigned (sub1 (+ 1 definitions)))))
      (lambda () (delete-file program)))))
