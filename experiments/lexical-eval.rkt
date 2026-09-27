#lang racket/base

;; Design experiment, not the production frame evaluator.
;; Accessors and the target namespace are supplied explicitly. Capturing these
;; correctly from instrumented frames remains a separate implementation task.

(require (for-syntax racket/base))

(module target racket/base
  (provide target-namespace)
  (define private-value 7)
  (define-syntax-rule (add-private v) (+ private-value v))
  (define-namespace-anchor anchor)
  (define target-namespace (namespace-anchor->namespace anchor)))

(require 'target)

(define (binding-alias getter setter)
  (make-set!-transformer
   (lambda (stx)
     (syntax-case stx (set!)
       [(set! id rhs)
        (if setter
            #`(#%plain-app '#,setter rhs)
            (raise-syntax-error #f "debug binding is read-only" stx))]
       [(id . arguments)
        #`(#%app (#%plain-app '#,getter) . arguments)]
       [id
        (identifier? #'id)
        #`(#%plain-app '#,getter)]))))

(define (frame-eval form bindings ns)
  ;; Embed live transformer objects for this in-memory evaluation. This is not
  ;; a representation intended for bytecode caches or the worker wire protocol.
  (eval
   #`(let-syntax
         (#,@(for/list ([binding (in-list bindings)])
               #`[#,(datum->syntax #f (car binding)) '#,(cadr binding)]))
       #,(datum->syntax #f form))
   ns))

(module+ test
  (require rackunit)

  (define live-x 10)
  (define bindings
    (list
     (list 'x (binding-alias (lambda () live-x)
                             (lambda (v) (set! live-x v))))
     (list 'f (binding-alias (lambda () add1) #f))))

  (test-case "reads live locals and calls a locally bound procedure"
    (check-equal? (frame-eval '(f x) bindings target-namespace) 11))

  (test-case "expression-local bindings shadow the frame aliases"
    (check-equal?
     (frame-eval '(let ([x 99]) (f x)) bindings target-namespace)
     100))

  (test-case "set! writes through to the real cell"
    (frame-eval '(set! x 20) bindings target-namespace)
    (check-equal? live-x 20))

  (test-case "multiple values retain their arity"
    (check-equal?
     (call-with-values
      (lambda () (frame-eval '(values x (f x)) bindings target-namespace))
      list)
     '(20 21)))

  (test-case "private module bindings remain accessible"
    (check-equal?
     (frame-eval '(+ x private-value) bindings target-namespace)
     27))

  (test-case "module macros remain usable"
    (check-equal? (frame-eval '(add-private x) bindings target-namespace) 27))

  (define shadow-bindings
    (cons (list 'private-value (binding-alias (lambda () 1000) #f)) bindings))

  (test-case "frame aliases shadow module names in the expression"
    (check-equal?
     (frame-eval '(+ x private-value) shadow-bindings target-namespace)
     1020))

  (test-case "frame aliases preserve a module macro's definition-site binding"
    (check-equal?
     (frame-eval '(add-private x) shadow-bindings target-namespace)
     27))

  (test-case "read-only bindings reject assignment"
    (check-exn #rx"debug binding is read-only"
               (lambda ()
                 (frame-eval '(set! private-value 1)
                             shadow-bindings target-namespace))))

  (test-case "a returned closure keeps access to the live cell"
    (define captured (frame-eval '(lambda () x) bindings target-namespace))
    (set! live-x 30)
    (check-equal? (captured) 30)))
