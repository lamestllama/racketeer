#lang racket/base
;; For legal info, see file "info.rkt".

(require syntax/parse)

;;-----------------------------------------------------------------------------

(define unspecified-stx-symbol '<unspecified>)
(define none-stx-symbol '<none>)

(provide unspecified-stx)
(define unspecified-stx
  (read-syntax 'mcfly-unspecified
               (let ((in (open-input-string (symbol->string unspecified-stx-symbol))))
                 (port-count-lines! in)
                 (set-port-next-location! in #f #f #f)
                 in)))

(provide none-stx)
(define none-stx
  (read-syntax 'mcfly-none
               (let ((in (open-input-string (symbol->string none-stx-symbol))))
                 (port-count-lines! in)
                 (set-port-next-location! in #f #f #f)
                 in)))

(define (unspecified-stx? x)
  ;; Note: We are using "syntax-source" here because using equality/identity of
  ;; "unspecified-stx" value alone does not seem to work with phases, when
  ;; apparently we could be comparing multiple copies of "unspecified-stx".
  (and (syntax? x)
       (eq? 'mcfly-unspecified (syntax-source x))))

(define (none-stx? x)
  ;; Note: We are using "syntax-source" here because using equality/identity of
  ;; "unspecified-stx" value alone does not seem to work with phases, when
  ;; apparently we could be comparing multiple copies of "unspecified-stx".
  (and (syntax? x)
       (eq? 'mcfly-none (syntax-source x))))

;;------------------------------------------------------------------------- Unify

(define (%split-heads-and-tails-and-nonpairs things)
  (let loop ((things   (reverse things))
             (heads    '())
             (tails    '())
             (nonpairs '()))
    (if (null? things)
        (values heads tails nonpairs)
        (let ((thing (car things)))
          (cond ((null? thing) (loop (cdr things)
                                     heads
                                     tails
                                     nonpairs))
                ((pair? thing) (loop (cdr things)
                                     (cons (car thing) heads)
                                     (cons (cdr thing) tails)
                                     nonpairs))
                (else          (loop (cdr things)
                                     heads
                                     tails
                                     (cons thing nonpairs))))))))

;; (require overeasy)
;;
;; (test (%split-heads-and-tails-and-nonpairs '())
;;       (values '() '() '()))
;;
;; (test (%split-heads-and-tails-and-nonpairs '((a . b) (c . d) e () f () (g h i)))
;;       (values '(a c g)
;;               '(b d (h i))
;;               '(e f)))

(provide unify-specs)
(define unify-specs
  (letrec
      ((do-spec-tails
        (lambda (ctxt pair-spec-tails)
          (datum->syntax ctxt
                         (do-spec-tails/return-pair
                          ctxt
                          pair-spec-tails))))

       (do-spec-tails/return-pair
        (lambda (ctxt pair-spec-tails)
          (let*-values
              (((heads tails nonpairs)
                (%split-heads-and-tails-and-nonpairs pair-spec-tails))
               ((head-stx)
                (begin
                  (let loop-heads ((heads heads)
                                   (best  #f))
                    (if (null? heads)
                        best
                        (let ((this-head (car heads)))
                          (cond ((null? this-head)
                                 ;; TODO: !!! MAYBE WE SHOULD INCLUDE NULLS, TO
                                 ;; DETECT WHEN ONE PAIR ENDS BEFORE ANOTHER?
                                 (loop-heads (cdr heads) best))
                                ((unspecified-stx? this-head)
                                 (loop-heads (cdr heads) (or best this-head)))
                                (else (let ((this-head-e (syntax-e this-head)))
                                        (cond
                                         ((pair? this-head-e)
                                          (do-spec-tails ctxt
                                                         (cons this-head-e
                                                               (let loop-gather-remaining-pair-heads ((r-heads heads))
                                                                 (if (null? r-heads)
                                                                     '()
                                                                     (let ((this-r-head (car r-heads)))
                                                                       (if (unspecified-stx? this-r-head)
                                                                           (loop-gather-remaining-pair-heads (cdr r-heads))
                                                                           (let ((this-r-head-e (syntax-e this-r-head)))
                                                                             (if (pair? this-r-head-e)
                                                                                 (cons this-r-head-e
                                                                                       (loop-gather-remaining-pair-heads (cdr r-heads)))
                                                                                 ;; TODO: Warn on a non-pair here?
                                                                                 (loop-gather-remaining-pair-heads (cdr r-heads)))))))))))
                                         (else (loop-heads (cdr heads)
                                                           ;; TODO: If there's already
                                                           ;; a best, maybe generate a
                                                           ;; warning, unless best and
                                                           ;; this-head agree.
                                                           (if (or (not best) (unspecified-stx? best))
                                                               this-head
                                                               best))))))))))))
               ((head-stx)
                (if (and head-stx (not (unspecified-stx? head-stx)))
                    head-stx
                    (let loop ((nonpairs nonpairs)
                               (best     #f))
                      (if (null? nonpairs)
                          best
                          (let ((this-nonpair (car nonpairs)))
                            (if (unspecified-stx? this-nonpair)
                                ;; TODO: !!! THIS IS NOT HANDLING PAIRS WELL.
                                ;; WE GET HERE IF WE ARE NOT HANDLING PAIRS
                                ;; WELL.  DO WE WANT TO *NOT* PASS AROUND
                                ;; SYNTAX-E AS WE RECURSE, BUT INSTEAD
                                ;; RE-ENCODE THE STX FOR EACH STEP OF THE
                                ;; RECURSION ALONG A LIST?
                                (loop (cdr nonpairs) (or best this-nonpair))
                                ;; TODO: !!! CHECK REMAINDER FOR COMPATIBILITY
                                ;; WITH THIS ONE?
                                this-nonpair
                                )))))))
            (if (null? tails)
                (if head-stx
                    (cons head-stx '())
                    '())
                (cons (or head-stx unspecified-stx)
                      (do-spec-tails/return-pair ctxt tails)))))))
    (lambda (ctxt specs)
      (car
       (do-spec-tails/return-pair ctxt (map list specs))))))

(define (%mcfly:spec->spec-with-unspecifieds-replaced+replacement-count spec)
  (let* ((unspecified-count 0)
         (spec (let loop ((spec spec))
                 (cond ((unspecified-stx? spec)
                        (begin0 (quasisyntax/loc spec
                                  #,(string->symbol (format "unspecified-~A"
                                                            unspecified-count)))
                          (set! unspecified-count (+ 1 unspecified-count))))
                       ((pair? spec) (map loop spec))
                       (else (let ((spec-e (syntax-e spec)))
                               (if (pair? spec-e)
                                   (loop spec-e)
                                   spec)))))))
    (values spec
            unspecified-count)))

(provide unify-tagged-specs-for-procedure)
(define (unify-tagged-specs-for-procedure ctxt tagged-specs reverse-warnings)
  ;; TODO: Only include procedure contract and lambda specs (give warnings on
  ;; other tags, and on non-procedure contracts).
  ;;
  ;; TODO: We need to error-check these.  Contracts and lambdas might not
  ;; agree, for example.  Or we might get info for both procedure and some
  ;; non-procedure.
  ;;
  ;; TODO: We might want to sort these, perhaps at the same time we're error-checking.
  (let*-values (((specs)                (map cdr tagged-specs))
                ((unified-spec)         (unify-specs ctxt specs))
                ((unified-spec count)   (%mcfly:spec->spec-with-unspecifieds-replaced+replacement-count
                                         unified-spec))
                ((proto-stx result-stx) (procedure-spec->scribble-prototype+result
                                         unified-spec)))
    (values proto-stx
            result-stx
            (if (zero? count)
                reverse-warnings
                (cons #`("Procedure information had unspecified values: "
                         (tt (racketresult #,unified-spec)))
                      reverse-warnings)))))

;;-----------------------------------------------------------------------------

;; (procedure PROTOTYPE RESULT-OPT)
;;
;; (prototype NAME/FALSE/PROTOTYPE ARGUMENTS)
;;
;; (argument KEYWORD/FALSE NAME/FALSE CONTRACT-OPT DEFAULT-OPT)
;; (ellipses-argument)
;; (ellipses-plus-argument)
;;
;; DEFAULT-OPT ::= #f | (default EXPR)

(define-splicing-syntax-class nonrest-lambda-arg
  #:attributes  (parsed)
  #:description "non-rest lambda argument"
  (pattern NAME:id
           #:with parsed #`(argument #f      NAME #,unspecified-stx #,none-stx))
  (pattern (NAME:id DEFAULT:expr)
           #:with parsed #`(argument #f      NAME #,unspecified-stx DEFAULT))
  (pattern (~seq KEYWORD:keyword NAME:id)
           #:with parsed #`(argument KEYWORD NAME #,unspecified-stx #,none-stx))
  (pattern (~seq KEYWORD:keyword (NAME:id DEFAULT:expr))
           #:with parsed #`(argument KEYWORD NAME #,unspecified-stx DEFAULT))
  (pattern (~seq (~datum ...))
           #:with parsed #`(ellipses-argument))
  (pattern (~seq (~datum ...+))
           #:with parsed #`(ellipses-plus-argument)))

;; (define-splicing-syntax-class nonrest-lambda-args
;;   #:attributes  (parsed)
;;   #:description "non-rest lambda arguments"
;;   (pattern (~seq ARG:lambda-arg ...)
;;            #:with parsed #'(arguments-!!! (ARG.parsed ...) !!!)))

(provide lambda-formal-stx->spec)
(define (lambda-formal-stx->spec name-stx stx)
  (syntax-parse stx
    (NAME:id
     #`(procedure (prototype #,name-stx
                             ((argument #f NAME #,unspecified-stx #,none-stx)
                              (ellipses-argument)))
                  #,unspecified-stx))
    ((NONREST-ARG:nonrest-lambda-arg ...)
     #`(procedure (prototype #,name-stx
                             (NONREST-ARG.parsed ...))
                  #,unspecified-stx))
    ((NONREST-ARG:nonrest-lambda-arg ...+ . RESTNAME:id)
     #`(procedure (prototype #,name-stx
                             (NONREST-ARG.parsed ...
                                                 (argument #f
                                                           RESTNAME
                                                           #,unspecified-stx
                                                           #,none-stx)
                                                 (ellipses-argument)))
                  #,unspecified-stx))

    ((NONREST-ARG:nonrest-lambda-arg ...+ . (RESTNAME:id DEFAULT))
     #`(procedure (prototype #,name-stx
                             (NONREST-ARG.parsed ...
                                                 (argument #f
                                                           RESTNAME
                                                           #,unspecified-stx
                                                           DEFAULT)
                                                 (ellipses-argument)))
                  #,unspecified-stx))

    (ELSE
     (error 'lambda-formal-stx->spec
            "unrecognized lambda argument syntax: ~S"
            stx))))

(provide contract-stx->spec-or-false)
(define (contract-stx->spec-or-false id-stx stx)
  (syntax-parse stx
    (((~datum ->) ARG ... RESULT)
     ;; TODO: !!! This doesn't handle any keyword arguments in the contract.
     ;; Use syntax class for ARG.
     (quasisyntax/loc stx
       (procedure (prototype #,id-stx
                             ((argument #f #,unspecified-stx ARG #,unspecified-stx) ...))
                  RESULT)))
    ;; TODO: Support currying.
    ;;
    ;; TODO: Support other contract forms.
    (ELSE #f)))

;;-----------------------------------------------------------------------------

;; TODO: !!! get rid of "procedure-spec+body->scribble-defproc"
(provide procedure-spec+body->scribble-defproc)
(define (procedure-spec+body->scribble-defproc spec-stx body-stx)
  ;; TODO: !!! parameterize for name of procedure here, if it's #f?
  (syntax-parse spec-stx
    ;; TODO: Handle no RESULT in RESULT-OPT?
    (((~datum procedure) PROTOTYPE RESULT)
     #`(defproc #,(prototype-spec->scribble-defproc-prototype #'PROTOTYPE)
         RESULT ;; TODO: !!! Do anything translation on RESULT?
         #,@body-stx))))

(provide procedure-spec->scribble-prototype+result)
(define (procedure-spec->scribble-prototype+result spec-stx)
  ;; TODO: !!! parameterize for name of procedure here, if it's #f?
  (syntax-parse spec-stx
    ;; TODO: Handle no RESULT in RESULT-OPT?
    (((~datum procedure) PROTOTYPE RESULT)
     (values (prototype-spec->scribble-defproc-prototype #'PROTOTYPE)
             #'RESULT))))

(define (prototype-spec->scribble-defproc-prototype prototype-stx)
  ;; (prototype NAME/FALSE/PROTOTYPE ARGUMENTS)

  (syntax-parse prototype-stx

    ;; TODO: Do we need to handle #f for NAME/FALSE/PROTOTYPE ?

    (((~datum prototype) NAME:id (ARGUMENT ...))
     #`(NAME #,@(map argument-spec->scribble-defproc-prototype-argument
                     (syntax->list #'(ARGUMENT ...)))))

    (((~datum prototype) (PROTOTYPE ...) (ARGUMENT ...))
     #`(#,(prototype-spec->scribble-defproc-prototype #'(PROTOTYPE ...))
        #,(map argument-spec->scribble-defproc-prototype-argument
               (syntax->list #'(ARGUMENT ...)))))))

(define (argument-spec->scribble-defproc-prototype-argument argument-stx)
  ;; (argument KEYWORD/FALSE NAME/FALSE CONTRACT-OPT DEFAULT-OPT)
  ;; (ellipses-argument)
  ;; (ellipses-plus-argument)
  (syntax-parse argument-stx
    (((~datum argument) #f NAME:id CONTRACT DEFAULT)
     (if (none-stx? #'DEFAULT)
         #'(NAME CONTRACT)
         #'(NAME CONTRACT DEFAULT)))
    (((~datum argument) KEYWORD:keyword NAME:id CONTRACT DEFAULT)
     (if (none-stx? #'DEFAULT)
         #'(KEYWORD NAME CONTRACT)
         #'(KEYWORD NAME CONTRACT DEFAULT)))
    (((~datum argument) X ...)
     (error 'argument-spec->scribble-defproc-prototype-argument
            "could not parse ~S"
            (syntax->datum argument-stx)))
    (((~datum ellipses-argument))
     #'(... ...))
    (((~datum ellipses-plus-argument))
     #'(... ...+))))
