#lang racket/base
(require racket/list wxme
         (prefix-in comment: wxme/comment)
         (prefix-in editor: wxme/editor)
         (prefix-in image: wxme/image)
         (prefix-in xml: wxme/xml)
         (prefix-in scheme: wxme/scheme))
(provide check-wxme-readers! call-with-wxme-readers)

(define-namespace-anchor anchor)
(define readers
  (for*/list ([name '("comment" "editor" "image" "xml" "scheme")]
              [suffix '(".ss" ".rkt")])
    `(lib ,(string-append name suffix) "wxme")))

(define (check-wxme-readers! bytes)
  (when (> (bytes-length bytes) (* 32 1024 1024)) (error 'wxme "File exceeds 32 MiB."))
  (define-values (snips data) (extract-used-classes (open-input-bytes bytes)))
  (define unknown
    (filter (lambda (name)
              (not (or (member name '("wxtext" "wxtab" "wximage" "wxmedia"))
                       (member (string->lib-path name #f) readers))))
            snips))
  (unless (and (null? unknown) (null? data))
    (error 'wxme "Unsupported WXME object classes: ~a. The file has not been changed."
           (append unknown data))))

(define (call-with-wxme-readers thunk)
  ;; XML and Racket boxes can contain independent WXME streams. Their readers
  ;; are requested after the outer class check. Preload the supported readers
  ;; and constrain every subsequent module request, including nested streams.
  (define resolve (current-module-name-resolver))
  (parameterize
      ([current-namespace (namespace-anchor->namespace anchor)]
       [current-module-name-resolver
        (case-lambda
          [(path namespace) (resolve path namespace)]
          [(path relative syntax load?)
           (unless (member path readers)
             (error 'wxme "Unsupported WXME object reader: ~s. The file has not been changed." path))
           (resolve path relative syntax load?)])])
    (thunk)))
