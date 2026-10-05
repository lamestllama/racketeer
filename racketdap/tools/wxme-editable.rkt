#lang racket/base
(provide check-editable-content!)

(define (check-editable-content! parts)
  (for ([part (in-list parts)])
    (when (member (hash-ref part 'kind) '("xml" "racket"))
      (error 'wxme "XML and Racket boxes are read-only. Open this file with the Racketeer WXME Viewer."))
    (unless (member (hash-ref part 'kind) '("text" "image" "editor" "comment"))
      (error 'wxme "This document contains an object that cannot be edited safely."))
    (when (hash-has-key? part 'parts) (check-editable-content! (hash-ref part 'parts)))))
