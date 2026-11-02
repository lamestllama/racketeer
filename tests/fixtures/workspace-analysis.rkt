#lang racket/base

(require rackunit racket/file racket/runtime-path racket/async-channel net/url)
(define-runtime-path environment "../../vscode/racket-environment.rkt")
(define-runtime-path analysis "../../vscode/workspace-analysis.rkt")
(dynamic-require environment #f)
(define-values (make-engine update! query close! result? result-value result-revision failure? failure-reason failure-message)
  (apply values
         (for/list ([name '(make-workspace-analysis workspace-analysis-update! workspace-analysis-query
                           workspace-analysis-close! AnalysisResult? AnalysisResult-value AnalysisResult-revision
                           AnalysisFailure? AnalysisFailure-reason AnalysisFailure-message)])
           (dynamic-require analysis name))))

(define definition "#lang racket/base\n(provide square)\n(define (square x) (* x x))\n")
(define consumer "#lang racket/base\n(require \"definition.rkt\")\n(square 3)\n")
(define (uri path) (url->string (path->url path)))
(define (fixture directory [text definition])
  (display-to-file text (build-path directory "definition.rkt") #:exists 'truncate)
  (display-to-file consumer (build-path directory "consumer.rkt") #:exists 'truncate)
  (hasheq 'revision 1 'roots (list (uri directory))
          'documents (list (hasheq 'uri (uri (build-path directory "definition.rkt"))
                                   'identity 1 'version 1 'text text))))
(define (request directory)
  (hasheq 'uri (uri (build-path directory "definition.rkt")) 'identity 1 'version 1
          'position (hasheq 'line 2 'character 10) 'includeDeclaration #t))
(define (await event seconds description)
  (or (sync/timeout seconds event) (error 'workspace-analysis-test "timed out: ~a" description)))

(module+ test
  (test-case "a worker that cannot load its libraries reports what it said"
    (define directory (make-temporary-file "workspace-engine-load~a" 'directory))
    (define engine (make-engine))
    (dynamic-wind
      void
      (lambda ()
        (update! engine (fixture directory))
        (check-true (result? (query engine 'references (request directory))))
        (define failed
          (parameterize ([current-library-collection-paths '()])
            (query engine 'references (request directory))))
        (check-true (failure? failed))
        (check-regexp-match #rx"analysis worker exited with status 1: ."
                            (failure-message failed)))
      (lambda () (close! engine) (delete-directory/files directory))))

  (test-case "the engine supplies references and rename without an editor or transport"
    (define directory (make-temporary-file "workspace-engine~a" 'directory))
    (define engine (make-engine))
    (dynamic-wind
      void
      (lambda ()
        (update! engine (fixture directory))
        (define references (query engine 'references (request directory)))
        (check-true (result? references))
        (check-equal? (result-revision references) 1)
        (check-not-false
          (member (uri (build-path directory "consumer.rkt"))
                  (map (lambda (location) (hash-ref location 'uri)) (result-value references))))
        (define rename (query engine 'rename (hash-set (request directory) 'newName "squared")))
        (check-true (result? rename))
        (check-equal? (hash-count (hash-ref (result-value rename) 'changes)) 2)
        (check-equal? (file->string (build-path directory "definition.rkt")) definition)
        (close! engine)
        (define closed (query engine 'references (request directory)))
        (check-true (failure? closed))
        (check-eq? (failure-reason closed) 'closed)
        (update! engine (hash-set (fixture directory) 'revision 2))
        (check-eq? (failure-reason (query engine 'references (request directory))) 'closed))
      (lambda () (close! engine) (delete-directory/files directory))))

  (test-case "instances have independent workers and closing one cancels and reaps its analysis"
    (define first (make-temporary-file "workspace-engine-first~a" 'directory))
    (define second (make-temporary-file "workspace-engine-second~a" 'directory))
    (define entered (build-path first "entered"))
    (define blocked
      (string-append definition
        (format "(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ~s #:exists 'truncate (lambda (out) (display \"entered\" out))) (sync never-evt))\n"
                (path->string entered))))
    (define one (make-engine))
    (define two (make-engine))
    (define pending #f)
    (dynamic-wind
      void
      (lambda ()
        (update! one (fixture first blocked))
        (update! two (fixture second))
        ;; A pass runs for a request, and this one holds it open until the close.
        (define asking (thread (lambda () (query one 'references (request first)))))
        (define ready (query two 'references (request second)))
        (check-true (result? ready) "one instance must not occupy another's worker slot")
        (define deadline (+ (current-inexact-milliseconds) 15000))
        (let wait ()
          (unless (file-exists? entered)
            (when (> (current-inexact-milliseconds) deadline) (error 'test "expansion did not reach its gate"))
            (sleep 0.025) (wait)))
        (define cancel (make-semaphore))
        (define cancelled (make-async-channel))
        (thread (lambda () (async-channel-put cancelled (query one 'references (request first) (semaphore-peek-evt cancel)))))
        (semaphore-post cancel)
        (check-eq? (failure-reason (await cancelled 5 "request cancellation")) 'cancelled)
        (define replies (make-async-channel))
        (set! pending (thread (lambda () (async-channel-put replies (query one 'references (request first))))))
        (define closing (thread (lambda () (close! one))))
        (await closing 10 "engine shutdown")
        (check-eq? (failure-reason (await replies 5 "closed engine query")) 'closed)
        (await pending 5 "query thread exit")
        (await asking 5 "first request's end")
        (check-true (result? (query two 'references (request second)))))
      (lambda ()
        (close! one) (close! two)
        (when pending (sync/timeout 5 pending))
        (delete-directory/files first) (delete-directory/files second)))))
