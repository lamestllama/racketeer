#lang racket
(require plot)

;; Load in the Debug REPL, evaluate curve or surface, then choose
;; Racket: Open Interactive Plot. Each command opens an independent view.
(define curve
  (plot (function (lambda (x) (+ (sin x) (* 0.2 x))) -6 6)
        #:width 560 #:height 360 #:title "Curve"))
(define surface
  (plot3d (surface3d (lambda (x y) (* (cos x) (sin y))) -3 3 -3 3)
          #:width 560 #:height 400 #:title "Surface"))

;; For a plain terminal REPL, enable separate windows before plotting:
;; (plot-new-window? #t)
;; (plot (function sin -6 6))

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
