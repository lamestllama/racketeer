#lang racket/base
;; For legal info, see file "info.rkt".

(require (for-syntax racket/base
                     syntax/parse)
         (for-template racket/base
                       scribble/manual)
         racket/base
         scribble/manual
         syntax/parse
         syntax/strip-context
         "main.rkt"
         "mcfly-misc.rkt"
         "mcfly-parse.rkt"
         "mcfly-spec.rkt")

(define (%mcfly-format expand-stx parsedata inforkt)
  ;; TODO: We should have a real "inforkt-loc" for navigating to that file on
  ;; errors on things wrong in that file.
  (let-values (((inforkt-loc)  expand-stx)
               ((name-string)  (inforkt 'name        'string))
               ((legal-string) (inforkt 'mcfly-legal 'string #f))
               ((planet-exact-string planet-relaxed-string planet-version-number-string planet-name-string)
                (cond ((inforkt 'mcfly-planet 'symbol #f)
                       => (lambda (planet-sym)
                            (let-values (((owner name major minor)
                                          (parse-planet-symbol-string/ignore-equals
                                           (symbol->string planet-sym))))
                              (values (format-exact-planet-version-string
                                       owner name major minor)
                                      (format-relaxed-planet-version-string
                                       owner name major minor)
                                      (string-append major ":" minor)
                                      name))))
                      (else (values #f #f)))))
    (quasisyntax/loc inforkt-loc
      (begin

        #,@(quasisyntax/loc expand-stx
             #,(let ((warnings (mcfly-parsedata-warnings parsedata)))
                 (if (null? warnings)
                     #'()
                     #`((para (bold (racketerror "This document had warnings from McFly:")))
                        (itemlist
                         #,@(map (lambda (stx)
                                   (quasisyntax/loc stx
                                     (item (racketerror #,@(replace-context expand-stx stx)))))
                                 warnings))))))

        (title #,@(cond
                   ((or (inforkt 'version 'string #f)
                        planet-version-number-string)
                    => (lambda (version-string)
                         #`(#:version #,version-string)))
                   (else #'()))
               #,@(let ((title-string    (inforkt 'mcfly-title    'string #f))
                        (subtitle-string (inforkt 'mcfly-subtitle 'string #f)))
                    (cond ((and title-string subtitle-string)
                           (raise-syntax-error
                            '%mcfly-format
                            "both mcfly-title and mcfly-subtitle defined"
                            inforkt-loc))
                          (title-string
                           #`(#,title-string))
                          (subtitle-string
                           #`(""
                              ;; #,(if (equal? name-string planet-name-string)
                              ;;       #`(code #,name-string)
                              ;;       name-string)
                              #,name-string
                              ": "
                              #,subtitle-string))
                          (else #`(#,name-string)))))
        
        #,@(cond ((or (inforkt 'mcfly-author  'string #f)
                      (inforkt 'mcfly-authors 'string #f))
                  => (lambda (auth)
                       ;; TODO: Permit this to be a list.
                       #`((author #,auth))))
                 (else #'()))

        #,@(let* ((license-string  (or (inforkt 'mcfly-license 'string #f)
                                       (and legal-string "(see below)")))
                  (homepage-string (inforkt 'homepage 'string #f)))
             (if (or license-string homepage-string)
                 #`("\n" ;; TODO: Put this in a para?
                    #,@(if license-string
                           #`("License: "
                              (seclink "Legal"
                                       #:underline? #f
                                       #,license-string))
                           #'())
                    #,@(if homepage-string
                           #`(#,@(if license-string
                                     #'(" " (hspace 1) " ")
                                     #'())
                              "Web: "
                              (link #,homepage-string
                                    #:underline? #f
                                    #,homepage-string))
                           #'())
                    "\n")
                 #'()))

        #,@(if (and (inforkt 'mcfly-default-defmodule? 'boolean #t) planet-relaxed-string)
               #`((defmodule
                    ;; (planet #,(string->symbol planet-relaxed-string))
                    #,(string->symbol planet-name-string)
                    ))
               ;; #`((defmodule/this-package main))
               #'())

        #,@(%mcfly-format-doc-parts expand-stx parsedata inforkt)

        #,@(if legal-string
               #`("\n" (section #:tag "Legal" "Legal") #,legal-string "\n")
               #'())

        ;; (linebreak)
        ;; (linebreak)
        ;; (para
        ;;  (smaller
        ;;   (smaller "This document was formatted by "
        ;;            (hyperlink "http://docs.racket-lang.org/scribble/"
        ;;                       "Scribble"
        ;;                       #:underline? #f)
        ;;            " version "
        ;;            (version)
        ;;            ", and "
        ;;            (hyperlink "http://www.neilvandyke.org/mcfly/"
        ;;                       "McFly"
        ;;                       #:underline? #f)
        ;;            " version "
        ;;            #,(let ((str (this-mcfly-exact-require-spec-string)))
        ;;                (cond ((not str) "[unknown]")
        ;;                      ((regexp-match #rx"^\\(planet neil/mcfly:([0-9]+):=([0-9]+)\\)$" str)
        ;;                       =>
        ;;                       (lambda (m)
        ;;                         (format "~A:~A" (list-ref m 1) (list-ref m 2))))
        ;;                      (else
        ;;                       #`(tt #,str))))
        ;;            ".")))
        ))))

(define (%scribble-stx-toplevel? stx)
  ;; TODO: Might be possible to speed this up by not using "syntax-parse".
  (syntax-parse stx
    (((~datum require) Xn ...) #t)
    (else #f)))

(define (%scribble-syntax-list-with-possible-paras-added context-stx orig-stx-list)
  (letrec
      ((do-unknown-whether-null
        (lambda (stx-list)
          (if (null? stx-list)
              '()
              (let ((stx (car stx-list)))
                (if (%scribble-stx-toplevel? stx)
                    (do-stx-is-toplevel stx
                                        (cdr stx-list))
                    (let loop-nontoplevel-stxes ((reverse-nontoplevel-stxes (cons stx '()))
                                                 (stx-list                  (cdr stx-list)))
                      (if (or (null? stx-list) (%scribble-stx-toplevel? (car stx-list)))
                          (cons (quasisyntax/loc context-stx
                                  ;; TODO: Is that context-stx right?  What if list
                                  ;; is only one element?
                                  (mcfly:para-if-pre-content
                                   #,@(reverse reverse-nontoplevel-stxes)))
                                (if (null? stx-list)
                                    '()
                                    (do-stx-is-toplevel (car stx-list)
                                                        (cdr stx-list))))
                          (loop-nontoplevel-stxes (cons (car stx-list)
                                                        reverse-nontoplevel-stxes)
                                                  (cdr stx-list)))))))))
       (do-stx-is-toplevel
        (lambda (stx stx-list)
          (cons stx (do-unknown-whether-null stx-list)))))
    (do-unknown-whether-null orig-stx-list)))

(define (%mcfly-format-doc-parts expand-stx parsedata inforkt)
  (quasisyntax/loc expand-stx
    (#,@(let loop ((body-stxes (mcfly-parsedata-body-stxes parsedata))
                   (out-stxes  '()))
          (if (null? body-stxes)
              ;; TODO: Is this the best way to "replace-context"?
              (map (lambda (out-stx)
                     (replace-context expand-stx out-stx))
                   out-stxes)
              (let ((body-stx (car body-stxes)))
                ;; TODO: We don't have the "resolve" procedure do the
                ;; conversion of body to straight Scribble, if only
                ;; because we would like the "doc history" form to be
                ;; accessible to tools.  We could always treat "history"
                ;; specially, like we do "Package", or simply leave it in
                ;; the body where user positioned it, but don't translate
                ;; it to straight Scribble til the last moment here.  We
                ;; probably don't want to make history be a part of the
                ;; "Package" form, because that's a lot of long crap to
                ;; have up top of a file.
                (syntax-parse body-stx
                  
                  ((DOC:id (~datum scribble) Xn ...)
                   (loop (cdr body-stxes)
                         (append out-stxes
                                 (%scribble-syntax-list-with-possible-paras-added
                                  body-stx
                                  (syntax->list (syntax (Xn ...)))))))

                  ((DOC:id (~datum history) ITEM ...)
                   ;; TODO: Check that any PLaneT version number from "doc
                   ;; Package" form is in "doc history" form, and maybe
                   ;; that it is at top.  (Possible reason we might not
                   ;; want it at top: something involving doing branched
                   ;; releases, such as bugfix for old major version, and
                   ;; maybe simultaneous releases under two major versions
                   ;; and want the same history for both?)
                   (loop (cdr body-stxes)
                         (append out-stxes
                                 `(,(quasisyntax/loc body-stx
                                      (section "History"))
                                   ,(quasisyntax/loc body-stx
                                      (itemlist
                                       #,@(map (lambda (item-stx)
                                                 ;; TODO: Syntax classes for PLANET, etc.
                                                 (syntax-parse item-stx
                                                   (((~or (~optional (~seq #:planet  PLANET)  #:name "#:planet option")
                                                          (~optional (~seq #:version VERSION) #:name "#:version option")
                                                          (~optional (~seq #:date    DATE)    #:name "#:date option"))
                                                     ...
                                                     BODYn ...)
                                                    (quasisyntax/loc item-stx
                                                      (item (para #,@(let loop ((in-pairs
                                                                                 `(("Version" . ,(attribute VERSION))
                                                                                   ("Version" . ,(let ((s (attribute PLANET)))
                                                                                                   (and s
                                                                                                        (let ((s2 (syntax-e s)))
                                                                                                          (if (symbol? s2)
                                                                                                              (datum->syntax (syntax PLANET)
                                                                                                                             (symbol->string s2))
                                                                                                              s)))))
                                                                                   (#f        . ,(attribute DATE))))
                                                                                (out-stxes '()))
                                                                       (if (null? in-pairs)
                                                                           (reverse out-stxes)
                                                                           (let ((pair (car in-pairs)))
                                                                             (cond ((cdr pair)
                                                                                    => (lambda (val-stx)
                                                                                         (loop (cdr in-pairs)
                                                                                               `(,val-stx
                                                                                                 ,@(cond ((car pair)
                                                                                                          => (lambda (label)
                                                                                                               `(,#'" "
                                                                                                                 ,(datum->syntax val-stx
                                                                                                                                 (car pair)))))
                                                                                                         (else '()))
                                                                                                 ,@(if (null? out-stxes)
                                                                                                       '()
                                                                                                       `(" --- "
                                                                                                         ,@out-stxes))))))
                                                                                   (else (loop (cdr in-pairs)
                                                                                               out-stxes)))))))
                                                            BODYn ...)))))
                                               (syntax->list (syntax (ITEM ...))))))))))

                  (else (error '%mcfly-format-doc-parts
                               "Unrecognized doc syntax: ~S"
                               (syntax->datum body-stx))))))))))

(define (mcfly-format-from-file expand-stx rkt-path)
  (let* ((rkt-path  (path->complete-path (cleanse-path rkt-path)))
         (info-path (parent-directory-of-path rkt-path)))
    (%mcfly-format
     expand-stx
     (call-with-input-file rkt-path
       (lambda (in)
         (mcfly-parse in #:sourcename rkt-path)))
     (get-inforkt info-path))))

(provide mcfly-format-from-file)
