#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/class racket/file racket/list racket/path racket/port racket/runtime-path
         "../racketdap/language-adapters.rkt"
         "../racketdap/worker/load.rkt"
         "../racketdap/worker/debug-cache.rkt"
         "../racketdap/tools/macro-source.rkt"
         "../racketdap/tools/macro-steps/expansion.rkt")
(define-runtime-path bundled "../vendor/collects")
(define-runtime-path loader "../racketdap/language-adapters.rkt")
(current-library-collection-paths (cons bundled (current-library-collection-paths)))
(define (api file name) (dynamic-require (build-path bundled "racket-langserver" file) name))
(define make-doc (api "doclib/doc.rkt" 'make-doc))
(define doc-expand! (api "doclib/doc.rkt" 'doc-expand!))
(define latest? (api "doclib/doc.rkt" 'doc-trace-latest?))
(define resolver (api "doclib/language-adapter.rkt" 'current-language-adapter-resolver))
(define validator
  (with-handlers ([exn:fail? (lambda (_) (make-parameter void))])
    (api "doclib/language-adapter.rkt" 'current-language-adapter-validator)))
(define current?
  (with-handlers ([exn:fail? (lambda (_) (lambda (_) #t))])
    (dynamic-require loader 'language-adapter-current?)))
(define path->uri (api "common/path-util.rkt" 'path->uri))
(define text "#lang racket/base\n(provide answer)\n(define (answer) 42)\n")
(define (with-project work)
  (define root (make-temporary-file "adapter-cache~a" 'directory))
  (define (put name value)
    (define path (build-path root name))
    (make-directory* (path-only path))
    (display-to-file value path #:exists 'truncate)
    path)
  (define source (put "program.rkt" text))
  (define descriptor (put ".racketeer/language-adapters.rktd" "(#((file \"provider.rkt\") profile #f))"))
  (define provider
    (put ".racketeer/provider.rkt"
         "#lang racket/base\n(require \"dependency.rkt\" racket/runtime-path compiler/cm-accomplice)\n(provide profile)\n(define-runtime-path config \"settings.rktd\")\n(define (profile request data)\n (call-with-input-file config read)\n (register-external-file config)\n `(profile (match (language racket/base)) (editor (source-details ,mode))))\n"))
  (define dependency
    (put ".racketeer/dependency.rkt" "#lang racket/base\n(provide mode)\n(define mode 'sexp)\n"))
  (put ".racketeer/settings.rktd" "initial\n")
  (define (change kind)
    (case kind
      [(descriptor) (put ".racketeer/language-adapters.rktd" "(#((file \"provider.rkt\") profile #f))\n")]
      [(provider) (call-with-output-file provider newline #:exists 'append)]
      [(external) (put ".racketeer/settings.rktd" "changed\n")]
      [(dependency) (put ".racketeer/dependency.rkt" "#lang racket/base\n(provide mode)\n(define mode 'none)\n")]))
  (dynamic-wind void
    (lambda () (work root source (list descriptor provider dependency) change))
    (lambda () (delete-directory/files root))))
(define (select root source)
  (parameterize ([current-namespace (make-base-namespace)])
    (resolve-language-adapter source #:text text #:workspace root)))

(module+ support
  (provide with-project text api make-doc doc-expand! latest? resolver validator current? path->uri))

(module+ test
  (for ([kind '(descriptor provider dependency external)])
    (test-case (format "~a edits change the shared fingerprint" kind)
      (with-project
       (lambda (root source files change)
         (define before (select root source))
         (change kind)
         (define after (select root source))
         (check-not-equal? (hash-ref before 'fingerprint #f) (hash-ref after 'fingerprint #f)))))
    (test-case (format "~a edits invalidate live editor facts" kind)
      (with-project
       (lambda (root source files change)
         (parameterize ([resolver (lambda (file source-text pre roots)
                                    (resolve-language-adapter file #:text source-text #:pre pre #:workspace root))]
                        [validator current?])
           (define doc (make-doc (path->uri source) text))
           (check-true (doc-expand! doc))
           (check-true (latest? doc))
           (change kind)
           (check-false (latest? doc))))))
    (test-case (format "~a edits invalidate compiled debugger entries" kind)
      (with-project
       (lambda (root source files change)
         (define cache (build-path root "cache"))
         (define (launch)
           (run-module source #:instrument? #t #:workspace root #:cache-directory cache #:entry 'answer))
         (check-equal? (launch) 42)
         (define entry (entry-path (cache-root cache) (string->path "compiled/debug") source #".zo"))
         (check-true (file-exists? entry))
         (define before (file->bytes entry))
         (check-equal? (launch) 42)
         (check-equal? (file->bytes entry) before)
         (change kind)
         (check-equal? (launch) 42)
         (check-false (and (file-exists? entry) (equal? (file->bytes entry) before))))))
    (test-case (format "~a edits reject retained macro recordings" kind)
      (with-project
       (lambda (root source files change)
         (define request (hasheq 'source (path->string source) 'sourceIsFile #t 'text text
                                 'mode "module" 'directory (path->string root) 'workspace root))
         (call-with-macro-source request
           (lambda (stx)
             (define recording #f)
             (expansion-steps stx "none" #:retain-derivation (lambda (value) (set! recording value)))
             (check-not-false recording)
             (change kind)
             (check-exn #rx"Language adapter changed"
                        (lambda () (expansion-steps stx "none" #:derivation recording)))))))))
  (test-case "a module without an adapter keeps the generic cache basis"
    (define generic
      (parameterize ([current-namespace (make-base-namespace)])
        (resolve-language-adapter "untitled:generic" #:text "#lang racket/base\n42\n")))
    (check-false (hash-ref generic 'fingerprint #f)))
  (test-case "legacy information providers retain their transitive dependencies"
    (with-project
     (lambda (root source files change)
       (delete-file (car files))
       (define legacy (build-path root ".racketeer/legacy.rkt"))
       (display-to-file
        "#lang racket/base\n(require \"dependency.rkt\")\n(provide get-info)\n(define (get-info data) (lambda (key default) (if (eq? key 'racketeer:language-profile) `(profile (editor (source-details ,mode))) default)))\n"
        legacy)
       (define (select-legacy)
         (parameterize ([current-namespace (make-base-namespace)])
           (resolve-language-adapter source #:text text #:workspace root
             #:legacy-info (vector legacy 'get-info #f))))
       (define before (select-legacy))
       (change 'dependency)
       (check-false (current? before))
       (check-not-equal? (hash-ref before 'fingerprint #f)
                         (hash-ref (select-legacy) 'fingerprint #f))))))

(module+ test
  (for* ([kind '(reader legacy)] [stage '(factory callback)])
    (test-case (format "warm ~a information keeps observations before its ~a" kind stage)
      (with-project
       (lambda (root source files change)
         (delete-file (car files))
         (define implementation (build-path root ".racketeer/info.rkt"))
         (define mutation
           (format "(display-to-file ~s ~s #:exists 'truncate)"
                   "#lang racket/base\n(provide mode)\n(define mode 'none)\n"
                   (path->string (caddr files))))
         (display-to-file
          (format "#lang racket/base\n(require racket/file \"dependency.rkt\")\n(provide get-info)\n(define (get-info ~a)\n ~a\n (lambda (key default)\n  (if (eq? key 'racketeer:language-profile)\n   (begin ~a `(profile (editor (source-details ,mode)))) default)))\n"
                  (if (eq? kind 'reader) "in module line column position" "data")
                  (if (eq? stage 'factory) mutation "(void)")
                  (if (eq? stage 'callback) mutation "(void)"))
          implementation)
         (parameterize ([current-namespace (make-base-namespace)])
           (dynamic-require implementation #f)
           (check-exn
            #rx"adapter changed during selection"
            (lambda ()
              (resolve-language-adapter
               source #:workspace root
               #:text (if (eq? kind 'reader)
                          (format "#reader (file ~s)\n42\n" (path->string implementation)) text)
               #:pre (datum->syntax #f '(module program racket/base 42))
               #:legacy-info (and (eq? kind 'legacy) (vector implementation 'get-info #f))))))))))
  (test-case "switching a registered external dependency rebuilds compiled debugger code"
    (with-project
     (lambda (root source files change)
       (define first (build-path root "first.rktd"))
       (define second (build-path root "second.rktd"))
       (display-to-file "42\n" first)
       (display-to-file "99\n" second)
       (display-to-file
        "#lang racket/base\n(require compiler/cm-accomplice)\n(provide profile)\n(define (profile request data)\n (define file (string->path (getenv \"RACKETEER_ADAPTER_INPUT\")))\n (call-with-input-file file read)\n (register-external-file file)\n '(profile (match (language racket/base))))\n"
        (cadr files) #:exists 'truncate)
       (display-to-file
        "#lang racket/base\n(require (for-syntax racket/base compiler/cm-accomplice))\n(provide answer)\n(define-syntax (selected stx)\n (define file (string->path (getenv \"RACKETEER_ADAPTER_INPUT\")))\n (define value (call-with-input-file file read))\n (register-external-file file)\n (datum->syntax stx value))\n(define (answer) (selected))\n"
        source #:exists 'truncate)
       (parameterize ([current-environment-variables
                       (environment-variables-copy (current-environment-variables))])
         (define (launch input cache)
           (putenv "RACKETEER_ADAPTER_INPUT" (path->string input))
           (run-module source #:instrument? #t #:workspace root
                       #:cache-directory (build-path root cache) #:entry 'answer))
         (check-equal? (launch first "cache") 42)
         (check-equal? (launch first "cache") 42)
         (check-equal? (launch second "cache") 99)
         (check-equal? (launch second "fresh-cache") 99)
         (check-equal? (launch first "cache") 42)))))
  (for* ([kind '(reader legacy)] [change '(bytecode external during-info dynamic)])
    (test-case (format "~a information retains original ~a observations" kind change)
      (with-project
       (lambda (root source files change-project)
         (delete-file (car files))
         (define implementation (build-path root ".racketeer/info.rkt"))
         (define external (build-path root ".racketeer/settings.rktd"))
         (define dependency (caddr files))
         (define dynamic-dependency (build-path root ".racketeer/dynamic.rkt"))
         (display-to-file "#lang racket/base\n(provide mode)\n(define mode 'sexp)\n" dynamic-dependency)
         (define contents
           (format
            "#lang racket/base\n(require \"dependency.rkt\" racket/file compiler/cm-accomplice)\n(provide get-info)\n(define (get-info ~a)\n (lambda (key default)\n  (if (eq? key 'racketeer:language-profile)\n   (begin\n    (call-with-input-file ~s read)\n    (register-external-file (string->path ~s))\n    ~a\n    `(profile (editor (source-details ,~a))))\n   default)))\n"
            (if (eq? kind 'reader) "in module line column position" "data")
            (path->string external) (path->string external)
            (if (eq? change 'during-info)
                (format "(display-to-file ~s ~s #:exists 'truncate)"
                        "#lang racket/base\n(provide mode)\n(define mode 'none)\n"
                        (path->string dependency))
                "(void)")
            (if (eq? change 'dynamic)
                (format "(dynamic-require (string->path ~s) 'mode)" (path->string dynamic-dependency))
                "mode")))
         (display-to-file contents implementation)
         (define compiled (build-path root ".racketeer/compiled/info_rkt.zo"))
         (when (eq? change 'bytecode)
           (make-directory* (build-path root ".racketeer/compiled"))
           (parameterize ([current-namespace (make-base-namespace)]
                          [current-load-relative-directory (build-path root ".racketeer")]
                          [read-accept-reader #t])
             (call-with-output-file compiled
               (lambda (out)
                 (write (compile (call-with-input-file implementation
                                   (lambda (in) (read-syntax implementation in)))) out))))
           (delete-file implementation))
         (define (select-info)
           (parameterize ([current-namespace (make-base-namespace)])
             (resolve-language-adapter
              source #:workspace root
              #:text (if (eq? kind 'reader)
                         (format "#reader (file ~s)\n42\n" (path->string implementation)) text)
              #:pre (datum->syntax #f '(module program racket/base 42))
              #:legacy-info (and (eq? kind 'legacy) (vector implementation 'get-info #f)))))
         (cond
           [(eq? change 'during-info)
            (check-exn #rx"adapter changed during selection" select-info)]
           [else
            (define adapter (select-info))
            (check-true (current? adapter))
            (case change
              [(bytecode) (call-with-output-file compiled newline #:exists 'append)]
              [(external) (display-to-file "changed\n" external #:exists 'truncate)]
              [(dynamic)
               (display-to-file "#lang racket/base\n(provide mode)\n(define mode 'none)\n"
                                dynamic-dependency #:exists 'truncate)])
            (check-false (current? adapter))])))))
  (test-case "an explicit descriptor observes its provider reference and skips the project override"
    (with-project
     (lambda (root source files change)
       (define explicit (build-path root "chosen.rktd"))
       (define provider (build-path root "selected.rkt"))
       (display-to-file
        "(profile (bindings (expanded+ #((file \"selected.rkt\") bindings #f))))"
        explicit)
       (display-to-file "#lang racket/base\n(error 'selected \"unexpected load\")\n" provider)
       (define opened '())
       (define parent (current-security-guard))
       (define adapter
         (parameterize ([current-namespace (make-base-namespace)]
                        [current-security-guard
                         (make-security-guard parent
                          (lambda (_who file modes)
                            (when (and file (memq 'read modes)) (set! opened (cons file opened))))
                          (lambda _ (void)))])
           (resolve-language-adapter source #:text text #:workspace root #:explicit explicit)))
       (define dependencies (hash-ref (hash-ref adapter 'fingerprint) 'files))
       (check-not-false (assoc provider dependencies))
       (check-false (and (member (car files) opened) #t))
       (check-false (assoc (car files) dependencies))
       (change 'descriptor)
       (check-true (current? adapter))
       (call-with-output-file provider newline #:exists 'append)
       (check-false (current? adapter))))))

(module+ test
  (test-case "completion helper edits invalidate cold and warm native selections"
    (when (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
      (define root (make-temporary-file "completion-fingerprint~a" 'directory))
      (dynamic-wind void
        (lambda ()
          (define adapters (build-path (path-only loader) "adapters"))
          (for ([name '("rhombus.rkt" "rhombus-debugger.rkt" "rhombus-completion.rkt")])
            (copy-file (build-path adapters name) (build-path root name)))
          (define helper (build-path root "rhombus-completion.rkt"))
          (define dependency (build-path root "completion-dependency.rkt"))
          (display-to-file "#lang racket/base\n" dependency)
          (display-to-file "\n(require \"completion-dependency.rkt\")\n" helper #:exists 'append)
          (parameterize ([current-namespace (make-base-namespace)])
            (define (select-native)
              (resolve-language-adapter "untitled:members" #:text "#lang rhombus\nList."
                #:declare-bindings? #t
                #:registry
                `((profile (match (language rhombus) (variants (lib "rhombus/main.rhm")))
                           (bindings (expanded+ #((file ,(path->string (build-path root "rhombus-debugger.rkt"))) bindings #f)))
                           (editor (completion (expanded+ #((file ,(path->string helper)) completion #f))))))))
            (for ([file (list helper dependency)])
              (when (equal? file dependency) (dynamic-require helper #f))
              (define cold (select-native))
              (define warm (select-native))
              (check-not-false (hash-ref cold 'fingerprint #f))
              (check-not-false (hash-ref warm 'fingerprint #f))
              (check-true (current? cold))
              (check-true (current? warm))
              (call-with-output-file file newline #:exists 'append)
              (with-check-info (['dependency file])
                (check-false (current? cold))
                (check-false (current? warm))))))
        (lambda () (delete-directory/files root))))))
