#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
;; Parts of this file follow the design of Racket's macro-debugger package by Ryan Culpepper,
;; https://github.com/racket/macro-debugger, licensed Apache-2.0 or MIT.

;; Print syntax with scope groups, suffixes, reader forms and occurrence ranges.
(require racket/class racket/pretty racket/string
         macro-debugger/model/stx-util)
(provide layout new-foreground-partition foreground-color-count
         appearance-stx appearance-start appearance-end appearance-parent appearance-full-end
         appearance-taint appearance-taint-count)

(define foreground-color-count 17)

;; Numbers belong to the view, and identify ordered lists of scope identities.
;; Reserving the empty context also keeps source syntax at group zero.
(define (new-foreground-partition [grouping 'macro] [start 1])
  (new
   (class object%
     (super-new)
     (define groups (make-hash '((() . 0))))
     (define next start)
     (define/public (next-number) next)
     (define/public (get-partition stx)
       (define scopes
         (for/list ([scope (in-list (hash-ref (syntax-debug-info stx) 'context null))]
                    #:when (or (eq? grouping 'all) (eq? (vector-ref scope 1) 'macro)))
           (vector-ref scope 0)))
       (if (syntax-property stx 'macro-stepper-hole) 0
           (hash-ref! groups scopes (lambda () (begin0 next (set! next (add1 next))))))))))

;; Preserve syntax until both abbreviation eligibility and suffixes are decided.
(struct printed (stx datum suffix abbreviate? taint)
  #:property prop:custom-write
  (lambda (value out _mode)
    (parameterize ([pretty-print-abbreviate-read-macros (printed-abbreviate? value)])
      (write (printed-datum value) out))))

;; A placeholder is an unbound atom, never a name or a mark-group encounter.
(struct context-hole () #:property prop:custom-write (lambda (_ out _mode) (display "[ HOLE ]" out)))

(define reader-heads '(quote quasiquote unquote unquote-splicing
                            syntax quasisyntax unsyntax unsyntax-splicing))
(define (source-abbreviation? stx)
  (define parts (syntax->list stx))
  (and parts (= (length parts) 2)
       (let ([head (car parts)])
         (and (identifier? head) (memq (syntax-e head) reader-heads)
              (bound-identifier=? head (datum->syntax stx (syntax-e head)))
              (for/and ([get (in-list (list syntax-source syntax-line syntax-column syntax-position
                                            syntax-original? syntax-source-module))])
                (equal? (get stx) (get head)))))))

;; Ordinary names keep their name-only ranges. Escaped symbols need the full
;; token range: an inserted suffix can be inside the reader's vertical bars.
(define (suffix-width value)
  (define suffix (printed-suffix value))
  (if (and (not (string=? suffix ""))
           (string-suffix? (format "~s" (printed-datum value)) suffix))
      (string-length suffix) 0))

(define (list-shape stx)
  (define datum (syntax-e (stx-disarm stx)))
  (and (or (pair? datum) (null? datum))
       (let ([shape (syntax-property stx 'paren-shape)])
         (and (memv shape '(#\[ #\{)) shape))))

(struct appearance (stx start end parent full-end taint taint-count) #:mutable)

(define (layout term #:appearances [appearances #f]
                #:partition [partition (new-foreground-partition)]
                #:suffix-option [suffix-option 'over-limit]
                #:color-count [color-count foreground-color-count]
                #:pretty-abbrev? [pretty-abbrev? #t]
                #:contents [contents #f]
                #:columns [columns 60])
  (define stack null)
  (define suppressed null)
  (define mark-counts (make-hasheq))
  (define coloring null)
  (define converted (make-hasheq))
  (define (convert value)
    (cond [(syntax? value)
           (hash-ref!
            converted value
            (lambda ()
              (define taint
                (cond [(syntax-tainted? value) "tainted"]
                      [(syntax-property value property:unlocked-by-expander) "disarmed"]
                      [(syntax-armed? value) "armed"]
                      [else #f]))
              ;; Inspect removable protection without tainting the contents.
              (define opened (stx-disarm value))
              (define group
                (and (or (not (identifier? value)) (not (eq? suffix-option 'never)))
                     (send partition get-partition value)))
              (define suffix
                (if (and (identifier? value) group
                         (case suffix-option
                           [(always) (positive? group)]
                           [(over-limit) (> group color-count)]
                           [else #f]))
                    (format ":~a" group) ""))
              (define abbrev? (and pretty-abbrev? (source-abbreviation? opened)))
              (define datum
                (cond [(syntax-property value 'macro-stepper-hole) (context-hole)]
                      [abbrev?
                       (define parts (syntax->list opened))
                       ;; The omitted keyword and tail must not allocate groups.
                       (list (syntax-e (car parts)) (convert (cadr parts)))]
                      [(identifier? value)
                       (if (string=? suffix "") (syntax-e value)
                           (string->symbol (string-append (symbol->string (syntax-e value)) suffix)))]
                      [else (convert (syntax-e opened))]))
              (printed value datum suffix abbrev? taint)))]
          [(pair? value) (cons (convert (car value)) (tail (cdr value)))]
          [(vector? value) (list->vector (map convert (vector->list value)))]
          [(box? value) (box (convert (unbox value)))]
          [(hash? value)
           (for/fold ([result (hash-copy-clear value #:kind 'immutable)]) ([(key val) (in-hash value)])
             ;; Keys are retained verbatim; only values participate in preparation.
             (hash-set result key (convert val)))]
          [(prefab-struct-key value)
           => (lambda (key)
                (apply make-prefab-struct key (map convert (cdr (vector->list (struct->vector value))))))]
          [else value]))
  ;; A syntax-wrapped list tail still belongs to the surrounding proper list.
  (define (tail value)
    (define datum (and (syntax? value) (syntax-e (stx-disarm value))))
    (cond [(and (syntax? value) (or (pair? datum) (null? datum)))
           (when (pair? datum) (send partition get-partition value))
           (tail datum)]
          [(pair? value) (cons (convert (car value)) (tail (cdr value)))]
          [(null? value) null]
          [else (convert value)]))
  (define out (open-output-bytes))
  (port-count-lines! out)
  (define (position) (define-values (_line _column pos) (port-next-location out)) (sub1 pos))
  (define starts (make-hasheq))
  (define ranges (make-hasheq))
  (define delimiters (make-hasheqv))
  (parameterize
      ([pretty-print-columns columns]
       [pretty-print-abbreviate-read-macros #f]
       [pretty-print-current-style-table
        (pretty-print-extend-style-table #f '(define-values define-syntaxes) '(define define-syntax))]
       [pretty-print-remap-stylable
        (lambda (value)
          (and (printed? value) (identifier? (printed-stx value)) (syntax-e (printed-stx value))))]
       [pretty-print-pre-print-hook
        (lambda (value _out)
          (when (printed? value)
            (define shape (and (not (printed-abbreviate? value)) (list-shape (printed-stx value))))
            (define hidden? (and (pair? suppressed) (car suppressed)))
            (define taint (and (not hidden?)
                               (not (syntax-property (printed-stx value) 'macro-stepper-hole))
                               (printed-taint value)))
            ;; The window's bracket restoration overwrites these prefixes.
            ;; Preserve their absence without corrupting the program text.
            (define visible-taint (and (not shape) taint))
            (define count
              (if visible-taint
                  (let ([n (add1 (hash-ref mark-counts value 0))])
                    (hash-set! mark-counts value n) n) 0))
            (set! suppressed (cons (or hidden? (equal? taint "tainted")) suppressed))
            (hash-set! starts value (position))
            (set! coloring (cons (printed-stx value) coloring))
            (when appearances
              (define node (appearance (printed-stx value) (file-position out) #f
                                       (and (pair? stack) (car stack)) #f visible-taint count))
              (set-box! appearances (cons node (unbox appearances)))
              (set! stack (cons node stack)))
            (when shape (hash-set! delimiters (file-position out) (char->integer shape)))))]
       [pretty-print-post-print-hook
        (lambda (value _out)
          (when (printed? value)
            (set! suppressed (cdr suppressed))
            ;; Identifier ranges cover only the printed name characters. All
            ;; enclosing ranges and following positions include suffix bytes.
            (define name-suffix-width (suffix-width value))
            (when appearances
              (set-appearance-end! (car stack) (- (file-position out) name-suffix-width))
              (set-appearance-full-end! (car stack) (file-position out))
              (set! stack (cdr stack)))
            (hash-update! ranges (printed-stx value)
                          (lambda (spans)
                            (cons (list (hash-ref starts value) (- (position) name-suffix-width)) spans)) null)
            (define shape (and (not (printed-abbreviate? value)) (list-shape (printed-stx value))))
            (when shape
              (hash-set! delimiters (sub1 (file-position out))
                         (char->integer (if (eqv? shape #\[) #\] #\}))))))])
    (if contents
        (for ([item (in-list contents)])
          (cond [(syntax? item) (pretty-write (convert item) out) (newline out)]
                [else (displayln (if (eq? item 'arrow) "→" item) out)]))
        (pretty-write (convert term) out)))
  (for ([stx (in-list (reverse coloring))])
    (send partition get-partition stx))
  ;; Replace only the delimiters, at byte offsets so Unicode and CRLF do not
  ;; affect the edits. Equal-width replacements leave every recorded range intact.
  (define text (get-output-bytes out))
  (for ([(offset delimiter) (in-hash delimiters)]) (bytes-set! text offset delimiter))
  (values (bytes->string/utf-8 text) ranges))
