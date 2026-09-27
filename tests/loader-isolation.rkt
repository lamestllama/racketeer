#lang racket/base

(require rackunit racket/file racket/runtime-path compiler/compile-file
         "../racketdap/worker/load.rkt")

(define-runtime-path loader "../racketdap/worker/load.rkt")

(module+ test
  (for ([instrument? '(#f #t)])
    (test-case (format "forwarding loader retains foreign compiled submodules: debug ~a" instrument?)
      (define directory (make-temporary-file "forwarding-racket-loader-~a" 'directory))
      (dynamic-wind
        void
        (lambda ()
          (define library (build-path directory "library.rkt"))
          (define cache-directory (build-path directory "compiled"))
          (define cache (build-path cache-directory "library_rkt.zo"))
          (define program (build-path directory "program.rkt"))
          (display-to-file
           (string-append "#lang racket/base\n(provide root)\n(define root 7)\n"
                          "(module part racket/base (provide answer) (define answer 42))\n")
           library)
          (make-directory cache-directory)
          (parameterize ([current-namespace (make-base-namespace)]
                         [read-accept-reader #t] [read-accept-lang #t])
            (compile-file library cache))
          ;; Load the compiled root independently, then attach it elsewhere.
          ;; Its sibling submodule needs a later compiled-only load. The
          ;; forwarding hook delegates unchanged and owns no compiler policy.
          (display-to-file
           (format
            (string-append
             "#lang racket/base\n(require (for-syntax racket/base))\n"
             "(begin-for-syntax\n"
             " (define (inspect)\n"
             " (define library (string->path ~s))\n"
             " (define source (make-base-namespace))\n"
             " (parameterize ([current-namespace source]\n"
             "                [current-module-declare-name (make-resolved-module-path library)])\n"
             "   ((current-load) (string->path ~s) 'library)\n"
             "   (dynamic-require library 'root))\n"
             " (define target (make-base-namespace))\n"
             " (namespace-attach-module source library target)\n"
             " (define saved (current-load/use-compiled))\n"
             " (define result\n"
             "   (parameterize ([current-namespace target]\n"
             "                  [current-load/use-compiled (lambda (path expected) (saved path expected))])\n"
             "     (when (module-declared? `(submod ,library part) #f)\n"
             "       (error 'fixture \"submodule was not loaded independently\"))\n"
             "     (dynamic-require `(submod ,library part) 'answer)))\n"
             "   result)\n"
             " (define synchronous (inspect))\n"
             " (define answers (make-channel))\n"
             " (thread (lambda ()\n"
             "   (with-handlers ([exn? (lambda (e) (channel-put answers e))])\n"
             "     (channel-put answers (inspect)))))\n"
             " (define result (channel-get answers))\n"
             " (when (exn? result) (raise result))\n"
             " (unless (= synchronous result) (error 'fixture \"thread result differs\")))\n"
             "(define-syntax (from-library stx) (datum->syntax stx result))\n"
             "(provide answer)\n(define (answer) (from-library))\n")
            (path->string library) (path->string cache))
           program)
          (check-equal? (run-module program #:instrument? instrument? #:entry 'answer) 42)
          ;; A forwarding hook may introduce an ordinary continuation prompt.
          ;; An inner loader still owns its deliberately different compilation
          ;; policy, including while invoked during the outer expansion.
          (define nested (build-path directory "nested.rkt"))
          (define driver (build-path directory "driver.rkt"))
          (display-to-file
           (string-append
            "(module nested racket/base\n(require (for-syntax racket/base))\n"
            "(define-syntax (policy stx) (datum->syntax stx (compile-enforce-module-constants)))\n"
            "(provide run)\n(define (run) (policy)))\n")
           nested)
          (display-to-file
           (format
            (string-append
             "#lang racket/base\n(require (for-syntax racket/base (file ~s)))\n"
             "(begin-for-syntax\n"
             " (define saved (current-load/use-compiled))\n"
             " (define result\n"
             "   (parameterize ([compile-enforce-module-constants #f]\n"
             "                  [current-load/use-compiled\n"
             "                   (lambda (path expected)\n"
             "                     (call-with-continuation-prompt (lambda () (saved path expected))))])\n"
             "     (run-module ~s #:instrument? #f #:entry 'run))))\n"
             "(define-syntax (policy stx) (datum->syntax stx result))\n"
             "(provide run)\n(define (run) (policy))\n")
            (path->string loader) (path->string nested))
           driver)
          (check-false (run-module driver #:instrument? instrument? #:entry 'run)))
        (lambda () (delete-directory/files directory)))))

  (for* ([instrument? '(#f #t)]
         [enforce? '(#f #t)])
    (test-case (format "dependency compilation policy: debug ~a, enforce constants ~a"
                       instrument? enforce?)
      (define directory (make-temporary-file "racket-compilation-policy-~a" 'directory))
      (dynamic-wind
        void
        (lambda ()
          (define dependency (build-path directory "dependency.rkt"))
          (define program (build-path directory "program.rkt"))
          (define ordinary-load (current-load/use-compiled))
          (define library-constants? (compile-enforce-module-constants))
          (define (load-fixture path expected)
            ;; Vary compilation policy for the fixture modules only. Rebuilding
            ;; a Racket library with constants disabled can invalidate imports
            ;; from its existing bytecode, even without a debugger involved.
            (if (member path (list dependency program))
                (ordinary-load path expected)
                (parameterize ([compile-enforce-module-constants library-constants?])
                  (ordinary-load path expected))))
          (define policy-form
            (string-append
             "(require (for-syntax racket/base))\n"
             "(define-syntax (compilation-policy stx)\n"
             "  (datum->syntax stx\n"
             "    (list 'quote (list (compile-enforce-module-constants)\n"
             "                       (null? (use-compiled-file-paths))))))\n"))
          (display-to-file
           ;; Explicit modules keep this compiler-policy test independent of
           ;; #lang reader loading under the deliberately changed parameter.
           (string-append "(module dependency racket/base\n" policy-form
                          "(provide dependency-policy)\n"
                          "(define dependency-policy (compilation-policy)))\n")
           dependency)
          (display-to-file
           (string-append "(module program racket/base\n" policy-form
                          "(require \"dependency.rkt\")\n(provide run)\n"
                          (format
                           (string-append
                            "(define-syntax (foreign-policy stx)\n"
                            "  (datum->syntax stx\n"
                            "    (list 'quote\n"
                            "      (parameterize ([current-namespace (make-base-namespace)])\n"
                            "        (dynamic-require (string->path ~s) 'dependency-policy)))))\n")
                           (path->string dependency))
                          "(define program-policy (compilation-policy))\n"
                          "(define foreign (foreign-policy))\n"
                          "(define (run) (list program-policy dependency-policy foreign)))\n")
           program)
          (for ([select-dependency? '(#f #t)])
            (define policies
              (parameterize ([compile-enforce-module-constants enforce?]
                             [current-load/use-compiled load-fixture])
                (run-module program #:entry 'run #:instrument? instrument?
                            #:sources (if select-dependency? (list dependency) '()))))
            (check-equal? policies
                          (list (list (and (not instrument?) enforce?) #t)
                                (list (and (not (and instrument? select-dependency?)) enforce?)
                                      (or select-dependency? (null? (use-compiled-file-paths))))
                                (list enforce? (null? (use-compiled-file-paths)))))))
        (lambda () (delete-directory/files directory)))))

  (for* ([outer-debug? '(#f #t)]
         [inner-debug? '(#f #t)]
         [plain? '(#f #t)])
    (test-case (format "nested loader: outer debug ~a, inner debug ~a, plain file ~a"
                       outer-debug? inner-debug? plain?)
      (define directory (make-temporary-file "nested-racket-loader-~a" 'directory))
      (dynamic-wind
        void
        (lambda ()
          (define target (build-path directory "target.rkt"))
          (define driver (build-path directory "driver.rkt"))
          (display-to-file
           (string-append (if plain? "" "#lang racket/base\n(provide answer)\n")
                          "(define (answer) (+ 20 22))\n")
           target)
          (display-to-file
           (format
            (string-append
             "#lang racket/base\n(require (file ~s))\n(provide run)\n"
             "(define (run)\n"
             "  (define stops 0)\n"
             "  (define sources '())\n"
             "  (define result\n"
             "    (run-module ~s #:instrument? ~s #:language ~s #:entry 'answer\n"
             "      #:on-event (lambda (_) (set! stops (add1 stops)))\n"
             "      #:on-source (lambda (source) (set! sources (cons source sources)))))\n"
             "  (list result stops sources))\n")
            (path->string loader) (path->string target) inner-debug?
            (if plain? '(quote racket/base) #f))
           driver)
          (define outer-sources '())
          (define result
            (run-module driver #:instrument? outer-debug? #:entry 'run
                        ;; Both executions select the same path, but only the
                        ;; inner execution owns the registry loading it.
                        #:sources (list target)
                        #:on-source (lambda (source)
                                      (set! outer-sources (cons source outer-sources)))))
          (check-equal? (car result) 42)
          (if inner-debug?
              (check-true (positive? (cadr result)))
              (check-equal? (cadr result) 0))
          (check-not-false (member target (caddr result)))
          (check-false (member target outer-sources)))
        (lambda () (delete-directory/files directory))))))
