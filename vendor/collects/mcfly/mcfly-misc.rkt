#lang racket/base
;; For legal info, see file "info.rkt".

(require ;; planet/version
         setup/getinfo)

;;---------------------------------------------------------------- PLaneT Specs

(provide parse-planet-symbol/ignore-equals)
(define (parse-planet-symbol/ignore-equals sym)
  (if (symbol? sym)
      (parse-planet-symbol-string/ignore-equals (symbol->string sym))
      (error 'parse-planet-symbol/ignore-equals
             "invalid PLaneT symbol: ~S"
             sym)))

(provide parse-planet-symbol-string/ignore-equals)
(define (parse-planet-symbol-string/ignore-equals str)
  (cond ((regexp-match #rx"^([a-z][0-9a-z-]*)/([a-z][0-9a-z-]*):([1-9][0-9]*):=?([0-9]+)$"
                       str)
         => (lambda (m)
              (apply (lambda (whole owner name major minor)
                       (values owner
                               (regexp-replace #rx"\\.plt$" name "")
                               major
                               minor))
                     m)))
        (else (error 'parse-planet-symbol-string/ignore-equals
                     "invalid PLaneT symbol string: ~S"
                     str))))

(provide format-relaxed-planet-version-string)
(define (format-relaxed-planet-version-string owner name major minor)
  (let ((name (regexp-replace #"\\.plt$" name "")))
    (format "~A/~A:~A:~A" owner name major minor)))

(provide format-exact-planet-version-string)
(define (format-exact-planet-version-string owner name major minor)
  (let ((name (regexp-replace #"\\.plt$" name "")))
    (format "~A/~A:~A:=~A" owner name major minor)))

;;(define (%this-planet-exact-version-string)
;;  (with-handlers ((exn? (lambda (x) #f)))
;;    (apply format-exact-planet-version-string
;;           (this-package-version))))

;; (provide this-mcfly-exact-require-spec-string)
;; (define (this-mcfly-exact-require-spec-string)
;;   (cond ((%this-planet-exact-version-string)
;;          => (lambda (str)
;;               (string-append "(planet " str ")")))
;;         (else #f)))

(provide planet-symbol-string->version-string)
(define (planet-symbol-string->version-string str)
  (let-values (((owner name major minor)
                (parse-planet-symbol-string/ignore-equals str)))
    (string-append major ":" minor)))

;;-----------------------------------------------------------------------------

(provide get-inforkt)
(define (get-inforkt dir-path
                     #:missing-file-is-error? (missing-file-is-error? #t))
  (let* ((dir-path    (cleanse-path dir-path))
         (proc        (get-info/full dir-path))
         (unspecified (box 'unspecified)))
    (if proc
        (lambda (sym type (default unspecified))
          (let ((val (cond ((eq? default unspecified)
                            (with-handlers
                                ((exn:fail?
                                  (lambda (e)
                                    (error 'get-inforkt
                                           "info.rkt in directory ~S is missing definition for ~S (~S)"
                                           (path->string dir-path)
                                           sym
                                           (exn-message e)))))
                              (proc sym)))
                           ((procedure? default)
                            (proc sym default))
                           (else (proc sym (lambda () default))))))
            (if (or (case type
                      ((string)  (string? val))
                      ((symbol)  (symbol? val))
                      ((boolean) #t)
                      (else (error 'get-inforkt
                                   "McFly INTERNAL ERROR: type ~S"
                                   type)))
                    (equal? val default))
                (case type
                  ((boolean) (if val #t #f))
                  (else      val))
                (error 'get-inforkt
                       "expected type ~S, got ~S"
                       type
                       val))))
        (if missing-file-is-error?
            (error 'get-inforkt
                   "Could not get info from file ~S (file is not readable, or there is an error in it)"
                   (path->string dir-path))
            #f))))

;;-----------------------------------------------------------------------------

(provide parent-directory-of-path)
(define (parent-directory-of-path path)
  (let*-values (((path)
                 (simplify-path (path->complete-path (cleanse-path path))))
                ((base name dir?)
                 (split-path path)))
    (cond
      ((not (path? name))
       (error 'parent-directory-of-path
              "path ~S has no name when split"
              path))
      ((path? base) base)
      ((eq? 'relative base) 'same)
      (else (error 'parent-directory-of-path
              "path ~S has does not have a recognizable parent directory"
              path)))))

;;EOF
