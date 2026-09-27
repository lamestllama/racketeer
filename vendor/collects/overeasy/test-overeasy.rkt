#lang racket/base
;; Copyright Neil Van Dyke.  See file "info.rkt".

;; ;; Note: At this time, these tests must be verified manually.

;; (require "overeasy.rkt")
;; 
;; 
;; (define (close-enough-val-check a-values b-values)
;;   (and (null? (cdr a-values))
;;        (null? (cdr b-values))
;;        (equal? (round (* 1000 (car a-values)))
;;                (round (* 1000 (car b-values))))))
;; 
;; (test 3.142
;;       3.14159
;;       #:val-check close-enough-val-check)
;; 
;; (test #:id   'basic-arithmetic
;;       #:code (+ 1 2 3);  666)
;;       #:val  6
;;       #:fail "bug til move to new library")
;; 
;; (define (foo bar? power z)
;;   (if (zero? z)
;;       42
;;       666))
;; 
;; (test-section 'foo-constant-with-z-arg-zero
;; 
;;   (for ((bar? (in-list '(#true #false))))
;; 
;;     (test-section bar?
;; 
;;       (for ((power (in-range 1 9)))
;; 
;;         (test #:id   power
;;               #:code (foo bar? power 0)
;;               #:val  42)))))
;; 
;; (test-section 'fundamentals
;; 
;;   (test-section 'writing
;; 
;;     (test 'abcs
;;           (string-append "a" "b" "c")
;;           "abc"))
;; 
;;   (test-section 'arithmetic
;; 
;;     (test 'one-two-three
;;           (+ 1 2 3)
;;           6)
;; 
;;     (test 'for-fife-sax
;;           (+ 4 5 6)
;;           666)))
;; 
;; (test-section 'my-first-test-section
;; 
;;   (test #:id   'one-two-three
;;         #:code (+ 1 2 3)
;;         #:val  6)
;; 
;;   (test-section 'my-nested-test-section
;; 
;;     (test #:id   'math-bad
;;           #:code (+ 1 2 3)
;;           #:val  777
;;           #:fail "arithmetic bug til move to new library")
;; 
;;     ))
;; 
;;                                         ;(test #:id   'barf
;;                                         ;      #:code (+ 1 2 3)
;;                                         ;      #:val  777)
;; 
;; (test #:id   'simple-printf-of-string
;;       #:code (printf "Hello, ~A." "world")
;;       #:val  (void)
;;       #:out  #"Hello, world.")
;; 
;; #;(test-section 'misc-tests-that-fail
;; 
;; (test #:id   'simple-format-of-string-bad
;;       #:code (format "Hello, ~A." "world")
;;       #:val  "Hello, world!")
;; 
;; (test #:id   'simple-printf-of-string-bad
;;       #:code (printf "Hello, ~A." "Mrs. Robinson")
;;       #:val  (void)
;;       #:out  #"Hello, world.")
;; 
;; (test #:id   'multiple-values
;;       #:code (begin (+ 1 2) (values 1 2))
;;       #:val  (values 1 2))
;; 
;; (test #:id   'multiple-values-1-bad
;;       #:code (begin (+ 1 2) 3)
;;       #:val  (values 3 4 5))
;; 
;; (test #:id   'multiple-values-2-bad
;;       #:code (begin (+ 1 2) (values 3 4 5))
;;       #:val  3)
;; 
;; (test #:id   'got-exception-bad
;;       #:code (+ 1 (error "lalala"))
;;       #:val  6))
;; 
;; (test #:id   'exn-fail
;;       #:code (+ 1 (error "yomomso"))
;;       #:exn  exn:fail?)
;; 
;; #;(test #:id   'exn-fail-bad
;; #:code (+ 1 2)
;; #:exn  exn:fail?)
;; 
;; ;; (define yomo-exn? (make-exn-with-message-starts-with-predicate exn:fail? "yomo"))
;; 
;; ;; (test #:id   'exn-starts-with-exn-match
;; ;;       #:code (+ 1 (error "yomomso"))
;; ;;       #:exn  yomo-exn?)
;; ;;
;; ;; (test #:id   'exn-starts-with-exn-bad
;; ;;       #:code (+ 1 (error "yomomso"))
;; ;;       #:exn  (make-exn-with-message-starts-with-predicate exn:fail? "yoko"))
;; ;;
;; ;; (test #:id   'exn-starts-with-bad
;; ;;       #:code (+ 1 2)
;; ;;       #:exn  yomo-exn?)
;; 
;; #;(test #:id        'string-match-eq-bad
;; #:code      (string-append "a" "b" "c")
;; #:val       "abc"
;; #:val-check eq?)
;; 
;; #;(test #:id   'leak-to-stdout-bad
;; #:code (let ((os (open-output-string))) (display 1 os) (display 2) (display 3 os))
;; #:val  (void))
;; 
;; #;(test #:id   'strange-stderr-message-bad
;; #:code (begin (fprintf (current-error-port)
;; "%W%FROBINATOR-BROKE\n")
;; 0)
;; #:val  42)
;; 
;; (test #:id   'id-keyword-before-keywordless
;;       #:code (+ 1 2)
;;       #:val  3)
;; 
;; (test-section 'exn
;; 
;;   (test-section 'good
;; 
;;     (test #:id   'exn-string
;;           #:code (error 'foo "no way")
;;           #:exn  exn:fail?)
;; 
;;     (test #:id   'exn-string
;;           #:code (error 'foo "no way")
;;           #:exn  "foo: no way")
;; 
;;     (test #:id   'exn-string-pred
;;           #:code (error 'foo "no way")
;;           #:exn  ("foo: no way" exn:fail?))
;; 
;;     (test #:id   'exn-rx
;;           #:code (error 'foo "no way")
;;           #:exn  #rx"^foo: .* way")
;; 
;;     (test #:id   'exn-rx-pred
;;           #:code (error 'foo "no way")
;;           #:exn  (#rx"^foo: .* way" exn:fail?))))
