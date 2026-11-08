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

;; Click Run Current File to see these images beside the source.
;; Click a picture in Results to enlarge it, or choose Save image….

;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
