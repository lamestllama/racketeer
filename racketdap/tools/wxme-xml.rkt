#lang racket/base
(require racket/class racket/gui/base)
(provide xml-box-snip% xml-box-classnames register-xml-boxes!)

(define xml-box-classnames
  '("(lib \"xml-snipclass.ss\" \"xml\")" "(lib \"scheme-snipclass.ss\" \"xml\")"))

;; Both version-1 box formats contain a mode flag followed by an editor.
;; Zero means eliminate whitespace (XML) or splice values (Racket).
;; The editor's public stream methods preserve its snips and style table.
(define xml-box-snip%
  (class editor-snip%
    (init-field kind mode)
    (init [editor (new text%)])
    (super-make-object editor)
    (inherit get-editor get-style set-snipclass)
    (unless (and (member kind '("xml" "racket")) (boolean? mode))
      (error 'wxme "Invalid XML or Racket box mode."))
    (set-snipclass (if (equal? kind "xml") xml-class racket-class))
    (define/public (set-box-mode value)
      (unless (boolean? value) (error 'wxme "Invalid XML or Racket box mode."))
      (set! mode value))
    (define/override (copy)
      (define result (new xml-box-snip% [kind kind] [mode mode] [editor (send (get-editor) copy-self)]))
      (send result set-style (get-style))
      result)
    (define/override (write stream)
      (send stream put (if mode 0 1))
      (unless (send (get-editor) write-to-file stream)
        (error 'wxme "Cannot write embedded box content.")))))

(define (make-box-class kind name)
  (new (class snip-class%
         (super-new)
         (inherit set-classname set-version reading-version)
         (set-classname name)
         (set-version 1)
         (define/override (read stream)
           (unless (= (reading-version stream) 1)
             (error 'wxme "Unsupported XML or Racket box version."))
           (define flag (send stream get-exact))
           (unless (and (send stream ok?) (member flag '(0 1)))
             (error 'wxme "Invalid XML or Racket box mode."))
           (define editor (new text%))
           (unless (send editor read-from-file stream)
             (error 'wxme "Cannot read embedded box content."))
           (new xml-box-snip% [kind kind] [mode (= flag 0)] [editor editor])))))

(define xml-class (make-box-class "xml" (car xml-box-classnames)))
(define racket-class (make-box-class "racket" (cadr xml-box-classnames)))
(define (register-xml-boxes!)
  (define classes (get-the-snip-class-list))
  (for ([reader (list xml-class racket-class)])
    (send classes add reader)
    (unless (eq? reader (send classes find (send reader get-classname)))
      (error 'wxme "A different XML box reader is already registered."))))
