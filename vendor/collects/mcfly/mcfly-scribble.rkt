#lang racket/base
;; For legal info, see file "info.rkt".

(require scribble/base
         scribble/decode)

(define (mcfly:para-if-pre-content . rest)
  (if (pre-content? rest)
      (apply para rest)
      (splice rest)))

(provide mcfly:para-if-pre-content)
