#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Prints what the gui-debugger annotator stops at in a program, with every position allowed to
;; stop, as stepping does: each stop's file, position, kind, values and variables, as JSON.
(require gui-debugger/annotator gui-debugger/marks json racket/path)
(define file (path->complete-path (vector-ref (current-command-line-arguments) 0)))
(define stops '())
(define (note! kind info at-end? results)
  (define stx (mark-source info))
  (set! stops
        (cons (hasheq 'file (path->string (file-name-from-path (syntax-source stx)))
                      'position (+ (syntax-position stx) (if at-end? (sub1 (syntax-span stx)) 0))
                      'kind kind
                      'results results
                      'locals (for/hasheq ([b (in-list (mark-bindings info))])
                                (values (syntax-e (mark-binding-binding b))
                                        (format "~v" (mark-binding-value b)))))
              stops)))
(define output (open-output-string))
(parameterize ([current-namespace (make-base-namespace)]
               [current-load-relative-directory (path-only file)]
               [current-output-port output])
  (define form
    (parameterize ([read-accept-reader #t] [read-accept-lang #t])
      (call-with-input-file file (lambda (in) (port-count-lines! in) (read-syntax file in)))))
  (define-values (annotated positions)
    (annotate-for-single-stepping
     (expand form)
     (lambda (source) (lambda (position) #t))
     (lambda (info marks) (note! "before" info #f '()) #f)
     (lambda (info marks . vals)
       (note! "after" info #t (map (lambda (v) (format "~v" v)) vals))
       (apply values vals))
     void void))
  (eval annotated)
  (dynamic-require (list 'quote (syntax-e (cadr (syntax-e annotated)))) #f))
(write-json (hasheq 'stdout (get-output-string output) 'stops (reverse stops)))
