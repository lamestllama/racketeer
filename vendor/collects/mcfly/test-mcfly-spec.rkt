#lang racket/base
;; Copyright Neil Van Dyke.  See file "info.rkt".

;; Note: The dependency on overeasy is commented-out to avoid mcfly runtime having any dependencies.
;; Uncomment for running tests.

;; (require overeasy
;;          "mcfly-spec.rkt")
;; 
;; (with-test-section
;;  #:id 'test-mcfly-spec
;; 
;;  (with-test-section
;;   #:id 'parsing
;; 
;;   (with-test-section
;;    #:id 'lambda-formal
;; 
;;    (test (syntax->datum (lambda-formal-stx->spec #'letters #'(a b c)))
;;          '(procedure (prototype letters
;;                                 ((argument #f a <unspecified> <unspecified>)
;;                                  (argument #f b <unspecified> <unspecified>)
;;                                  (argument #f c <unspecified> <unspecified>)))
;;                      <unspecified>))
;; 
;;    (test (syntax->datum (lambda-formal-stx->spec #'procname #'(a0 a1 . an)))
;;          '(procedure (prototype procname
;;                                 ((argument #f a0 <unspecified> <unspecified>)
;;                                  (argument #f a1 <unspecified> <unspecified>)
;;                                  (argument #f an <unspecified> <unspecified>)
;;                                  (ellipses-argument)))
;;                      <unspecified>))
;; 
;;    (test (syntax->datum (lambda-formal-stx->spec #'procname #'an))
;;          '(procedure (prototype procname
;;                                 ((argument #f an <unspecified> <unspecified>)
;;                                  (ellipses-argument)))
;;                      <unspecified>))
;; 
;;    (test (syntax->datum (lambda-formal-stx->spec #'procname #'(a0 (a1 d1) . an)))
;;          '(procedure (prototype procname
;;                                 ((argument #f a0 <unspecified> <unspecified>)
;;                                  (argument #f a1 <unspecified> d1)
;;                                  (argument #f an <unspecified> <unspecified>)
;;                                  (ellipses-argument)))
;;                      <unspecified>))
;; 
;;    (test (syntax->datum (lambda-formal-stx->spec #'procname #'(#:k0 a0 #:k1 (a1 d1) . an)))
;;          '(procedure (prototype procname
;;                                 ((argument #:k0 a0 <unspecified> <unspecified>)
;;                                  (argument #:k1 a1 <unspecified> d1)
;;                                  (argument #f   an <unspecified> <unspecified>)
;;                                  (ellipses-argument)))
;;                      <unspecified>)))
;; 
;;   (with-test-section
;;    #:id 'contract
;; 
;;    (test (syntax->datum (contract-stx->spec-or-false #'procname #'(-> Number Number Integer String)))
;;          '(procedure (prototype procname ((argument <unspecified> <unspecified> Number  <unspecified>)
;;                                           (argument <unspecified> <unspecified> Number  <unspecified>)
;;                                           (argument <unspecified> <unspecified> Integer <unspecified>)))
;;                      String))))
;; 
;;  (with-test-section
;;   #:id 'unify
;; 
;;   (test (syntax->datum (unify-specs #f
;;                                     (list #`(a b c)
;;                                           #`(a b #,unspecified-stx))))
;;         '(a b c))
;; 
;;   (test (syntax->datum (unify-specs #f
;;                                     (list #`(a b c)
;;                                           #`(x y z))))
;;         '(a b c))
;; 
;;   (test (syntax->datum (unify-specs #f
;;                                     (list #`(a b c)
;;                                           #`(#,unspecified-stx #,unspecified-stx #,unspecified-stx))))
;;         '(a b c))
;; 
;;   (test (syntax->datum (unify-specs #f
;;                                     (list #`(#,unspecified-stx #,unspecified-stx #,unspecified-stx)
;;                                           #`(a b c)
;;                                           )))
;;         '(a b c))
;; 
;;   (test (syntax->datum (unify-specs #f
;;                                     (list #`(a #,unspecified-stx c)
;;                                           #`(a b #,unspecified-stx))))
;;         '(a b c))
;; 
;;   (test (syntax->datum
;;          (unify-specs
;;           #f
;;           (list #`(a #,unspecified-stx (c #,unspecified-stx) #,unspecified-stx f)
;;                 #`(a b                 (c d                ) #,unspecified-stx f)
;;                 #`(x x                 x                     e                 x))))
;;         '(a b (c d) e f))
;; 
;;   (test (syntax->datum (unify-specs #f
;;                                     (list #`(a #,unspecified-stx c)
;;                                           #`(a b #,unspecified-stx))))
;;         '(a b c)))
;; 
;;  (with-test-section
;;   #:id 'scribble
;; 
;;   (with-test-section
;;    #:id 'defproc
;; 
;;    (test (syntax->datum (procedure-spec+body->scribble-defproc
;;                          #'(procedure (prototype foo
;;                                                  ((argument #f  a integer? <unspecified>)
;;                                                   (argument #f  b string?  <unspecified>)
;;                                                   (argument #f  c integer? 42)
;;                                                   (argument #:x x integer? 0)
;;                                                   (argument #:y y integer? <unspecified>)
;;                                                   (argument #f  z integer? <unspecified>)
;;                                                   (ellipses-plus-argument)))
;;                                       string?)
;;                          #'((para "This is a test.")
;;                             (para "this is only a test."))))
;;          '(defproc (foo (    a integer?   )
;;                         (    b string?    )
;;                         (    c integer? 42)
;;                         (#:x x integer? 0 )
;;                         (#:y y integer?   )
;;                         (    z integer?   )
;;                         ...+)
;;             string?
;;             (para "This is a test.")
;;             (para "this is only a test.")))))
;; 
;;  (with-test-section
;;   #:id 'overall
;; 
;;   (test (syntax->datum (lambda-formal-stx->spec #'procname #'(a b c)))
;;         '(procedure (prototype procname
;;                                ((argument #f a <unspecified> <unspecified>)
;;                                 (argument #f b <unspecified> <unspecified>)
;;                                 (argument #f c <unspecified> <unspecified>)))
;;                     <unspecified>))
;; 
;;   (test (syntax->datum
;;          (unify-specs #f
;;                       (list (contract-stx->spec-or-false #'procname #'(-> Number Number Integer String))
;;                             (lambda-formal-stx->spec #'procname #'(a b c)))))
;; 
;;         '(procedure (prototype procname ((argument #f a Number  <unspecified>)
;;                                          (argument #f b Number  <unspecified>)
;;                                          (argument #f c Integer <unspecified>)))
;;                     String))
;; 
;;   (test (syntax->datum
;;          (procedure-spec+body->scribble-defproc
;;           (unify-specs #f
;;                        (list (contract-stx->spec-or-false      #'myproc #'(-> Number Number Integer String))
;;                              (lambda-formal-stx->spec #'myproc #'(   a      b      c))))
;;           #'((para "This is a cool procedure.")
;;              (para "Yep."))))
;; 
;;         '(defproc (myproc (a Number)
;;                           (b Number)
;;                           (c Integer))
;;            String
;;            (para "This is a cool procedure.")
;;            (para "Yep.")))))
