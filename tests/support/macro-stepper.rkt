#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Shared source, expansion and wire fixtures for macro steps tests.
(require racket/promise
         racket/runtime-path
         macro-debugger/model/hiding-policies
         macro-debugger/model/trace
         macro-debugger/model/reductions
         macro-debugger/model/reductions-util
         file/sha1
         racket/file
         racket/list
         (only-in "../../racketdap/tools/macro-source.rkt" call-with-macro-source)
         (only-in "../../racketdap/tools/macro-steps/expansion.rkt" expansion-steps)
         (only-in "../../racketdap/tools/macro-steps/answer.rkt" decode-term [expansion-answer
                  compact-expansion-answer]))
(provide request steps-of sample text-of focused-text without-name-suffixes structural-focus model-fixture
                  syntax-objects model-program final-binding-program try-program known-use-program
                  transformer-error-program snapshot-of expansion-answer view-of term-of utf16-slice
                  appearance-text term-named)

(define (request text #:mode [mode "fragment"] #:prefix [prefix ""]
                 #:source [source "untitled:Untitled-1"] #:directory [directory (current-directory)]
                 #:cwd [cwd directory])
  (hasheq 'text text 'mode mode 'prefix prefix 'source (if (path? source) (path->string source) source)
          'sourceIsFile (path? source) 'directory (path->string directory) 'cwd (path->string cwd)))

(define (steps-of text #:hiding [hiding "standard"] #:mode [mode "module"] #:lines [lines #f])
  (call-with-macro-source (request text #:mode mode) (lambda (stx) (expansion-steps stx hiding lines))))

(define sample
  (string-append "#lang racket/base\n"
                 "(define-syntax-rule (guard test result) (unless test result))\n"
                 "(define-syntax-rule (swap! a b) (let ([tmp a]) (set! a b) (set! b tmp)))\n"
                 "(define (f n)\n  (guard (number? n) 'no)\n  n)\n"
                 "(define (g)\n  (define tmp 1)\n  (define other 2)\n  (swap! tmp other)\n  tmp)\n"))

(define (text-of step key) (hash-ref (hash-ref step key) 'text))

(define (focused-text part)
  (define text (regexp-replace* #rx"\r\n" (hash-ref part 'text) "\n"))
  (map (lambda (span) (apply substring text span)) (hash-ref part 'focus)))

;; Structural comparisons predate name suffixes; their fixtures have no
;; source names ending in :N. Other tests check suffixes and exact ranges.
(define (without-name-suffixes text) (regexp-replace* #px":[0-9]+" text ""))

(define (structural-focus part)
  (map (lambda (text) (regexp-replace* #px"\\s+" (without-name-suffixes text) " "))
       (focused-text part)))

(define (model-fixture text [hiding "none"])
  (call-with-macro-source
   (request text #:mode "module")
   (lambda (stx)
     (define-values (_result _events derivation) (trace* stx))
     (parameterize ([macro-policy (if (equal? hiding "none") hide-none-policy standard-policy)])
       (call-with-values (lambda () (reductions+ (force derivation))) list)))))

(define (syntax-objects term)
  (define found '())
  (define (walk term)
    (cond [(syntax? term) (set! found (cons term found)) (walk (syntax-e term))]
          [(pair? term) (walk (car term)) (walk (cdr term))]
          [(vector? term) (for-each walk (vector->list term))]
          [(box? term) (walk (unbox term))]))
  (walk term)
  (reverse found))

(define model-program
  "#lang racket/base\n(require (for-syntax racket/base))\n(define x 1)\n(define-syntax-rule (keep e) e)\n(begin-for-syntax (define p 2) p)\n(keep (let ([y x]) y))\n")

(define final-binding-program
  "#lang racket/base\n(define-syntax-rule (twice e) (list e e))\n(define result (twice 1))\n(displayln result)\n")

(define-runtime-path try-file "../fixtures/macro-try.rkt")

(define try-program (file->string try-file))

(define known-use-program
  "#lang racket/base\n(define-syntax-rule (keep e) e)\n(let ([x 1]) (list x (keep x)))\n")

(define transformer-error-program
  (string-append
   "#lang racket/base\n(require (for-syntax racket/base))\n"
   "(define-syntax (bad stx) (raise-syntax-error 'bad \"fixture failure\" stx))\n"
   "(define-syntax (middle stx) (local-expand #'(bad) 'expression null))\n"
   "(define-syntax (outer stx) (local-expand #'(middle) 'expression null))\n(outer)\n"))

(define (snapshot-of text)
  (hasheq 'sourceHash (bytes->hex-string (sha256-bytes (string->bytes/utf-8 text))) 'sourceVersion 7))

;; Collect lazy positions and inspections for semantic assertions.
(define (collect-positions summary query)
  (define terms (make-hasheq))
  (define sources (make-hasheq))
  (define diagnostics (make-hasheq))
  (define positions
    (for/list ([position (in-range 1 (+ 2 (hash-ref summary 'stepCount)))])
      (define reply (query (hasheq 'mode "position" 'position position)))
      (for ([(tid _) (in-hash (hash-ref reply 'terms))])
        (define inspection (query (hasheq 'mode "inspect" 'position position 'term (symbol->string tid))))
        (hash-set! terms tid (decode-term (hash-ref inspection 'shared) (hash-ref inspection 'termData))))
      (for ([(key value) (in-hash (hash-ref reply 'sources))]) (hash-set! sources key value))
      (for ([(key value) (in-hash (hash-ref reply 'diagnostics))] #:unless (hash-has-key? diagnostics key))
        (hash-set! diagnostics key value))
      reply))
  (hash-set* summary 'terms terms 'sources sources 'diagnostics diagnostics
             'steps (map (lambda (p) (hash-ref p 'record)) (drop-right positions 1))
             'final (hash-ref (last positions) 'final)
             'inspectedPhases (remove-duplicates (append-map (lambda (t) (hash-ref t 'inspectedPhases)) (hash-values terms)))))

(define (expansion-answer steps binders uses term failure original snapshot phases)
  (define query #f)
  (define summary (compact-expansion-answer steps binders uses term failure original snapshot phases
                                           #:retain-inspector (lambda (q) (set! query q))))
  (collect-positions summary query))

(define (view-of text #:hiding [hiding "standard"] #:mode [mode "module"]
                 #:retain-inspector [retain void])
  (call-with-macro-source
   (request text #:mode mode)
   (lambda (stx)
     (define query #f)
     (define summary (expansion-steps stx hiding #:schema-version 2 #:snapshot (snapshot-of text)
                                      #:retain-inspector (lambda (q) (set! query q))))
     (define answer (collect-positions summary query))
     (retain (lambda (tid phases) (query (hasheq 'mode "inspect" 'position (add1 (hash-ref summary 'stepCount))
                                               'term tid 'phases phases))))
     answer)))

(define (term-of answer occurrence)
  (hash-ref (hash-ref answer 'terms) (string->symbol (hash-ref occurrence 'syntaxId))))

(define (utf16-slice text range)
  (define positions (make-hasheqv))
  (define units 0)
  (hash-set! positions 0 0)
  (for ([char (in-string text)] [index (in-naturals 1)])
    (set! units (+ units (if (> (char->integer char) #xffff) 2 1)))
    (hash-set! positions units index))
  (substring text (hash-ref positions (car range)) (hash-ref positions (cadr range))))

(define (appearance-text part occurrence) (utf16-slice (hash-ref part 'text) (hash-ref occurrence 'range)))

(define (term-named answer part name)
  (filter (lambda (o) (equal? (hash-ref (term-of answer o) 'name) name)) (hash-ref part 'occurrences)))
