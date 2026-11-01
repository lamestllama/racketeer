#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/file racket/port racket/string
         "../racketdap/worker/load.rkt"
         "../racketdap/source.rkt"
         "../racketdap/instrumentation/instrument.rkt")

(define (with-directory proc)
  (define directory (make-temporary-file "source-loading-~a" 'directory))
  (dynamic-wind void (lambda () (proc directory))
                (lambda () (delete-directory/files directory))))
(define (write-source path text)
  (display-to-file text path #:exists 'truncate/replace))

(module+ test
  (for* ([instrument? '(#f #t)] [plain? '(#f #t)])
    (test-case (format "one source read supplies execution and snapshots: debug ~a, plain ~a"
                       instrument? plain?)
      (with-directory
       (lambda (directory)
         (define program (build-path directory "target.rkt"))
         (define original
           (string-append
            (if plain? "" "#lang racket/base\r\n(provide run)\r\n")
            "; λ 😀\r\n"
            "(require (for-syntax racket/base))\r\n"
            "(begin-for-syntax (displayln 'expanded))\r\n"
            "(define (run) 'original)\r\n"))
         (define replacement
           (string-append (if plain? "" "#lang racket/base\n(provide run)\n")
                          "(define (run) 'replacement)\n"))
         (write-source program original)
         (define paths '())
         (define snapshot #f)
         (define answer #f)
         (define output
           (with-output-to-string
             (lambda ()
               (set! answer
                     (run-module
                      program #:instrument? instrument?
                      #:language (and plain? 'racket/base) #:entry 'run
                      #:on-source
                      (lambda (path)
                        (set! paths (cons path paths))
                        (write-source path replacement))
                      #:on-source-snapshot
                      (lambda (path text)
                        (check-equal? text original)
                        (check-true (immutable? text))
                        (set! snapshot (capture-source path 7 #:text text))
                        (write-source path (string-replace replacement "replacement" "edited-again"))))))))
         (check-eq? answer 'original)
         (check-equal? output "expanded\n")
         (check-equal? paths (list program))
         (check-equal? (source-file-id snapshot) 7)
         (check-equal? (source-file-text snapshot) (string-replace original "\r\n" "\n"))
         (check-true (string-contains? (file->string program) "edited-again"))))))

  (test-case "module readers reset reader settings while plain loads retain sequential changes"
    (with-directory
     (lambda (directory)
       (define module-path (build-path directory "module.rkt"))
       (define plain-path (build-path directory "plain.rkt"))
       (write-source module-path
                     "#lang racket/base\n(provide run)\n(define (run) 'MiXeD)\n")
       (write-source plain-path
                     "(read-case-sensitive #f)\n(define MIXED 41)\n(define (run) (+ mixed 1))\n")
       (for ([instrument? '(#f #t)])
         (parameterize ([read-case-sensitive #f])
           (check-eq? (run-module module-path #:instrument? instrument? #:entry 'run) 'MiXeD))
         (parameterize ([read-case-sensitive #t])
           (check-equal? (run-module plain-path #:instrument? instrument? #:language 'racket/base
                                    #:entry 'run)
                         42))))))

  (for ([plain? '(#f #t)])
    (test-case (format "source selection sees external files selected after ready: plain ~a" plain?)
      (with-directory
       (lambda (directory)
         (define main (build-path directory "main.rkt"))
         (define external (build-path directory "external.rkt"))
         (write-source main "#lang racket/base\n(void)\n")
         (define external-text
           (string-append (if plain? "" "#lang racket/base\n(provide answer)\n")
                          "(define (answer value) (+ value 1))\n"))
         (write-source external external-text)
         (define selected? #f)
         (define snapshots '())
         (define external-stops 0)
         (define result #f)
         (run-module
          main
          #:source-selected? (lambda (path) (and selected? (equal? path external)))
          #:on-source-snapshot
          (lambda (path text)
            (when (equal? path external)
              (check-equal? text external-text)
              (set! snapshots (cons path snapshots))))
          #:on-event
          (lambda (stop)
            (when (equal? (site-source (stop-site stop)) external)
              (set! external-stops (add1 external-stops))))
          #:on-ready
          (lambda (namespace)
            (check-equal? snapshots '())
            (set! selected? #t)
            (parameterize ([current-namespace namespace])
              (set! result
                    (if plain?
                        (begin (load external) (eval '(answer 41)))
                        ((dynamic-require external 'answer) 41))))))
         (check-equal? result 42)
         (check-equal? snapshots (list external))
         (check-true (positive? external-stops))))))

  (test-case "independent submodule probes do not reopen source or repeat expansion"
    (with-directory
     (lambda (directory)
       (define program (build-path directory "target.rkt"))
       (write-source program
                     "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (displayln 'expanded))\n(module child racket/base (provide answer) (define answer 42))\n")
       (define snapshots 0)
       (define output
         (with-output-to-string
           (lambda ()
             (run-module
              program #:submodule '(child)
              #:on-source-snapshot (lambda (_path _text) (set! snapshots (add1 snapshots)))
              #:on-ready
              (lambda (namespace)
                (parameterize ([current-namespace namespace])
                  (check-equal? (eval 'answer) 42)
                  ((current-load) program '(#f missing))
                  (check-false (module-declared? `(submod ,program missing) #t))))))))
       (check-equal? output "expanded\n")
       (check-equal? snapshots 1))))

  (test-case "plain source retains final multiple values and propagates aborts out of load"
    (with-directory
     (lambda (directory)
       (define main (build-path directory "main.rkt"))
       (define values-path (build-path directory "values.rkt"))
       (define abort-path (build-path directory "abort.rkt"))
       (write-source main "#lang racket/base\n(void)\n")
       (write-source values-path "(values 'discarded 'values)\n(values 1 2)\n")
       (write-source abort-path
                     "(abort-current-continuation (default-continuation-prompt-tag) (lambda () 'escaped))\n(error 'unexpected \"read after abort\")\n")
       (run-module
        main #:sources (list values-path abort-path)
        #:on-ready
        (lambda (namespace)
          (parameterize ([current-namespace namespace])
            (check-equal? (call-with-values (lambda () (load values-path)) list) '(1 2))
            (check-eq? (call-with-continuation-prompt (lambda () (load abort-path))) 'escaped)))))))

  (test-case "captured text supplies CRLF and Unicode locations without a file read"
    (define source (capture-source "/nonexistent/source-loading.rkt" 9 #:text "😀\r\nλ"))
    (check-equal? (source-file-text source) "😀\nλ")
    (check-equal? (call-with-values (lambda () (source-location source 2)) list) '(1 3))
    (check-equal? (call-with-values (lambda () (source-location source 3)) list) '(2 1))))
