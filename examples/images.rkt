#lang racket/base
(require (prefix-in image: 2htdp/image)
         (prefix-in pict: pict)
         (prefix-in plot: plot/no-gui))

(define tile (image:rectangle 64 32 "solid" "royalblue"))
(define drawing (pict:colorize (pict:filled-ellipse 48 32) "orange"))
(define chart
  (plot:plot-pict (plot:lines '((0 0) (1 2) (2 1))) #:width 240 #:height 160))

tile
drawing
chart

;; In the Debug Console, try (values tile "caption" drawing chart).
;; View Image lets you choose value 1, value 3, or value 4.
