#lang racket/base
;; For legal info, see file "info.rkt".

(require racket/port
         racket/pretty
         (prefix-in scribble-reader: scribble/reader)
         syntax/parse
         "mcfly-spec.rkt")

(define-struct mcfly-parsedata
  (body-stxes
   warnings))

(define (mcfly-parse in #:sourcename (sourcename #f))
  (port-count-lines! in)
  (let* ((lang-in       (peeking-input-port in))
         (language-info (begin (port-count-lines! lang-in)
                               (read-language lang-in)))

         (at-exp?       (if (procedure? language-info)
                            ;; There *is* a "#lang".
                            (let* ((lang2-in                (peeking-input-port in))
                                   (pos-after-read-language (file-position lang-in))
                                   (regexp-limit            (* 4 pos-after-read-language)))
                              ;; Try to see whether there is a "#lang at-exp"
                              ;; by finding the last "#lang" before
                              ;; "pos-after-read-language".  Note that we don't
                              ;; trust that "file-position" and
                              ;; "regexp-match-positions" use the same
                              ;; representation.  Note that "regexp-limit" is a
                              ;; kludge on the assumption that we never
                              ;; represent a character with more than 4 bytes.
                              (begin0 (let loop ((at-exp? #f))
                                        (cond ((regexp-match-positions #rx"#lang([ \t]+at-exp[ \t\r\n])?"
                                                                       lang2-in
                                                                       0
                                                                       regexp-limit)
                                               => (lambda (m)
                                                    (if (> (file-position lang2-in)
                                                           pos-after-read-language)
                                                        ;; We read a "#lang",
                                                        ;; but file position is
                                                        ;; after the "#lang"
                                                        ;; line that
                                                        ;; "read-language"
                                                        ;; left, to return our
                                                        ;; previous "at-exp?"
                                                        ;; value.
                                                        at-exp?
                                                        ;; We read a "#lang",
                                                        ;; and we are not past
                                                        ;; the file position
                                                        ;; that "read-language"
                                                        ;; left, so remember
                                                        ;; whether this
                                                        ;; last-so-far "#lang"
                                                        ;; had an "at-exp", and
                                                        ;; then
                                                        (loop (cadr m)))))
                                              (else at-exp?)))

                                ;; Position immediately after the "#lang" line,
                                ;; for reading syntax.
                                (file-position in 0)
                                (for ((i (in-range 0 pos-after-read-language)))
                                  (read-char-or-special in))))
                            ;; There is *not* a "#lang".
                            #f))
         (read-next-syntax (if at-exp?
                               (lambda () (scribble-reader:read-syntax sourcename in))
                               (lambda () (read-syntax sourcename in))))
         (sym-to-tagged-specs-hash (make-hasheq)))
    ;; TODO: This is in a loop to support "module" forms and some kind of
    ;; file-include, but we haven't implemented that.  Also use it for
    ;; top-level "begin".
    (let loop ((stx                (read-next-syntax))
               (reverse-body-stxes '())
               (reverse-warnings   '()))
      (if (eof-object? stx)
          (%mcfly-parse:resolve sym-to-tagged-specs-hash
                                reverse-body-stxes
                                reverse-warnings)
          (let-syntax ((update-sym-to-tagged-specs-hash
                        (syntax-rules ()
                          ((_ SYM TAGGED-SPEC REVERSE-WARNINGS)
                           (begin
                             (hash-update! sym-to-tagged-specs-hash
                                           SYM
                                           (lambda (old-tagged-specs)
                                             (cons TAGGED-SPEC old-tagged-specs))
                                           '())
                             ;; TODO: We don't add to REVERSE-WARNINGS here anymore, so
                             ;; maybe get rid of that.
                             REVERSE-WARNINGS)))))
            (syntax-parse stx

              ;; Match "doc" forms...

              (((~datum doc) ID:id ARGn ...)
               (let ((id-sym (syntax->datum #'ID)))
                 (case id-sym
                   ((history procedure procedures scribble)
                    (loop (read-next-syntax)
                          (cons stx reverse-body-stxes)
                          reverse-warnings))
                   (else (raise-syntax-error 'mcfly-parse
                                             (format "Unrecognized symbol ~S in doc form."
                                                     id-sym)
                                             stx
                                             #'ID)))))

              (((~datum doc) ARGn ...)
               (loop (read-next-syntax)
                     (cons (quasisyntax/loc stx
                             (doc scribble ARGn ...))
                           reverse-body-stxes)
                     reverse-warnings))

              ;; Rewrite some shorthand syntax and retry...

              (((~datum define) (NAME:id ARGn ...) BODYn ...)
               (loop (quasisyntax/loc stx
                       (define NAME (lambda (ARGn ...) BODYn ...)))
                     reverse-body-stxes
                     reverse-warnings))

              (((~datum define) (NAME:id . ARG) BODYn ...)
               (loop (quasisyntax/loc stx
                       (define NAME (lambda ARG BODYn ...)))
                     reverse-body-stxes
                     reverse-warnings))

              (((~datum define) (NAME:id ARGn ... . ARG) BODYn ...)
               (loop (quasisyntax/loc stx
                       (define NAME (lambda (ARGn ... . ARG) BODYn ...)))
                     reverse-body-stxes
                     reverse-warnings))

              ;; Rewrite to remove some intermedite "let"-like forms before
              ;; possible "lambda", and retry...

              (((~datum define) NAME:id ((~datum let) LOOP:id (X ...) BODY))
               ;; TODO: Do we want to permit the "let" body to have more than
               ;; one form?  Take the last?
               (loop (quasisyntax/loc stx
                       (define NAME BODY))
                     reverse-body-stxes
                     reverse-warnings))

              (((~datum define) NAME:id ((~or (~datum let)
                                              (~datum let*)
                                              (~datum letrec)
                                              (~datum let-values)
                                              (~datum let*-values)
                                              (~datum letrec-values)
                                              (~datum let-syntax)
                                              (~datum letrec-syntax)
                                              (~datum let-syntaxes)
                                              (~datum letrec-syntaxes)
                                              (~datum letrec-syntaxes+values))
                                         (X ...)
                                         BODY))
               ;; TODO: Do we want to permit the "let" body to have more than
               ;; one form?  Take the last?
               (loop (quasisyntax/loc stx
                       (define NAME BODY))
                     reverse-body-stxes
                     reverse-warnings))

              (((~datum define) NAME:id ((~or (~datum letrec-syntaxes+values))
                                         (X ...)
                                         BODY))
               ;; TODO: Do we want to permit the "let" body to have more than
               ;; one form?  Take the last?
               (loop (quasisyntax/loc stx
                       (define NAME BODY))
                     reverse-body-stxes
                     reverse-warnings))

              ;; Match forms that provide argument names...

              (((~datum define) NAME:id ((~datum lambda) (ARGn ...) BODYn ...))
               (loop (read-next-syntax)
                     reverse-body-stxes
                     (update-sym-to-tagged-specs-hash (syntax->datum #'NAME)
                                                      (cons 'lambda
                                                            (lambda-formal-stx->spec #'NAME
                                                                                     #'(ARGn ...)))
                                                      reverse-warnings)))

              (((~datum define) NAME:id ((~datum lambda) (ARGn ... . ARG) BODYn ...))
               (loop (read-next-syntax)
                     reverse-body-stxes
                     (update-sym-to-tagged-specs-hash (syntax->datum #'NAME)
                                                      (cons 'lambda
                                                            (lambda-formal-stx->spec #'NAME
                                                                                     #'(ARGn ... . ARG)))
                                                      reverse-warnings)))

              (((~datum define) NAME:id ((~datum lambda) ARG BODYn ...))
               (loop (read-next-syntax)
                     reverse-body-stxes
                     (update-sym-to-tagged-specs-hash (syntax->datum #'NAME)
                                                      (cons 'lambda
                                                            (lambda-formal-stx->spec #'NAME #'ARG))
                                                      reverse-warnings)))

              ;; Match forms that provide contracts...

              (((~datum provide/contract) (NAME:id CONTRACT) REST ...)
               (loop (if #'(REST ...)
                         (quasisyntax/loc stx
                           (provide/contract REST ...))
                         (read-next-syntax))
                     reverse-body-stxes
                     (cond ((contract-stx->spec-or-false #'NAME #'CONTRACT)
                            => (lambda (spec)
                                 (update-sym-to-tagged-specs-hash (syntax->datum #'NAME)
                                                                  (cons 'contract spec)
                                                                  reverse-warnings)))
                           (else reverse-warnings))))

              ;; TODO: !!! ALSO SUPPORT (provide ... (contract-out ...) ...)

              ;; TODO: !!! also match ":", "define:", etc.

              (else (loop (read-next-syntax)
                          reverse-body-stxes
                          reverse-warnings))))))))

(define (%mcfly:datum->pretty-syntax datum
                                     #:source-name (source-name #f)
                                     #:columns     (columns       80))
  (let ((in (open-input-string
             (let ((os (open-output-string)))
               (parameterize ((pretty-print-columns               columns)
                              (pretty-print-depth                 #f)
                              (pretty-print-exact-as-decimal      #f)
                              (pretty-print-.-symbol-without-bars #f)
                              (pretty-print-show-inexactness      #f))
                 (pretty-write datum os))
               (get-output-string os)))))
    (port-count-lines! in)
    (read-syntax source-name in)))

(define (%mcfly-parse:resolve sym-to-tagged-specs-hash
                              reverse-body-stxes
                              reverse-parse-warnings)
  (let loop ((in-stxes         reverse-body-stxes)
             (out-stxes        '())
             (resolve-warnings '()))
    (if (null? in-stxes)
        (make-mcfly-parsedata
         out-stxes
         ;; TODO: Is this where we mess up the ordering of the warnings?  Why
         ;; not just get the orderings right, pass "reverse-warnings" through
         ;; this procedure, and not have to do an append at the end?
         (append (reverse reverse-parse-warnings)
                 resolve-warnings))
        (let ((stx (car in-stxes)))
          (syntax-parse stx

            ;; If it's a "scribble" form, ignore it.
            ((DOC (~datum scribble) RESTn ...)
             (loop (cdr in-stxes)
                   (cons stx out-stxes)
                   resolve-warnings))

            ((DOC (~datum procedure) NAME:id BODYn ...)
             (let-values (((proto-stx result-stx resolve-warnings)
                           (%mcfly-parse:unresolved-proc-stx->proto-stx+result-stx+warnings
                            #:sym-to-tagged-specs-hash sym-to-tagged-specs-hash
                            #:doc-stx                  stx
                            #:proto-or-name-stx        #'NAME
                            #:result-stx-or-false      #f
                            #:warnings                 resolve-warnings)))
               ;; TODO: !!! We assume that we *always* get a proto-stx and
               ;; result-stx.
               (loop (cdr in-stxes)
                     (cons (quasisyntax/loc stx
                             ;; TODO: !!! THIS IS FROM BEFORE STRIPPING ALL
                             ;; SYNTAX INFO IN ATTEMPT TO FIX SCRIBBLE
                             ;; FORMATTING WHEN PARENTHESIZED RESULT TOP LEVEL
                             ;; HAS NO SYNTAX INFO.
                             ;;
                             ;; (DOC scribble (defproc #,proto-stx #,result-stx BODYn ...))
                             ;;
                             ;; (DOC scribble (defproc #,proto-stx
                             ;; #,(quasisyntax/loc stx
                             ;; #,(syntax->datum result-stx))
                             ;; BODYn ...))
                             (DOC scribble (defproc
                                               #,(%mcfly:datum->pretty-syntax (syntax->datum proto-stx))
                                               #,(%mcfly:datum->pretty-syntax (syntax->datum result-stx))
                                             BODYn ...)))
                           out-stxes)
                     resolve-warnings)))

            ((DOC (~datum procedures) (NAME:id ...+) BODYn ...)
             (let-values (((protoandresults resolve-warnings)
                           (let loop-names ((names                   (syntax->list #'(NAME ...)))
                                            (reverse-protoandresults '())
                                            (resolve-warnings        resolve-warnings))
                             (if (null? names)
                                 (values (reverse reverse-protoandresults)
                                         resolve-warnings)
                                 (let-values (((proto-stx result-stx resolve-warnings)
                                               (%mcfly-parse:unresolved-proc-stx->proto-stx+result-stx+warnings
                                                #:sym-to-tagged-specs-hash sym-to-tagged-specs-hash
                                                #:doc-stx                  stx
                                                #:proto-or-name-stx        (car names)
                                                #:result-stx-or-false      #f
                                                #:warnings                 resolve-warnings)))
                                   ;; TODO: !!! We assume that we *always* get
                                   ;; a proto-stx and result-stx.
                                   (loop-names (cdr names)
                                               (cons (quasisyntax/loc stx
                                                       (#,proto-stx #,result-stx))
                                                     reverse-protoandresults)
                                               resolve-warnings))))))
               (loop (cdr in-stxes)
                     (cons (quasisyntax/loc stx
                             (DOC scribble (defproc* #,(%mcfly:datum->pretty-syntax (map syntax->datum
                                                                                         protoandresults))
                                             BODYn ...)))
                           out-stxes)
                     resolve-warnings)))

            ((DOC (~datum history) Xn ...)
             (loop (cdr in-stxes)
                   (cons stx out-stxes)
                   resolve-warnings))

            (ELSE
             (loop (cdr in-stxes)
                   (cons stx out-stxes)
                   (cons (quasisyntax/loc stx
                           ("McFly INTERNAL ERROR: Unknown syntax: "
                            #,(datum->syntax stx (format "~S" (syntax->datum stx)))))
                         resolve-warnings))))))))

(define (%mcfly-parse:result-stx-or-false->result-stx result-stx-or-false
                                                      #:context-stx context-stx)
  ;; Note: This assumes that any "#f" syntax has already been converted to #f
  ;; rather than syntax.
  (or result-stx-or-false
      (syntax/loc context-stx any)))

(define (%mcfly-parse:unresolved-proc-stx->proto-stx+result-stx+warnings
         #:sym-to-tagged-specs-hash sym-to-tagged-specs-hash
         #:doc-stx                  doc-stx
         #:proto-or-name-stx        proto-or-name-stx
         #:result-stx-or-false      result-stx-or-false
         #:warnings                 warnings)
  ;; TODO: To support things like "case-lambda", we might might have return a
  ;; list of three-element lists, instead of three values.
  ;;
  ;; TODO: !!! Support argument default values.
  ;;
  ;; TODO: !!! Support keyword arguments.
  ;; http://docs.racket-lang.org/guide/contracts-general-functions.html#%28part._contracts-keywords%29
  (let-values (((name-stx name-sym orig-has-proto? warnings)
                (let ((proto-or-name-e (syntax-e proto-or-name-stx)))
                  (if (symbol? proto-or-name-e)
                      (values proto-or-name-stx proto-or-name-e #f warnings)
                      (syntax-parse proto-or-name-stx
                        ;; TODO: We could parse out the existing protos here, for
                        ;; better checking of doc against code.
                        ((NAME:id Xn ...)
                         (values #'NAME proto-or-name-e #t warnings))
                        (ELSE
                         (values #f
                                 #f
                                 #f
                                 (append warnings
                                         `(,(quasisyntax/loc proto-or-name-stx
                                              ("Cannot parse prototype in documentation for procedure "
                                               (racket #,proto-or-name-stx)
                                               "."))))))))))
               ((result-stx-or-false)
                ;; Here, we are changing any "#f" as syntax to #f as value.
                (and result-stx-or-false
                     (syntax-e result-stx-or-false)
                     result-stx-or-false)))
    ;; TODO: Possibly check in other cases as well.  For now, only do anything
    ;; if we know the name and we don't already have a proto.
    (cond

     ((not name-sym)
      (values #f ;; TODO: !!! Really return false here?
              (%mcfly-parse:result-stx-or-false->result-stx result-stx-or-false
                                                            #:context-stx doc-stx)
              warnings))

     (orig-has-proto?
      (values #f ;; TODO: !!! Really return false here?
              (%mcfly-parse:result-stx-or-false->result-stx result-stx-or-false
                                                            #:context-stx doc-stx)
              warnings))

     ((hash-ref sym-to-tagged-specs-hash name-sym #f)
      => (lambda (tagged-specs)
           (let-values (((proto-stx result-stx reverse-warnings)
                         (unify-tagged-specs-for-procedure doc-stx tagged-specs warnings)))
             (values proto-stx result-stx reverse-warnings))))

     (else
      (values (quasisyntax/loc proto-or-name-stx
                (#,name-stx (arg any/c) (... ...)))
              (%mcfly-parse:result-stx-or-false->result-stx result-stx-or-false
                                                            #:context-stx doc-stx)
              (append warnings
                      `(,(quasisyntax/loc proto-or-name-stx
                           ("Procedure "
                            (racket #,proto-or-name-stx)
                            " had no info found.")))))))))

(provide
 mcfly-parse
 (struct-out mcfly-parsedata))
