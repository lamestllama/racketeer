#lang racket/base
(provide check-editable-content!)

(define (check-editable-content! parts)
  (for ([part (in-list parts)])
    (define kind (hash-ref part 'kind))
    (when (member kind '("xml" "racket"))
      (unless (boolean? (hash-ref part (if (equal? kind "xml") 'eliminateWhitespace 'splicing) 'missing))
        (error 'wxme "Invalid XML or Racket box mode.")))
    (unless (member kind '("text" "image" "editor" "comment" "xml" "racket"))
      (error 'wxme "This document contains an object that cannot be edited safely."))
    (when (hash-has-key? part 'parts) (check-editable-content! (hash-ref part 'parts)))))
