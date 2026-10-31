#lang racket/base
(require racket/runtime-path)
(provide plot-value? open-plot)

(define-runtime-path window-path "plot-window.rkt")

;; Resolve identities in the value's namespace. Ordinary evaluation must not
;; initialize a GUI or invoke methods on a value just to describe it.
(define (plot-value? value)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (module->namespace 'racket/gui/base)
    (define is-a? (dynamic-require 'racket/class 'is-a?))
    ;; Typed plot exports wrap their objects with contracts. Class/interface
    ;; membership works without calling their methods or conversion hooks.
    (and (is-a? value (dynamic-require 'racket/gui/base 'snip%))
         (is-a? value (dynamic-require 'plot/utils 'plot-metrics<%>)))))

;; Called on the owning evaluation thread, under normal request cancellation.
(define (open-plot value)
  (unless (plot-value? value)
    (error 'plot "Select an interactive plot from plot or plot3d. Static pictures cannot be made interactive."))
  ((dynamic-require window-path 'open-plot-window) value)
  (hasheq))
