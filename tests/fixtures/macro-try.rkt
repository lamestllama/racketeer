#lang racket/base
;; 3. Macro expansion stepping. Put the cursor on line 28 and press Alt+Shift+M. F10 goes forward,
;; Alt+Left goes back, and the buttons at the top of the tab do the same.

;; One rewrite: unless becomes an if.
(define-syntax-rule (guard test result)
  (unless test result))

;; A macro that uses itself, so each step takes one clause off the front.
(define-syntax my-and
  (syntax-rules ()
    [(_) #t]
    [(_ e) e]
    [(_ e rest ...) (if e (my-and rest ...) #f)]))

;; A macro that uses another macro, so one step uncovers the next.
(define-syntax-rule (between? low n high)
  (my-and (<= low n) (<= n high)))

;; Hygiene: the macro's tmp and the caller's tmp stay two different variables.
(define-syntax-rule (swap! a b)
  (let ([tmp a])
    (set! a b)
    (set! b tmp)))

(define (classify n)
  (guard (number? n) 'not-a-number)
  (if (between? 1 n 10) 'small 'large))

(define (swap-demo)
  (define tmp 1)
  (define other 2)
  (swap! tmp other)
  (list tmp other))

;; A line that uses only Racket's own macros: press Alt+Shift+M on the next line. The tab says
;; that none of your own macros are used there, and shows Racket's on that line. Show Racket's
;; Macros Too, at the top of the tab, shows all of them, and this file is small enough for that.
(or #f (and #t 'found))

(displayln (classify 5))
(displayln (classify 50))
(displayln (swap-demo))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
