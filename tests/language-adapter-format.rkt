#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/runtime-path racket/system)

(define-runtime-path loader "../racketdap/language-adapters.rkt")
(define-runtime-path self "language-adapter-format.rkt")
(define (api name) (dynamic-require loader name))
(define (validate value) ((api 'validate-language-profile) value #:source "fixture"))
(define p '#(racket/base values #f))

(module provider racket/base
  (provide allocation-failure datum-failure)
  (define (allocation-failure request data)
    (raise (exn:fail:out-of-memory "allocation failed" (current-continuation-marks))))
  (define (datum-failure request data) (raise 'failed)))

(module debugger-providers racket/base
  (require racket/match racket/path racket/runtime-path
           syntax/modread syntax/modresolve "../racketdap/language-adapters.rkt")
  (define-runtime-path registry "../racketdap/language-adapters.rktd")
  (define resolve (current-module-name-resolver))
  (define (check-import value)
    (when (regexp-match? #rx"racket-langserver" (format "~s" value))
      (error 'provider "Language-server dependency: ~s" value)))
  ;; Inspect local imports before loading, including when Rhombus is absent.
  (define inspected (make-hash))
  (define (inspect module base)
    (check-import module)
    (define path
      (match (resolve-module-path module base)
        [(list* 'submod file _) file]
        [file file]))
    (when (and (path? path) (not (hash-ref inspected path #f)))
      (hash-set! inspected path #t)
      (define (imports value)
        (match value
          [(list (or 'require '#%require) specs ...)
           (define (spec value)
             (check-import value)
             (cond
               [(module-path? value)
                (when (or (string? value)
                          (and (pair? value) (eq? (car value) 'file))
                          (and (pair? value) (eq? (car value) 'submod)
                               (string? (cadr value))))
                  (inspect value path))]
               [(pair? value) (for-each spec (cdr value))]))
           (for-each spec specs)]
          [(? list?) (for-each imports value)]
          [_ (void)]))
      (imports
       (syntax->datum
        (with-module-reading-parameterization
         (lambda () (call-with-input-file path (lambda (in) (read-syntax path in)))))))))
  (parameterize
      ([current-module-name-resolver
        (case-lambda
          [(path relative) (resolve path relative)]
          [(path relative stx load?)
           (check-import path)
           (define resolved (resolve path relative stx load?))
           (check-import (resolved-module-path-name resolved))
           resolved])])
    (for ([datum (in-list (call-with-input-file registry read))])
      (define loadable? #t)
      (define (providers value)
        (cond
          [(vector? value)
           (define module (vector-ref value 0))
           (define base (build-path (path-only registry) "provider.rkt"))
           (inspect module base)
           (with-handlers
               ([exn:fail:filesystem:missing-module?
                 (lambda (e)
                   (unless (regexp-match? #rx"^(rhombus|shrubbery)(/|$)"
                                          (format "~a" (exn:fail:filesystem:missing-module-path e)))
                     (raise e))
                   (set! loadable? #f))])
             (define proc (dynamic-require (resolve-module-path module base) (vector-ref value 1)))
             (unless (procedure? proc) (error 'provider "Expected a procedure: ~s" value)))]
          [(pair? value) (providers (car value)) (providers (cdr value))]))
      (for ([field (in-list (cdr datum))]
            #:when (memq (car field) '(bootstrap source bindings debugger)))
        (providers (cdr field)))
      (when loadable?
        ;; Select with the worker's declaration options, without needing Rhombus.
        (void (resolve-language-adapter "untitled:providers" #:language 'racket/base
                #:declare-bindings? #t
                #:registry
                (list `(profile (match (language racket/base))
                         ,@(filter (lambda (field) (not (eq? (car field) 'match)))
                                   (cdr datum))))))))))

(module+ test
  (test-case "debugger providers load without the language-server collection"
    (define environment (environment-variables-copy (current-environment-variables)))
    (environment-variables-set! environment #"PLTCOLLECTS" #f)
    (define output (open-output-string))
    (parameterize ([current-environment-variables environment]
                   [current-output-port output] [current-error-port output])
      (check-true
       (system* (find-executable-path "racket") "-e"
                (format "(begin (current-compiled-file-roots '~s) (dynamic-require '(submod (file ~s) debugger-providers) #f))"
                        (map (lambda (root) (if (path? root) (path->string root) root))
                             (current-compiled-file-roots))
                        (path->string self)))
       (get-output-string output))))

  (test-case "an empty profile supplies every version 1 default"
    (define result (validate '(profile)))
    (check-true (immutable? result))
    (check-equal? (validate '(profile (debugger) (editor) (macro-stepper))) result)
    (check-equal? result
      (hasheq 'version 1 'match '() 'bootstrap 'auto 'source 'reader 'bindings 'expanded
              'debugger (hasheq 'expressions '(runtime-interaction identity)
                                'values '(runtime-print preview-fallback) 'steps 'expanded)
              'editor (hasheq 'body-mode 'policy 'expand? 'policy 'require-header? 'policy
                              'source-details 'auto 'declarations 'generic
                              'calls '(generic (triggers " " ")" "]"))
                              'completion '(expanded (triggers "(")) 'rename 'expanded-graph
                              'inlay-hints 'policy 'formatting 'policy)
              'macro-stepper (hasheq 'context 'auto 'hide-modules '() 'terms 'syntax))))

  (test-case "every shared field and provider reference loads"
    (check-equal? (hash-ref (validate `(profile (version 1) (match (language racket/base)
                    (reader racket/base) (variants racket racket/base))
                    (bootstrap (auto ,p)) (source (reader+ ,p)) (bindings (expanded+ ,p)))) 'version) 1))

  (test-case "every debugger field loads with its optional provider"
    (define result (validate `(profile (debugger (expressions (runtime-interaction ,p))
                                  (values (,p preview-fallback)) (steps (expanded+ ,p))))))
    (check-equal? (hash-ref (hash-ref result 'debugger) 'steps) `(expanded+ ,p)))

  (test-case "every editor field loads including triggers and an empty hint list"
    (define result (validate `(profile (editor (body-mode non-sexp) (expand? #f)
       (require-header? #f) (source-details shrubbery) (declarations ,p)
       (calls ,p (triggers ".")) (completion (expanded+ ,p) (triggers ":"))
       (rename (expanded-graph ,p)) (inlay-hints (,p)) (formatting off)))))
    (check-equal? (hash-ref (hash-ref result 'editor) 'calls) `(,p (triggers ".")))
    (check-equal? (hash-ref (hash-ref (validate '(profile (editor (inlay-hints ())))) 'editor) 'inlay-hints) '())
    (for ([mode '(sexp non-sexp unknown)]) (validate `(profile (editor (body-mode ,mode))))))

  (test-case "every macro stepper field loads"
    (define result (validate `(profile (macro-stepper (context module)
                          (hide-modules ((module racket/base) (collection racket))) (terms ,p)))))
    (check-equal? (hash-ref (hash-ref result 'macro-stepper) 'context) 'module))

  (test-case "malformed fields name their source and full field path"
    (for ([entry (in-list '((profile profile) ((profile (unknown 1)) unknown)
              ((profile (source (reader+ #(racket/base values)))) source)
              ((profile (editor (expand? yes))) editor.expand?)
              ((profile (editor (calls generic (triggers 1)))) editor.calls)
              ((profile (macro-stepper (hide-modules ((collection "racket"))))) macro-stepper.hide-modules)
              ((profile (debugger (values runtime-print))) debugger.values)
              ((profile (match (language))) match)))])
      (check-exn (regexp (format "fixture.*~a" (cadr entry))) (lambda () (validate (car entry))))))

  (test-case "duplicate fields and unsupported versions fail before providers run"
    (for ([entry (in-list '(((profile (version 2)) version)
              ((profile (bootstrap (auto #((file "absent.rkt") bootstrap #f))) (version 2)) version)
              ((profile (source reader) (source reader)) source)
              ((profile (editor (expand? #t) (expand? #f))) editor.expand?)
              ((profile (debugger) (debugger)) debugger)))])
      (check-exn (regexp (format "fixture.*~a" (cadr entry))) (lambda () (validate (car entry))))))

  (test-case "provider requests contain immutable common defaults and pass data unchanged"
    (define request ((api 'make-provider-request) 'profile #:selection #f))
    (check-true (immutable? request))
    (for ([key '(uri text reader language pre expanded phase space position)])
      (check-false (hash-ref request key)))
    (check-equal? (hash-ref request 'submodules) '())
    (check-equal? (hash-ref (hash-ref request 'facts) 'names) '())
    (check-false ((hash-ref request 'cancelled?)))
    (check-false ((api 'call-language-provider) '#(racket/base eq? #f) request))
    (check-equal? ((api 'call-language-provider) '#(racket/base list payload) request #:field 'profile)
                  (list request 'payload)))

  (test-case "provider failures and executable data name the field"
    (define request ((api 'make-provider-request) 'profile))
    (check-exn (lambda (e) (and (exn:fail:out-of-memory? e)
                               (regexp-match? #rx"fixture.*bindings" (exn-message e))))
      (lambda () ((api 'call-language-provider) (vector `(submod ,self provider) 'allocation-failure #f)
                  request #:source "fixture" #:field 'bindings)))
    (check-exn #rx"fixture.*bindings"
      (lambda () ((api 'call-language-provider) (vector `(submod ,self provider) 'datum-failure #f)
                  request #:source "fixture" #:field 'bindings)))
    (check-exn #rx"fixture.*source" (lambda () (validate `(profile (source (reader+ #(racket/base values ,void)))))))
    (for ([ref '(#(racket/base missing #f) #(racket/base car #f) #(racket/base pi #f)
                #(racket/base values #f))])
      (check-exn #rx"fixture.*bindings" (lambda ()
        ((api 'call-language-provider) ref request #:source "fixture" #:field 'bindings))))))
