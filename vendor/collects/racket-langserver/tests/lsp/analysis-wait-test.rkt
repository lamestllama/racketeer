#lang racket/base

;; The analysis of an edit waits for a pause in editing, and a request a person
;; makes does not sit out that wait. These tests run the production consumer
;; and speak LSP to it, except where they own the controller to look at a
;; completion. Timing assertions are lower bounds, which a slow machine cannot
;; break; where a request must not wait, the wait is far longer than the test.
(require rackunit
         racket/async-channel
         racket/file
         "../../common/path-util.rkt"
         "../../common/source.rkt"
         "../../common/interfaces.rkt"
         "../../common/time.rkt"
         "../../lsp/analysis.rkt"
         "../../lsp/safedoc.rkt"
         "../../lsp/source-controller.rkt"
         (submod "../../lsp/source-controller.rkt" owner)
         "../../workspace/source-store.rkt"
         "controller-support.rkt")

(define the-wait 250)

;; One start of an analyser: its text, the buffers its imports read, and when.
(struct Started (text buffers at))

;; hold? is asked about each start; a held analysis runs until it is cancelled.
(define (make-recorder [hold? (lambda (_started) #f)])
  (define starts (make-async-channel))
  (values starts
          (lambda (snapshot)
            (define context (current-analysis-context))
            (define start
              (Started (Source-Snapshot-text snapshot)
                       (if context (Analysis-Context-buffers context) (hash))
                       (current-deadline-milliseconds)))
            (async-channel-put starts start)
            (when (hold? start) (sync never-evt))
            (analyze-source snapshot))))

(define (drain channel)
  (let loop ([values '()])
    (define value (sync/timeout 0 channel))
    (if value (loop (cons value values)) (reverse values))))

(define (start-of starts text)
  (let loop ()
    (define start (await starts 30))
    (if (equal? text (Started-text start)) start (loop))))

(define (program n)
  (format "#lang racket/base\n(define x ~a)\nx\n" n))

;; The first diagnostics published for `path` from now on.
(define (await-publish session path)
  (define uri (path->uri path))
  (let loop ()
    (define message (await (Session-notifications session) 30))
    (define params (hash-ref message 'params (hasheq)))
    (unless (and (equal? (hash-ref message 'method #f) "textDocument/publishDiagnostics")
                 (equal? (hash-ref params 'uri #f) uri))
      (loop))))

(define (open-and-settle! session starts path text)
  (open! session path text)
  (start-of starts text)
  (await-publish session path))

;; A controller whose wait outlasts every test, so that a request can only have
;; been answered by not waiting.
(define (long-wait-controller analyze)
  (make-source-controller #:resyntax #f #:analyze analyze #:analysis-wait 30))

(define (no-start-yet starts)
  (sleep 0.05)
  (check-equal? (map Started-text (drain starts)) '() "analysis started during the wait"))

(define position (hasheq 'position (hasheq 'line 1 'character 8)))
(define whole-range
  (hasheq 'start (hasheq 'line 0 'character 0) 'end (hasheq 'line 2 'character 0)))

(define (token-count response)
  (length (hash-ref (hash-ref response 'result) 'data)))

(define (with-project proc)
  (define root (make-temporary-file "analysis-wait~a" 'directory))
  (dynamic-wind void (lambda () (proc root)) (lambda () (delete-directory/files root))))

(define (provider n)
  (format "#lang racket/base\n(provide value)\n(define value ~a)\n" n))
(define consumer-text "#lang racket/base\n(require \"dependency.rkt\")\nvalue\n")
(define consumer-position (hasheq 'position (hasheq 'line 2 'character 0)))

;; A project of one open consumer of one open dependency, settled.
(define (with-consumer controller starts proc)
  (with-project
    (lambda (root)
      (define dependency (build-path root "dependency.rkt"))
      (define consumer (build-path root "consumer.rkt"))
      (display-to-file (provider 0) dependency)
      (display-to-file consumer-text consumer)
      (with-session controller
                    (lambda (session)
                      (open-and-settle! session starts consumer consumer-text)
                      (open! session dependency (provider 0))
                      (await-publish session dependency)
                      ;; Opening the dependency analyses its consumer again.
                      (request! session 900 "textDocument/documentHighlight" consumer
                                consumer-position)
                      (response session 900 60)
                      (request! session 901 "textDocument/semanticTokens/full" consumer)
                      (check-false (hash-ref (response session 901 60) 'error #f))
                      (drain starts)
                      (proc session dependency consumer))))))

;; Live threads of the session and of the workers below it. Each test gives the
;; session a parent so that it may ask.
(define (session-threads parent)
  (for/sum ([item (in-list (custodian-managed-list (current-custodian) parent))]
            #:when (and (thread? item) (thread-running? item)))
    1))

(module+ test
  (test-case "a burst of edits starts one analysis of its last text, after the wait"
    (define-values (starts analyze) (make-recorder))
    (with-session
      (make-source-controller #:resyntax #f #:analyze analyze)
      (lambda (session)
        (define path (build-path scratch "wait-burst.rkt"))
        (open-and-settle! session starts path (program 0))
        ;; Four edits 100 ms apart span more than the wait, so only restarting
        ;; it at each edit keeps the earlier texts from being analysed. A machine
        ;; too busy to keep the edits inside the wait proves nothing: try again.
        (let try ([round 1])
          (define texts (for/list ([edit 4]) (program (+ edit (* round 100)))))
          (define-values (last-sent gaps)
            (for/fold ([sent #f] [gaps '()])
                      ([text (in-list texts)] [version (in-naturals (* round 10))])
              (when sent (sleep 0.1))
              (define now (current-deadline-milliseconds))
              (change! session path text version)
              (values now (if sent (cons (- now sent) gaps) gaps))))
          (define start (await starts 30))
          (await-publish session path)
          (define published (current-deadline-milliseconds))
          (cond
            [(andmap (lambda (gap) (< gap the-wait)) gaps)
             (check-equal? (Started-text start) (car (reverse texts)))
             (check-true (>= (Started-at start) (+ last-sent the-wait))
                         "analysis started before the wait passed")
             (check-true (>= published (+ last-sent the-wait))
                         "diagnostics published during the wait")
             (check-false (sync/timeout (/ (* 2 the-wait) 1000) starts) "a further analysis started")
             (check-false (sync/timeout 0 (Session-notifications session)) "published again")]
            [(< round 5)
             (drain starts)
             (try (add1 round))]
            [else (fail-check "the machine never kept the edits inside the wait")])))))

  (test-case "a request a person makes starts analysis at once, and others leave the wait alone"
    (define-values (starts analyze) (make-recorder))
    (with-session
      (long-wait-controller analyze)
      (lambda (session)
        (define path (build-path scratch "wait-requests.rkt"))
        (define version 0)
        (define (edit!)
          (set! version (add1 version))
          (define text (program version))
          (change! session path text version)
          (barrier session)
          text)
        (open-and-settle! session starts path (program 0))
        (for ([request (in-list
                         `(("textDocument/hover" ,position)
                           ("textDocument/definition" ,position)
                           ("textDocument/references"
                            ,(hash-set position 'context (hasheq 'includeDeclaration #t)))
                           ("textDocument/documentHighlight" ,position)
                           ("textDocument/prepareRename" ,position)
                           ("textDocument/rename" ,(hash-set position 'newName "y"))
                           ("textDocument/codeAction"
                            ,(hasheq 'range whole-range 'context (hasheq 'diagnostics '())))))]
              [id (in-naturals 1000)])
          (define text (edit!))
          (no-start-yet starts)
          (request! session id (car request) path (cadr request))
          (check-false (hash-ref (response session id 20) 'error #f) (car request))
          (check-equal? (Started-text (await starts 20)) text (car request)))
        (for ([request (in-list
                         `(("textDocument/completion" ,position)
                           ("textDocument/signatureHelp" ,position)
                           ("textDocument/documentSymbol" ,(hasheq))))]
              [id (in-naturals 2000)])
          (edit!)
          (drain starts)
          (request! session id (car request) path (cadr request))
          (check-false (hash-ref (response session id 20) 'error #f) (car request))
          (no-start-yet starts)))))

  (test-case "semantic tokens during the wait answer from the current text, after the wait"
    (define-values (starts analyze) (make-recorder))
    (with-session
      (make-source-controller #:resyntax #f #:analyze analyze)
      (lambda (session)
        (define path (build-path scratch "wait-tokens.rkt"))
        (open-and-settle! session starts path (program 0))
        (request! session 1 "textDocument/semanticTokens/full" path)
        (define before (token-count (response session 1 20)))
        (define longer (string-append (program 0) "(define y 2)\ny\n"))
        (define sent (current-deadline-milliseconds))
        (change! session path longer 1)
        (request! session 2 "textDocument/semanticTokens/full" path)
        (check-true (> (token-count (response session 2 20)) before))
        (define start (await starts 20))
        (check-equal? (Started-text start) longer)
        (check-true (>= (Started-at start) (+ sent the-wait)) "the request ended the wait"))))

  (test-case "inlay hints and ranged tokens join the wait, and an edit ends their request"
    (define-values (starts analyze) (make-recorder))
    (with-session
      (make-source-controller #:resyntax #f #:analyze analyze)
      (lambda (session)
        (define path (build-path scratch "wait-joining.rkt"))
        (open-and-settle! session starts path (program 0))
        (for ([method (in-list '("textDocument/inlayHint" "textDocument/semanticTokens/range"))]
              [id (in-naturals 1)])
          (define sent (current-deadline-milliseconds))
          (change! session path (program id) id)
          (request! session id method path (hasheq 'range whole-range))
          (check-false (hash-ref (response session id 20) 'error #f) method)
          (define start (await starts 20))
          (check-equal? (Started-text start) (program id) method)
          (check-true (>= (Started-at start) (+ sent the-wait)) method))
        (change! session path (program 3) 3)
        (request! session 3 "textDocument/semanticTokens/full" path)
        (change! session path (program 4) 4)
        (check-error (response session 3 20) ErrorCode-ContentModified)
        (check-equal? (Started-text (await starts 20)) (program 4)))))

  (test-case "dependents wait too, for the last edit of their import"
    (define-values (starts analyze) (make-recorder))
    (with-consumer
      (make-source-controller #:resyntax #f #:analyze analyze)
      starts
      (lambda (session dependency consumer)
        (change! session dependency (provider 1) 1)
        (define sent (current-deadline-milliseconds))
        (change! session dependency (provider 2) 2)
        (define start (start-of starts consumer-text))
        (check-true (>= (Started-at start) (+ sent the-wait))
                    "the dependent started before the wait passed")
        (check-equal? (hash-ref (Started-buffers start) (normalize-source-path dependency) #f)
                      (provider 2)))))

  (test-case "a request on a dependent starts it at once, reading its import as it is now"
    (define-values (starts analyze) (make-recorder))
    (with-consumer
      (long-wait-controller analyze)
      starts
      (lambda (session dependency consumer)
        (change! session dependency (provider 1) 1)
        (no-start-yet starts)
        (request! session 1 "textDocument/documentHighlight" consumer consumer-position)
        (check-false (hash-ref (response session 1 20) 'error #f))
        (define start (start-of starts consumer-text))
        (check-equal? (hash-ref (Started-buffers start) (normalize-source-path dependency) #f)
                      (provider 1))
        ;; The dependency itself has not been asked for, so it goes on waiting.
        (no-start-yet starts))))

  (test-case "a token request whose analysis an import edit replaces follows it to the successor"
    ;; The analysis that reads the first edit never finishes.
    (define-values (starts analyze)
      (make-recorder
        (lambda (start)
          (and (equal? (Started-text start) consumer-text)
               (member (provider 1) (hash-values (Started-buffers start)))))))
    (with-consumer
      (make-source-controller #:resyntax #f #:analyze analyze)
      starts
      (lambda (session dependency consumer)
        (change! session dependency (provider 1) 1)
        (request! session 1 "textDocument/semanticTokens/full" consumer)
        (start-of starts consumer-text)
        (define sent (current-deadline-milliseconds))
        (change! session dependency (provider 2) 2)
        (define start (start-of starts consumer-text))
        (check-equal? (hash-ref (Started-buffers start) (normalize-source-path dependency) #f)
                      (provider 2))
        (check-true (>= (Started-at start) (+ sent the-wait)) "the successor did not wait")
        (check-false (hash-ref (response session 1 20) 'error #f)))))

  (for ([ending (in-list '(close shutdown))])
    (test-case (format "~a during a wait leaves nothing running" ending)
      ;; Only the text that opens the document may finish.
      (define-values (starts analyze)
        (make-recorder (lambda (start) (not (equal? (Started-text start) (program 0))))))
      (define parent (make-custodian))
      (parameterize ([current-custodian parent])
        (with-session
          (make-source-controller #:resyntax #f #:analyze analyze)
          (lambda (session)
            (define path (build-path scratch (format "wait-~a.rkt" ending)))
            (open-and-settle! session starts path (program 0))
            (sleep 0.2)
            (define threads (session-threads parent))
            (change! session path (program 1) 1)
            (barrier session)
            (sleep 0.05)
            (check-true (<= (session-threads parent) threads) "the wait started threads")
            (case ending
              [(close) (close! session path) (barrier session)]
              [(shutdown) (shutdown! session)])
            (sleep (/ (* 2 the-wait) 1000))
            (check-equal? (map Started-text (drain starts)) '() "analysis started after the wait ended")
            (check-true (<= (session-threads parent) threads) "threads remain after the wait ended"))))
      (custodian-shutdown-all parent)))

  (test-case "a further edit, close or shutdown settles what a waiter holds"
    (define-values (starts analyze) (make-recorder))
    (define controller (make-source-controller #:resyntax #f #:analyze analyze))
    (define path (build-path scratch "wait-settle.rkt"))
    (define source (path->source path))
    (define (open-buffer)
      (define sd (new-safedoc (path->uri path) (program 0) 0))
      (source-controller-open! controller source sd)
      sd)
    (define (edit! sd)
      (source-controller-edit! controller sd (lambda (doc) (void)))
      (with-read-safedoc sd SafeDoc-analysis-completion))
    (define sd (open-buffer))
    (define first (edit! sd))
    (define second (edit! sd))
    (check-equal? (await first) (Analysis-Outcome 'stopped 'source-changed))
    (source-controller-close! controller source sd)
    (check-equal? (await second) (Analysis-Outcome 'stopped 'source-changed))
    (define third (edit! (open-buffer)))
    (source-controller-shutdown! controller)
    (check-equal? (await third) (Analysis-Outcome 'stopped 'shutdown))))
