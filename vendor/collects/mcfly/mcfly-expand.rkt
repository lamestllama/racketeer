#lang racket/base
;; For legal info, see file "info.rkt".

(require (for-syntax racket/base
                     syntax/parse
                     "mcfly-format.rkt"))

(define-syntax (mcfly-expand stx)
  (syntax-parse stx
    ((_ IN-PATH:expr)
     (mcfly-format-from-file stx
                             (let ((in-path (syntax->datum #'IN-PATH)))
                               (with-handlers
                                   ((exn:fail?
                                     (lambda (e)
                                       (raise-syntax-error
                                        'mcfly-expand
                                        (format "invalid file path ~S: ~S"
                                                in-path
                                                (exn-message e))
                                        stx
                                        #'IN-PATH))))
                                 (cleanse-path in-path)))))))

(provide mcfly-expand)
