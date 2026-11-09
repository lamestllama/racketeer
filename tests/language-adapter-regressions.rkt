#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/class racket/file racket/path racket/port racket/runtime-path
         "../racketdap/language-adapters.rkt"
         "../racketdap/worker/load.rkt")

(define-runtime-path bundled "../vendor/collects")
(define-runtime-path debug-loader "../racketdap/worker/load.rkt")
(define-runtime-path hook "../vendor/collects/racket-langserver/doclib/language-adapter.rkt")
(define-runtime-path patch "../vendor/patches/language-adapter-discovery.patch")
(define (tag descriptor) (hash-ref (hash-ref descriptor 'editor) 'source-details))
(define (with-project proc)
  (define root (make-temporary-file "adapter-regression~a" 'directory))
  (define (put name contents)
    (define file (build-path root name))
    (make-directory* (path-only file))
    (display-to-file contents file #:exists 'truncate)
    file)
  (dynamic-wind void
    (lambda ()
      (parameterize ([current-library-collection-paths (cons root (current-library-collection-paths))]
                     [current-namespace (make-base-namespace)]
                     [current-directory root])
        (proc root put)))
    (lambda () (delete-directory/files root))))

(module+ reader-count
  (for* ([instrument? '(#f #t)] [plain? '(#f #t)])
    (test-case (format "reader runs once: instrument ~a, plain ~a" instrument? plain?)
      (with-project
       (lambda (root put)
         (define count (build-path root "count"))
         (define reader
           (put "reader.rkt"
                (format "#lang racket/base\n(require racket/port racket/file)\n(provide read-syntax)\n(define (read-syntax source in)\n (display-to-file \"x\" ~s #:exists 'append)\n (port->string in)\n (datum->syntax #f '~s))\n"
                        (path->string count)
                        (if plain? '(define (answer) 42)
                            '(module program racket/base (provide answer) (define (answer) 42))))))
         (define source (put "program.rkt" (format "#reader (file ~s)\n" (path->string reader))))
         (check-equal? (run-module source #:instrument? instrument?
                                  #:language (and plain? 'racket/base) #:entry 'answer) 42)
         (check-equal? (file->string count) "x"))))))

(module+ cached-reader-count
  (for ([warm? '(#f #t)])
    (test-case (if warm? "warm cached child launch does not invoke its reader"
                        "cold cached child launch invokes its reader once")
      (with-project
       (lambda (root put)
         (define run-cached-module (dynamic-require debug-loader 'run-module))
         (define count (build-path root "count"))
         (define reader
           (put "reader.rkt"
                (format "#lang racket/base\n(require racket/file racket/port)\n(provide read-syntax)\n(define (read-syntax source in)\n (when (and (file-exists? ~s) (>= (file-size ~s) ~a)) (error 'reader \"too many reader calls\"))\n (display-to-file \"x\" ~s #:exists 'append)\n (port->string in)\n (datum->syntax #f '(module program racket/base (module child racket/base (provide answer) (define (answer) 42))) (list source 1 0 1 1)))\n"
                        (path->string count) (path->string count) 2
                        (path->string count))))
         (define source (put "program.rkt" (format "#reader (file ~s)\n" (path->string reader))))
         (define cache (build-path root "cache"))
         (define selected #f)
         (define (launch [explicit #f])
           (run-cached-module source #:instrument? #t #:cache-directory cache
                              #:submodule '(child) #:entry 'answer #:language-adapter explicit
                              #:on-language-adapter
                              (lambda (identity descriptor)
                                (when (equal? identity `(submod ,source child)) (set! selected descriptor)))))
         (check-equal? (launch) 42)
         (when warm? (check-equal? (launch) 42))
         (check-equal? (file->string count) "x")
         (check-equal? (tag selected) 'auto)
         (define explicit (put "chosen.rktd" "(profile (editor (source-details sexp)))"))
         (check-equal? (launch explicit) 42)
         (check-equal? (tag selected) 'sexp)
         ;; A new descriptor changes the cache basis; its next launch reuses it.
         (check-equal? (launch explicit) 42)
         (check-equal? (file->string count) "xx"))))))

(module+ nested-wrappers
  (test-case "nested wrappers retain the supplying reader's relative provider"
    (with-project
     (lambda (root put)
       (put "outer/lang/reader.rkt"
            "#lang racket/base\n(require syntax/module-reader)\n(provide (rename-out [rd read] [rs read-syntax] [gi get-info]))\n(define-values (rd rs gi)\n (make-meta-reader 'outer \"language path\" lang-reader-module-paths values values\n  (lambda (delegate) (lambda (key default)\n   (if (eq? key 'racketeer:language-profile) '#((file \"provider.rkt\") profile #f) (delegate key default))))))")
       (put "outer/lang/provider.rkt"
            "#lang racket/base\n(provide profile)\n(define (profile request data) '(profile (editor (source-details shrubbery))))")
       (for ([inner '(inner absent)])
         (put (format "~a/lang/reader.rkt" inner) "#lang s-exp syntax/module-reader\nracket/base")
         (when (eq? inner 'inner)
           (put "inner/lang/provider.rkt"
                "#lang racket/base\n(provide profile)\n(define (profile request data) '(profile (editor (source-details none))))"))
         (for ([prefix '("" "at-exp " "at-exp at-exp ")])
           (define text (format "#lang ~aouter ~a\n(void)" prefix inner))
           (define source (put "program.rkt" text))
           (test-case text
             (check-equal? (tag (resolve-language-adapter source #:text text)) 'shrubbery))))))))

(module+ submodule-launch
  (test-case "mixed-language submodule launch retains module identity and explicit scope"
    (with-project
     (lambda (root put)
       (define source
         (put "program.rkt" "#lang racket/base\n(module child racket (provide answer) (define (answer) 42))\n(module sibling racket/base (void))\n"))
       (put ".racketeer/provider.rkt"
            "#lang racket/base\n(require racket/match syntax/modresolve)\n(provide profile)\n(define (profile request data)\n (define child? (equal? (hash-ref request 'submodules) '(child)))\n (unless (equal? (hash-ref request 'language) (resolve-module-path (if child? 'racket 'racket/base) #f)) (error 'identity \"wrong language\"))\n (when (hash-ref request 'pre)\n  (unless (equal? (resolve-module-path (caddr (syntax->datum (hash-ref request 'pre))) #f) (resolve-module-path (if child? 'racket 'racket/base) #f)) (error 'identity \"wrong syntax: ~s\" (syntax->datum (hash-ref request 'pre)))))\n `(profile (match (language ,(if child? 'racket 'racket/base))) (editor (source-details ,(if child? 'shrubbery 'none)))))")
       (put ".racketeer/language-adapters.rktd" "(#((file \"provider.rkt\") profile #f))")
       (define explicit (put "chosen.rktd" "(profile (editor (source-details sexp)))"))
       (for* ([instrument? '(#f #t)] [chosen (list #f explicit)])
         (define selected (make-hash))
         (check-equal?
          (run-module source #:submodule '(child) #:entry 'answer #:instrument? instrument?
                      #:workspace root #:language-adapter chosen
                      #:on-language-adapter (lambda (identity descriptor) (hash-set! selected identity descriptor))) 42)
         (check-equal? (tag (hash-ref selected source)) 'none)
         (check-equal? (tag (hash-ref selected `(submod ,source child))) (if chosen 'sexp 'shrubbery))
         (check-false (hash-has-key? selected `(submod ,source sibling))))))))


(module+ submodule-launch
  (test-case "nested child retains its own legacy information"
    (with-project
     (lambda (root put)
       (define info
         (put "info.rkt"
              "#lang racket/base\n(provide info)\n(define (info tag) (lambda (key default) (if (eq? key 'racketeer:language-profile) `(profile (editor (source-details ,tag))) default)))"))
       (define child
         (syntax-property (datum->syntax #f '(module child racket (void)))
                          'module-language (vector info 'info 'shrubbery)))
       (define parent
         (syntax-property
          (datum->syntax #f `(module parent racket/base (module container racket/base ,child)))
          'module-language (vector info 'info 'none)))
       (check-equal?
        (tag (resolve-language-adapter (build-path root "program.rkt")
                                      #:text "" #:pre parent #:submodules '(container child)))
        'shrubbery)))))

(module+ open-pipe
  (test-case "disabled server hook reads a complete module without waiting for pipe EOF"
    (parameterize ([current-library-collection-paths (cons bundled (current-library-collection-paths))])
      (define expand-source (dynamic-require 'racket-langserver/doclib/check-syntax 'expand-source))
      (define path->source (dynamic-require 'racket-langserver/common/source 'path->source))
      (define pre-syntax (dynamic-require 'racket-langserver/doclib/internal-types 'ExpandResult-pre-syntax))
      (define collector%
        (dynamic-require 'racket-langserver/doclib/check-syntax-compat 'check-syntax-annotations-mixin))
      (define-values (in out) (make-pipe))
      (display "(module sample racket/base (void))\n" out)
      (flush-output out)
      (define result #f)
      (define worker
        (thread (lambda ()
                  (set! result
                        (expand-source (path->source (build-path (current-directory) "pipe.rkt"))
                                       in (new (collector% object%)) #:expand? #f)))))
      (dynamic-wind void
        (lambda ()
          (check-not-false (sync/timeout 5 worker))
          (check-true (and result (syntax? (pre-syntax result)))))
        (lambda () (kill-thread worker) (close-input-port in) (close-output-port out))))))

(module+ notice
  (test-case "bundled hook and patch carry copyright and licence notices"
    (for ([file (list hook patch)])
      (define text (file->string file))
      (check-regexp-match #rx"Copyright \\(c\\) 2026 Eric Parsonage" text)
      (check-regexp-match #rx"SPDX-License-Identifier: Apache-2.0 OR MIT" text))))

(module+ relative-language
  (test-case "a child with an enclosing-module-relative language launches without an adapter"
    (with-project
     (lambda (root put)
       (define source
         (put "program.rkt"
              "#lang racket/base\n(module lang racket/base (provide (all-from-out racket/base)))\n(module child (submod \"..\" lang) (provide answer) (define (answer) 42) (module* inherited #f (provide answer)))\n"))
       (for ([children '((child) (child inherited))])
         (check-equal? (run-module source #:instrument? #f #:submodule children #:entry 'answer) 42)
         (check-equal?
          (tag (resolve-language-adapter source #:submodules children
                 #:registry `((profile (match (language (submod ,source lang)))
                                       (editor (source-details sexp)))))) 'sexp))
       (check-equal?
        (tag (resolve-language-adapter source #:language 'unavailable-adapter-language)) 'auto)
       (define shared
         (put "shared.rkt" "#lang racket/base\n(module+ child (provide answer) (define (answer) 42))\n"))
       (put ".racketeer/language-adapters.rktd"
            "((profile (match (language racket/base)) (editor (source-details sexp))))")
       (for ([instrument? '(#f #t)])
         (define selected #f)
         (check-equal?
          (run-module shared #:instrument? instrument? #:submodule '(child) #:entry 'answer
                      #:workspace root
                      #:on-language-adapter
                      (lambda (identity descriptor)
                        (when (equal? identity `(submod ,shared child)) (set! selected descriptor)))) 42)
         (check-equal? (tag selected) 'sexp))))))

(module+ generated-language
  (for* ([kind '(local imported imported-syntax module+ custom nested)]
         [instrument? '(#f #t)])
    (test-case (format "generated child inherits its enclosing descriptor: ~a, instrument ~a"
                       kind instrument?)
      (with-project
       (lambda (root put)
         (put "info.rkt"
              "#lang racket/base\n(provide info)\n(define (info data) (lambda (key default) (if (eq? key 'racketeer:language-profile) '(profile (editor (source-details none))) default)))")
         (put "macros.rkt"
              "#lang racket/base\n(provide make-child)\n(define-syntax-rule (make-child) (module child racket (provide answer) (define (answer) 42)))")
         (put "syntax-macros.rkt"
              "#lang racket/base\n(require (for-syntax racket/base))\n(provide make-child)\n(define-syntax (make-child stx) (datum->syntax stx '(module child racket (provide answer) (define (answer) 42))))")
         (define lang
           (put "lang.rkt" "#lang racket/base\n(provide (all-from-out racket/base))"))
         (define body
           (case kind
             [(local)
              "(require (for-syntax racket/base))\n(begin-for-syntax (displayln 'expanded))\n(define-syntax (make-child stx) (syntax-property #'(module child racket (provide answer) (define (answer) 42)) 'module-language '#(\"info.rkt\" info #f)))\n(make-child)"]
             [(imported) "(require \"macros.rkt\")\n(make-child)"]
             [(imported-syntax) "(require \"syntax-macros.rkt\")\n(make-child)"]
             [(module+)
              "(define-syntax-rule (make-child) (module+ child (provide answer) (define (answer) 42)))\n(make-child)"]
             [(custom)
              "(define-syntax-rule (make-child) (module child racket (provide answer) (define (answer) 42)))\n(make-child)"]
             [(nested)
              "(module container racket (define-syntax-rule (make-child) (module child racket/base (provide answer) (define (answer) 42))) (make-child))"]))
         (define source
           (put "program.rkt"
                (string-append (if (eq? kind 'custom) "#lang s-exp \"lang.rkt\"\n" "#lang racket/base\n")
                               body "\n")))
         (put ".racketeer/language-adapters.rktd"
              (format "((profile (match (language racket/base)) (editor (source-details sexp))) (profile (match (language racket)) (editor (source-details shrubbery))) (profile (match (language ~s)) (editor (source-details none))))" `(file ,(path->string lang))))
         (define children (if (eq? kind 'nested) '(container child) '(child)))
         (define expected (case kind [(nested) 'shrubbery] [(custom) 'none] [else 'sexp]))
         (define selected (make-hash))
         (define output
           (with-output-to-string
             (lambda ()
               (check-equal?
                (run-module source #:instrument? instrument? #:submodule children #:entry 'answer
                            #:workspace root
                            #:on-language-adapter
                            (lambda (identity descriptor) (hash-set! selected identity descriptor))) 42))))
         (check-equal? output (if (eq? kind 'local) "expanded\n" ""))
         (check-equal? (tag (hash-ref selected `(submod ,source ,@children))) expected)
         (check-equal? (tag (resolve-language-adapter source #:submodules children #:workspace root))
                       expected))))))

(module+ compiled-generated-language
  (test-case "compiled generated child inherits its enclosing legacy descriptor"
    (with-project
     (lambda (root put)
       (define info
         (put "info.rkt"
              "#lang racket/base\n(provide info)\n(define (info tag) (lambda (key default) (if (eq? key 'racketeer:language-profile) `(profile (editor (source-details ,tag))) default)))"))
       (define parent
         (syntax-property
          (datum->syntax #f '(module program racket/base
                              (define-syntax-rule (make-child)
                                (module child racket (provide answer) (define (answer) 42)))
                              (make-child)))
          'module-language (vector info 'info 'none)))
       (define source (build-path root "program.zo"))
       (call-with-output-file source (lambda (out) (write (compile parent) out)))
       (check-equal? (tag (resolve-language-adapter source #:text "" #:pre parent
                                                 #:submodules '(child))) 'none)
       (define selected #f)
       (check-equal?
        (run-module source #:instrument? #f #:submodule '(child) #:entry 'answer
                    #:on-language-adapter (lambda (_ descriptor) (set! selected descriptor))) 42)
       (check-equal? (tag selected) 'none)
       (check-equal? (tag (resolve-language-adapter source #:submodules '(child))) 'none)))))

(module+ plain-module-begin
  (test-case "a child in a plain module body launches without an adapter"
    (with-project
     (lambda (root put)
       (define source
         (put "program.rkt"
              "(module program racket/base (#%plain-module-begin (module child racket/base (provide answer) (define (answer) 42))))\n"))
       (check-equal? (run-module source #:instrument? #f #:submodule '(child) #:entry 'answer) 42)))))

(module+ test
  (require (submod ".." reader-count)
           (submod ".." cached-reader-count)
           (submod ".." nested-wrappers)
           (submod ".." submodule-launch)
           (submod ".." open-pipe)
           (submod ".." notice)
           (submod ".." relative-language)
           (submod ".." generated-language)
           (submod ".." compiled-generated-language)
           (submod ".." plain-module-begin)))
