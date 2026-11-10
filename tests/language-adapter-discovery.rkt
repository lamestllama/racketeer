#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/path racket/port racket/runtime-path)

(define-runtime-path loader "../racketdap/language-adapters.rkt")
(define-runtime-path debug-loader "../racketdap/worker/load.rkt")
(define-runtime-path macro-source "../racketdap/tools/macro-source.rkt")
(define-runtime-path macro-expansion "../racketdap/tools/macro-steps/expansion.rkt")
(define-runtime-path bridge "../vscode/language-adapters.rkt")
(define-runtime-path environment "../vscode/racket-environment.rkt")
(define-runtime-path analysis "../vscode/workspace-analysis-worker.rkt")
(define (api name) (dynamic-require loader name))
(define (tag descriptor) (hash-ref (hash-ref descriptor 'editor) 'source-details))
(define (profile tag) `(profile (editor (source-details ,tag))))
(define (with-project proc)
  (define root (make-temporary-file "adapter~a" 'directory))
  (define (put name contents)
    (define path (build-path root name))
    (make-directory* (path-only path))
    (display-to-file contents path #:exists 'truncate)
    path)
  (put "adapter-test/lang/reader.rkt"
    "#lang s-exp syntax/module-reader\nracket/base\n#:info info\n(define (info key default fallback)\n (if (eq? key 'racketeer:language-profile)\n '(profile (editor (source-details sexp))) (fallback key default)))\n")
  (define text "#lang adapter-test\n(error 'body \"must not run during selection\")\n")
  (define source (put "project/program.rkt" text))
  (parameterize ([current-library-collection-paths (cons root (current-library-collection-paths))]
                 [current-namespace (make-base-namespace)]
                 [current-directory root])
    (proc root source text put)))
(define (select source text)
  ((api 'resolve-language-adapter) source #:text text #:workspace (path-only source)))
(define (override put datum)
  (put "project/.racketeer/language-adapters.rktd" (format "~s" datum)))

(module+ test
  (test-case "reader discovery selects inline data without running the module body"
    (with-project (lambda (root source text put)
      (check-equal? (tag (select source text)) 'sexp)
      (check-equal? (tag (select source
        (format "; λ😀\r\n#; (ignored)\r\n#reader (file ~s)\n(error 'body)"
                (path->string (build-path root "adapter-test/lang/reader.rkt"))))) 'sexp)
      (parameterize ([current-load-relative-directory (build-path root "adapter-test/lang")])
        (check-equal? (tag ((api 'resolve-language-adapter) "untitled:reader"
                            #:text "#reader \"reader.rkt\"\n(error 'body)")) 'sexp)))))

  (test-case "project entries replace reader data and an empty project list permits fallback"
    (with-project (lambda (_ source text put)
      (override put '((profile (match (language racket/base)) (editor (source-details none)))))
      (check-equal? (tag (select source text)) 'none)
      (override put '((profile (match (language racket/base)))))
      (check-equal? (tag (select source text)) 'auto)
      (override put '())
      (check-equal? (tag (select source text)) 'sexp))))

  (test-case "explicit files win, resolve relative to cwd or workspace, and need no match"
    (with-project (lambda (root source text put)
      (override put '((profile (match (language racket/base)) (editor (source-details none)))))
      (put "project/chosen.rktd" (format "~s" (profile 'shrubbery)))
      (put "elsewhere/chosen.rktd" (format "~s" (profile 'none)))
      (check-equal? (tag ((api 'resolve-language-adapter) source #:text text
                         #:workspace (path-only source) #:explicit "chosen.rktd")) 'shrubbery)
      (check-equal? (tag ((api 'resolve-language-adapter) source #:text text
                         #:workspace (path-only source) #:cwd (build-path root "elsewhere")
                         #:explicit "chosen.rktd")) 'none)
      (put "project/decline.rkt" "#lang racket/base\n(provide profile)\n(define (profile request data) #f)")
      (define decline (put "project/decline.rktd" "#((file \"decline.rkt\") profile #f)"))
      (check-equal? (tag ((api 'resolve-language-adapter) source #:text text
                          #:workspace (path-only source) #:explicit decline)) 'none))))

  (test-case "invalid entries, duplicate matches and unavailable providers never fall through"
    (with-project (lambda (_ source text put)
      (for ([datum (list '((profile (editor (source-details none))))
                       '(#f)
                       '((profile (match (language racket/base))) (profile (match (language racket/base))))
                       '(#((file "absent.rkt") profile #f)))])
        (override put datum)
        (check-exn #rx"language-adapters.rktd.*(match|profile)" (lambda () (select source text))))
      (put "project/bad.rktd" "(profile (version 2))")
      (check-exn #rx"bad.rktd.*version" (lambda ()
        ((api 'resolve-language-adapter) source #:text text #:explicit (build-path (path-only source) "bad.rktd")))))))

  (test-case "descriptor input refuses reader, language, compiled directives and trailing data"
    (with-project (lambda (_ source text put)
      (for ([contents '("#reader racket/base (profile)" "#lang racket/base\n(profile)" "#~" "(profile) (profile)" "#f")])
        (define file (put "project/unsafe.rktd" contents))
        (check-exn #rx"unsafe.rktd.*profile" (lambda ()
          ((api 'resolve-language-adapter) source #:text text #:explicit file))))
      (define ordinary (put "project/ordinary.rktd" "(profile)"))
      (parameterize ([current-readtable (make-readtable #f #\( 'terminating-macro
                           (lambda arguments (error 'custom "descriptor used a language readtable")))])
        (check-equal? (tag ((api 'resolve-language-adapter) source
                            #:text text #:explicit ordinary)) 'auto)))))

  (test-case "profile providers use the supplying data file for relative module paths"
    (with-project (lambda (_ source text put)
      (put "project/.racketeer/provider.rkt" "#lang racket/base\n(provide profile)\n(define (profile request data)\n (unless (and (immutable? request) (eq? (hash-ref request 'operation) 'profile) (hash-ref request 'selection)) (error 'request))\n (displayln \"provider output\")\n `(profile (match (language racket/base)) (editor (source-details ,data))))")
      (override put '(#((file "provider.rkt") profile none)))
      (define output (open-output-string))
      (parameterize ([current-output-port output]) (check-equal? (tag (select source text)) 'none))
      (check-equal? (get-output-string output) ""))))

  (test-case "wrappers delegate the info query while retaining the ordered reader chain"
    (with-project (lambda (_ source text put)
      (define wrapped "#lang at-exp adapter-test\n(define x @list{hello})\n")
      (check-equal? (tag (select source wrapped)) 'sexp)
      (put "project/.racketeer/capture.rkt" "#lang racket/base\n(provide profile)\n(define (profile request data)\n (unless (>= (length (hash-ref request 'reader)) 2) (error 'reader \"missing wrapper\"))\n '(profile (match (language racket/base))))")
      (override put '(#((file "capture.rkt") profile #f)))
      (void (select source wrapped)))))

  (test-case "legacy module-language info precedes the built-in registry"
    (with-project (lambda (_ source text put)
      (define info (put "project/info.rkt" "#lang racket/base\n(provide info)\n(define (info data) (lambda (key default) (if (eq? key 'racketeer:language-profile) '(profile (editor (source-details none))) default)))"))
      (define pre (syntax-property (datum->syntax #f '(module m racket/base (void)))
                                   'module-language (vector info 'info #f)))
      (define registry '((profile (match (language racket/base)) (editor (source-details shrubbery)))))
      (check-equal? (tag ((api 'resolve-language-adapter) source #:text "(module m racket/base (void))"
                          #:pre pre #:registry registry)) 'none)
      (check-equal? (tag ((api 'resolve-language-adapter) source #:text "(module m racket/base (void))"
                          #:registry registry)) 'shrubbery)
      (define compiled (build-path (path-only source) "legacy.zo"))
      (parameterize ([current-namespace (make-base-namespace)])
        (call-with-output-file compiled (lambda (out) (write (compile pre) out))))
      (check-equal? (tag ((api 'resolve-language-adapter) compiled)) 'none)
      (define dialect (put "project/dialect.rkt" "#lang racket/base\n(provide (all-from-out racket/base))"))
      (parameterize ([current-load-relative-directory (path-only source)])
        (check-equal? (tag ((api 'resolve-language-adapter) "untitled:dialect"
                            #:text "#lang s-exp \"dialect.rkt\"\n(error 'body)"
                            #:registry `((profile (match (language ,dialect))
                                           (editor (source-details none)))))) 'none)))))

  (test-case "reader and variant identities match exactly and an outer reader can replace its delegate"
    (with-project (lambda (_ source text put)
      (override put '((profile (match (reader adapter-test/lang/reader)) (editor (source-details none)))))
      (check-equal? (tag (select source text)) 'none)
      (override put '((profile (match (variants racket/base)) (editor (source-details shrubbery)))))
      (check-equal? (tag (select source text)) 'shrubbery)
      (override put '())
      (put "outer/lang/reader.rkt" "#lang racket/base\n(require syntax/module-reader)\n(provide (rename-out [outer-read read] [outer-syntax read-syntax] [outer-info get-info]))\n(define-values (outer-read outer-syntax outer-info)\n (make-meta-reader 'outer \"language path\" lang-reader-module-paths values values\n  (lambda (delegate) (lambda (key default)\n   (if (eq? key 'racketeer:language-profile) '(profile) (delegate key default))))))")
      (check-equal? (tag (select source "#lang outer adapter-test\n(void)")) 'auto))))

  (test-case "an identity-less compiled module launches without an adapter and accepts an explicit descriptor"
    (with-project (lambda (_ source text put)
      (define compiled (build-path (path-only source) "program.zo"))
      (parameterize ([current-namespace (make-base-namespace)])
        (call-with-output-file compiled (lambda (out) (write (compile '(module m racket/base (void))) out))))
      (check-equal? (tag ((api 'resolve-language-adapter) compiled)) 'auto)
      ((dynamic-require debug-loader 'run-module) compiled #:instrument? #f #:cache-directory #f)
      (define chosen (put "project/compiled.rktd" "#((file \"compiled-provider.rkt\") profile #f)"))
      (put "project/compiled-provider.rkt" "#lang racket/base\n(provide profile)\n(define (profile request data)\n (when (hash-ref request 'selection) (error 'selection \"expected unavailable identity\"))\n '(profile (editor (source-details none))))")
      (check-equal? (tag ((api 'resolve-language-adapter) compiled #:explicit chosen)) 'none)
      (define selected #f)
      ((dynamic-require debug-loader 'run-module) compiled #:instrument? #f #:cache-directory #f
        #:language-adapter chosen #:on-language-adapter (lambda (_ descriptor) (set! selected descriptor)))
      (check-equal? (tag selected) 'none))))

  (test-case "the explicit launch descriptor does not select imported modules or tooling modules"
    (with-project (lambda (_ source text put)
      (put "project/program.rkt" "#lang adapter-test\n(require \"dependency.rkt\")\n(void value)")
      (define dependency (put "project/dependency.rkt" "#lang racket/base\n(provide value)\n(define value 42)"))
      (define explicit (put "project/chosen.rktd" "(profile (editor (source-details shrubbery)))"))
      (put "project/.racketeer/provider.rkt" "#lang racket/base\n(provide profile)\n(define (profile request data) '(profile (match (language racket/base)) (editor (source-details none))))")
      (override put '(#((file "provider.rkt") profile #f)))
      (define selected (make-hash))
      ((dynamic-require debug-loader 'run-module) source #:workspace (path-only source)
        #:source-roots (list (path-only source)) #:language-adapter explicit
        #:on-language-adapter (lambda (path descriptor) (hash-set! selected path descriptor)))
      (check-equal? (tag (hash-ref selected source)) 'shrubbery)
      (check-equal? (tag (hash-ref selected dependency)) 'none)
      (check-equal? (hash-count selected) 2))))

  (test-case "a reader's missing answer permits registry fallback and failures name the field"
    (with-project (lambda (_ source text put)
      (put "absent/lang/reader.rkt" "#lang s-exp syntax/module-reader\nracket/base\n#:info (lambda (key default fallback) (fallback key default))")
      (define registry '((profile (match (language racket/base)) (editor (source-details none)))))
      (check-equal? (tag ((api 'resolve-language-adapter) source #:text "#lang absent\n(void)" #:registry registry)) 'none)
      (put "broken/lang/reader.rkt" "#lang s-exp syntax/module-reader\nracket/base\n#:info (lambda (key default fallback) (if (eq? key 'racketeer:language-profile) (error 'key \"unavailable\") (fallback key default)))")
      (check-exn #rx"program.rkt.*profile.*unavailable" (lambda () (select source "#lang broken\n(void)"))))))

  (test-case "inline file providers use the reader's directory, including at-exp delegation"
    (with-project (lambda (_ source text put)
      (put "relative/lang/provider.rkt" "#lang racket/base\n(provide profile)\n(define (profile request data) '(profile (editor (source-details none))))")
      (put "relative/lang/reader.rkt" "#lang s-exp syntax/module-reader\nracket/base\n#:info (lambda (key default fallback) (if (eq? key 'racketeer:language-profile) '#((file \"provider.rkt\") profile #f) (fallback key default)))")
      (check-equal? (tag (select source "#lang relative\n(void)")) 'none)
      (check-equal? (tag (select source "#lang at-exp relative\n@void{}")) 'none))))

  (test-case "debugger, full document, index and macro source obtain the same descriptor"
    (with-project (lambda (_ source text put)
      (define safe-text "#lang adapter-test\n(define value 42)\n")
      (put "project/program.rkt" safe-text)
      (override put '((profile (match (language racket/base)) (editor (source-details none)))))
      (define expected (select source safe-text))
      (define selected #f)
      ((dynamic-require debug-loader 'run-module) source #:instrument? #f #:workspace (path-only source)
        #:on-language-adapter (lambda (_ descriptor) (set! selected descriptor)))
      ;; Which files a selection observes depends on what this process has loaded.
      (define (descriptor-of adapter)
        (hash-set adapter 'fingerprint (hash-remove (hash-ref adapter 'fingerprint) 'files)))
      (check-equal? (descriptor-of selected) (descriptor-of expected))
      (define stx ((dynamic-require macro-source 'read-macro-source)
        (hasheq 'source (path->string source) 'sourceIsFile #t 'text safe-text 'mode "module"
                'workspace (path-only source))))
      (check-equal? (descriptor-of (syntax-property stx 'racketeer:language-profile)) (descriptor-of expected))
      (set! selected #f)
      (void ((dynamic-require macro-expansion 'expansion-steps) stx "none"
              #:on-language-adapter (lambda (descriptor) (set! selected descriptor))))
      (check-equal? (descriptor-of selected) (descriptor-of expected))
      (dynamic-require environment #f)
      (define observer (dynamic-require bridge 'current-language-adapter-observer))
      (define roots (dynamic-require bridge 'current-language-adapter-roots))
      (define path->uri (dynamic-require 'racket-langserver/common/path-util 'path->uri))
      (parameterize ([observer (lambda (_ descriptor) (set! selected descriptor))]
                     [roots (list (path-only source))])
        (set! selected #f)
        (define make-doc (dynamic-require 'racket-langserver/doclib/doc 'make-doc))
        (check-true ((dynamic-require 'racket-langserver/doclib/doc 'doc-expand!) (make-doc (path->uri source) safe-text)))
        (check-equal? (descriptor-of selected) (descriptor-of expected))
        (dynamic-require analysis #f)
        (define analyse (parameterize ([current-namespace (module->namespace analysis)]) (eval 'analyse)))
        (set! selected #f)
        (analyse source 100000 safe-text #f (hash source safe-text) (list (path-only source)) (hash) #f)
        (check-equal? (descriptor-of selected) (descriptor-of expected)))))))
