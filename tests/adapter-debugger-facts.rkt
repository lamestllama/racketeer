#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/list racket/port racket/runtime-path
         "../racketdap/instrumentation/instrument.rkt")
(define-namespace-anchor anchor)
(define-runtime-path runtime "../racketdap/instrumentation/runtime.rkt")
(define (terms value)
  (cond [(syntax? value) (cons value (terms (syntax-e value)))]
        [(pair? value) (append (terms (car value)) (terms (cdr value)))]
        [else '()]))
(define (named expanded name)
  (findf (lambda (term) (and (identifier? term) (eq? (syntax-e term) name))) (terms expanded)))
(define (call-term expanded name)
  (findf (lambda (term)
           (define parts (syntax->list term))
           (and parts (>= (length parts) 2) (eq? (syntax-e (cadr parts)) name))) (terms expanded)))
(define source 'tiny)
(define (run-facts text facts on-event)
  (define namespace (namespace-anchor->namespace anchor))
  (parameterize ([current-namespace namespace])
    (define in (open-input-string text))
    (port-count-lines! in)
    (define expanded (expand (read-syntax source in)))
    (define-values (bindings sites) (facts expanded))
    (define next 0)
    (define unit (gensym 'tiny))
    (define-values (_required allowed) (procedure-keywords instrument-module))
    (define-values (rewritten visible table)
      (if (memq '#:runtime-bindings allowed)
          (instrument-module expanded source (lambda () (set! next (add1 next)) next)
                             #:form (cons unit 0) #:runtime-bindings bindings #:site-facts sites #:source-text text)
          (instrument-module expanded source (lambda () (set! next (add1 next)) next) #:form (cons unit 0))))
    (register-form-sites! unit 0 on-event (map car table))
    (eval rewritten)))
(define text "(let ([hidden 5])\n  (void hidden)\n  (+ hidden 1))")
(define (alias-facts expanded [mutable? #t] [scope (cons 0 (string-length text))])
  (values (list (hasheq 'name "written" 'identifier (named expanded 'hidden) 'scope scope 'mutable? mutable?)) '()))
(module+ test
  (test-case "binding facts name actual live storage and mutation changes the programme result"
    (define seen #f)
    (check-equal?
     (run-facts text alias-facts
       (lambda (stop)
         (when (and (= (site-line (stop-site stop)) 2) (eq? (stop-kind stop) 'before))
           (set! seen #t)
           (check-equal? (cdr (assq 'written (stop-locals stop))) 5)
           (stop-set-binding! stop "written" 9)
           (check-equal? (stop-evaluate stop 'hidden) 9)))) 10)
    (check-true seen))
  (test-case "binding facts respect visibility and read-only storage"
    (define seen '())
    (run-facts text (lambda (expanded) (alias-facts expanded #f '(19 . 32)))
      (lambda (stop)
        (when (eq? (stop-kind stop) 'before)
          (define line (site-line (stop-site stop)))
          (when (memv line '(2 3))
            (set! seen (cons line seen))
            (if (= line 2)
                (begin (check-equal? (stop-evaluate stop 'written) 5)
                       (check-exn #rx"cannot be assigned" (lambda () (stop-set-binding! stop "written" 7))))
                (check-false (assq 'written (stop-locals stop))))))))
    (check-equal? (sort (remove-duplicates seen) <) '(2 3)))
  (test-case "a binding fact cannot invent erased storage or use an expression as an identifier"
    (for ([id (list #'missing #'(+ hidden 1))])
      (check-exn exn:fail?
        (lambda ()
          (run-facts text (lambda (_) (values (list (hasheq 'name "absent" 'identifier id 'scope '(0 . 45))) '())) void))))
    (define conflicting "(let ([a 1] [b 2]) (+ a b))")
    (check-exn #rx"Conflicting runtime identifiers"
      (lambda ()
        (run-facts conflicting
          (lambda (expanded)
            (values (for/list ([name '(a b)])
                      (hasheq 'name "written" 'identifier (named expanded name)
                              'scope (cons 0 (string-length conflicting)))) '())) void))))
  (test-case "site facts hide housekeeping and refuse unproven statement replacement"
    (define seen '())
    (check-equal?
     (run-facts text
      (lambda (expanded)
        (values '() (list (hasheq 'term (call-term expanded 'void) 'range '(19 . 32) 'visible? #f)
                          (hasheq 'term (call-term expanded '+) 'range '(34 . 46) 'role 'statement))))
      (lambda (stop)
        (set! seen (cons (site-line (stop-site stop)) seen))
        (when (and (= (site-line (stop-site stop)) 3) (eq? (stop-kind stop) 'after))
          (check-false (stop-value-shown? stop))
          (check-exn exn:fail? (lambda () (stop-replace-results! stop '(42))))))) 6)
    (check-false (memv 2 seen)))
  (test-case "statement facts prove result replacement and convert captured CRLF ranges"
    (define text "(let ([x 5])\r\n  (+ x 1))")
    (define seen #f)
    (check-equal?
     (run-facts text
       (lambda (expanded)
         (define term (call-term expanded '+))
         (values '() (list (hasheq 'term term 'range '(14 . 23) 'role 'statement 'result term 'replaceable? #t))))
       (lambda (stop)
         (when (and (= (site-line (stop-site stop)) 2) (eq? (stop-kind stop) 'after))
           (set! seen #t)
           (check-equal? (site-position (stop-site stop)) 14)
           (check-equal? (site-column (stop-site stop)) 0)
           (check-true (stop-value-shown? stop))
           (check-equal? (stop-results stop) '(6))
           (stop-replace-results! stop '(42))))) 42)
    (check-true seen)))

(module+ test
  (test-case "module binding facts use recorded declarations and retain live module storage"
    (define text (format "(module tiny-module racket/base\n (require (file ~s))\n (provide run)\n (define hidden 5)\n (define (run) (add1 hidden)))" (path->string runtime)))
    (define namespace (namespace-anchor->namespace anchor))
    (parameterize ([current-namespace namespace])
      (define in (open-input-string text))
      (port-count-lines! in)
      (define expanded (expand (read-syntax source in)))
      (define parts (syntax->list expanded))
      (define body (syntax->list (cadddr parts)))
      (define context (make-module-binding-context))
      (for ([form (in-list (cdr body))]) (record-module-bindings! context form source))
      (define hidden (named expanded 'hidden))
      (define unit (gensym 'module-facts))
      (define calls 0)
      (define next 0)
      (define forms
        (for/list ([form (in-list (cdr body))])
          (syntax-case form (define-values)
            [(define-values (id) rhs)
             (eq? (syntax-e #'id) 'run)
             (let ()
               (define-values (_required allowed) (procedure-keywords instrument-module))
               (define-values (rewritten visible table)
                 (if (memq '#:runtime-bindings allowed)
                     (instrument-module #'rhs source (lambda () (set! next (add1 next)) next)
                                        #:form (cons unit 0) #:module-context context #:source-text text
                                        #:runtime-bindings
                                        (list (hasheq 'name "written" 'identifier hidden 'scope (cons 0 (string-length text)) 'mutable? #t)))
                     (instrument-module #'rhs source (lambda () (set! next (add1 next)) next)
                                        #:form (cons unit 0) #:module-context context)))
               (register-form-sites! unit 0
                 (lambda (stop)
                   (when (eq? (stop-kind stop) 'before)
                     (set! calls (add1 calls))
                     (check-equal? (stop-evaluate stop 'written) 5)
                     (stop-set-binding! stop "written" 9))) (map car table))
               #`(define-values (id) #,rewritten))]
            [_ form])))
      (eval #`(module tiny-module racket/base (#%module-begin #,@forms)))
      (check-equal? ((dynamic-require ''tiny-module 'run)) 10)
      (check-equal? calls 1))))

(module+ test
  (test-case "an explicit statement site can show and replace an atomic expression"
    (define text "(let ([x 5]) x)")
    (define seen #f)
    (check-equal?
      (run-facts text
        (lambda (expanded)
          (define term (last (filter (lambda (term) (and (identifier? term) (eq? (syntax-e term) 'x))) (terms expanded))))
          (values '() (list (hasheq 'term term 'range (cons 0 (string-length text))
                                   'role 'statement 'result term 'replaceable? #t))))
        (lambda (stop)
          (when (and (eq? (site-expression (stop-site stop)) 'x) (eq? (stop-kind stop) 'after))
            (set! seen #t)
            (check-equal? (stop-results stop) '(5))
            (stop-replace-results! stop '(42))))) 42)
    (check-true seen)))
