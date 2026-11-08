#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require json racket/class racket/list racket/string
         "../../racketdap/tools/macro-steps/printing.rkt")

;; Synthetic scopes give exact, portable numbers without relying on a particular
;; language implementation's expansion trace. Every number is allocated by layout.
(define partition (new-foreground-partition))
(define introducers (list->vector (cons values (for/list ([_ (in-range 44)]) (make-syntax-introducer)))))
(define (at group term) ((vector-ref introducers group) term))
(define (id group name) (at group (datum->syntax #f name)))
(define (render term [option 'over-limit] [abbrev? #t])
  (define-values (text _) (layout term #:partition partition #:suffix-option option
                                  #:pretty-abbrev? abbrev? #:columns 1000))
  (string-trim text #:left? #f))
(for ([group (in-range 1 45)]) (render (at group (datum->syntax #f group))))
(define (reader text)
  (define in (open-input-string text))
  (port-count-lines! in)
  (read-syntax 'display-example in))
(define marked (at 44 (reader "'a")))
(define moved
  (at 44 (datum->syntax #f (syntax-e (reader "'a")) '(use-site 2 0 10 2))))
(define examples
  (hasheq
   'table (for/list ([group '(0 1 16 17 18 44)])
            (for/list ([option '(never over-limit always)]) (render (id group 'x) option)))
   'small (for/list ([option '(over-limit always)])
            (render (datum->syntax #f (list 'list (id 1 'x) (id 2 'x))) option))
   'fresh (render (id 18 'fresh))
   'names (render (datum->syntax #f (list 'list (id 18 'left) (id 18 'right))))
   'finished (list (render (id 31 'define-values)) (render (id 42 '#%app)) (render moved))
   'marked (for*/list ([option '(over-limit always never)] [abbrev? '(#t #f)])
             (render marked option abbrev?))
   'moved (render moved 'never)
   'prefixes (for/list ([prefix '("'" "`" "," ",@" "#'" "#`" "#," "#,@")])
               (render (reader (string-append prefix "x"))))
   'quotes (for/list ([text '("'5" "'()" "(quote ())" "''x" "(quote x extra)" "(quote . x)"
                                  "'#%kernel" "'syntax/loc" "(quote 5)")])
             (render (reader text)))))
(module+ main (write-json examples))
