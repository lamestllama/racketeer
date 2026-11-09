#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/async-channel racket/file racket/list racket/runtime-path racket/string
         "../racketdap/language-adapters.rkt"
         (only-in (submod "adapter-debugger.rkt" support) with-session start frames evaluate)
         "../vendor/collects/racket-langserver/common/interfaces.rkt"
         "../vendor/collects/racket-langserver/common/json-util.rkt"
         "../vendor/collects/racket-langserver/doclib/doc.rkt"
         "../vendor/collects/racket-langserver/doclib/language-adapter.rkt"
         "../vendor/collects/racket-langserver/common/source.rkt"
         "../vendor/collects/racket-langserver/lsp/analysis.rkt"
         "../vendor/collects/racket-langserver/lsp/safedoc.rkt"
         "../vendor/collects/racket-langserver/lsp/source-controller.rkt"
         (submod "../vendor/collects/racket-langserver/lsp/source-controller.rkt" owner)
         (only-in "../vendor/collects/racket-langserver/tests/lsp/controller-support.rkt" drive-controller)
         (prefix-in client: "../vendor/collects/racket-langserver/tests/client.rkt"))

(define-runtime-path native-module "../racketdap/adapters/rhombus.rkt")
(define-runtime-path debugger-module "../racketdap/adapters/rhombus-debugger.rkt")
(define-runtime-path native-descriptor "../racketdap/language-adapters.rktd")
(define-runtime-path launcher "../vscode/language-adapters.rkt")
(define available?
  (and (equal? (getenv "RACKETDAP_TEST_RHOMBUS") "1")
       (with-handlers ([exn:fail? (lambda (_) #f)])
         (collection-file-path "main.rkt" "rhombus") #t)))
(define tools "namespace Tools:\n  export: scale\n  fun scale(x): x * 2\n  def hidden = 1\n")
(define point "class Point(x, y):\n  method norm(): x + y\n")
(define (complete body [suffix ""] [uri "file:///tmp/member.rhm"] [ending "\n"])
  (dynamic-require launcher #f)
  (define text (string-append (string-replace (string-append "#lang rhombus\n" body) "\n" ending) suffix))
  (define doc (make-doc uri text))
  (parameterize ([current-completion-position (- (string-length text) (string-length suffix))])
    (doc-expand! doc))
  (values doc (doc-completion doc (doc-abs-pos->pos doc (- (string-length text) (string-length suffix))))))
(define (labels result) (map CompletionItem-label (CompletionList-items result)))
(define (expect-member doc result name start end)
  (define item (findf (lambda (x) (equal? (CompletionItem-label x) name)) (CompletionList-items result)))
  (check-not-false item)
  (when item
    (define edit (hash-ref (->jsexpr item) 'textEdit #f))
    (check-true (hash? edit))
    (when (hash? edit)
      (check-equal? (hash-ref edit 'range)
                    (->jsexpr (Range (doc-abs-pos->pos doc start) (doc-abs-pos->pos doc end))))
      (check-equal? (hash-ref edit 'newText) name))))
(define (last-start doc n) (- (string-length (doc-get-text doc)) n))

(module+ test
  (unless available?
    (displayln "Skipping Rhombus member completion: install Rhombus and set RACKETDAP_TEST_RHOMBUS=1"))
  (test-case "a failing completion helper preserves bindings, outline, signatures and watches"
    (when available?
      (dynamic-require launcher #f)
      (define root (make-temporary-file "unavailable-completion~a" 'directory))
      (dynamic-wind void
        (lambda ()
          (define descriptor (build-path root "language-adapters.rktd"))
          (make-directory (build-path root "adapters"))
          (call-with-output-file descriptor
            (lambda (out) (write (car (call-with-input-file native-descriptor read)) out)))
          (copy-file native-module (build-path root "adapters/rhombus.rkt"))
          (copy-file debugger-module (build-path root "adapters/rhombus-debugger.rkt"))
          (define helper (build-path root "adapters/rhombus-completion.rkt"))
          (display-to-file "#lang racket/base\n(require (submod racket/base missing-completion))\n" helper)
          (define text
            (string-append "#lang rhombus\nexport: run\nnamespace Tools:\n  export: scale\n"
                           "  fun scale(x): x + 1\nfun run():\n  def local = 20\n  Tools.scale(local)\n"))
          (define adapter
            (resolve-language-adapter "untitled:unavailable-completion" #:text text
                                      #:explicit descriptor #:declare-bindings? #t #:declare-editor? #t))
          (check-not-false (assoc helper (hash-ref (hash-ref adapter 'fingerprint) 'files)))
          (check-false (((current-language-adapter-completion) adapter) (hasheq)))
          (parameterize ([current-language-adapter-resolver
                          (lambda (file source-text pre roots)
                            (resolve-language-adapter file #:text source-text #:pre pre
                                                      #:explicit descriptor #:declare-bindings? #t #:declare-editor? #t))])
            (define doc (make-doc "file:///tmp/unavailable-completion.rhm" text))
            (define use-start (caar (regexp-match-positions #rx"Tools.scale\\(local" text)))
            (parameterize ([current-completion-position (+ use-start 6)])
              (check-true (doc-expand! doc)))
            (check-true (doc-trace-latest? doc))
            (check-pred CompletionList? (doc-completion doc (doc-abs-pos->pos doc (+ use-start 6))))
            (check-not-false (doc-definition doc "file:///tmp/unavailable-completion.rhm"
                                             (doc-abs-pos->pos doc (+ use-start 6))))
            (check-not-false (member "run" (map DocumentSymbol-name (doc-symbols-hierarchical doc))))
            (check-not-false (doc-signature-help doc (doc-abs-pos->pos doc (+ use-start 14)))))
          (with-session text
            (lambda (path ask event seen)
              (define stopped (start path ask event (list (hasheq 'line 8))))
              (check-equal? (evaluate ask "local + 1" (car (frames ask stopped))) "21"))
            #:context #f
            #:setup (lambda (directory)
                      (copy-directory/files root (build-path directory ".racketeer"))
                      (copy-file native-descriptor (build-path directory ".racketeer/language-adapters.rktd") #t))))
        (lambda () (delete-directory/files root)))))
  (test-case "fresh List trailing dot enumerates static exports"
    (when available?
      (define-values (doc result) (complete "List."))
      (expect-member doc result "map" (last-start doc 0) (last-start doc 0))))
  (test-case "fresh namespace trailing dot exposes only exports"
    (when available?
      (define-values (doc result) (complete (string-append tools "Tools.")))
      (expect-member doc result "scale" (last-start doc 0) (last-start doc 0))
      (check-false (member "hidden" (labels result)))))
  (test-case "fresh import trailing dot uses the saved source directory"
    (when available?
      (define root (make-temporary-file "members~a" 'directory))
      (dynamic-wind void
        (lambda ()
          (display-to-file "#lang rhombus\nexport: square\nfun square(x): x * x\nerror(\"must not execute\")\n" (build-path root "model.rhm"))
          (define-values (doc result)
            (complete "import \"model.rhm\"\nmodel." "" (string-append "file://" (path->string (build-path root "client.rhm")))))
          (expect-member doc result "square" (last-start doc 0) (last-start doc 0)))
        (lambda () (delete-directory/files root)))))
  (test-case "annotated receiver supplies fields and methods"
    (when available?
      (for ([body (list "fun use(obj :: Point): obj."
                        "def obj :: Point = Point(1, 2)\nerror(\"must not execute\")\nobj."
                        "def obj = Point(1, 2)\nobj.")])
        (define-values (doc result) (complete (string-append point body)))
        (expect-member doc result "x" (last-start doc 0) (last-start doc 0))
        (expect-member doc result "norm" (last-start doc 0) (last-start doc 0)))))
  (test-case "cancelled recovery never starts expansion"
    (when available?
      (define provider (dynamic-require native-module 'completion))
      (define text "#lang rhombus\nList.")
      (check-false (provider (hasheq 'text text 'uri "file:///tmp/cancelled-member.rhm"
                                     'position (string-length text) 'cancelled? (lambda () #t)) #f))))
  (test-case "member recovery is computed during analysis and queried from its facts"
    (when available?
      (dynamic-require launcher #f)
      (define lookup (current-language-adapter-completion))
      (define analysed? #f)
      (parameterize ([current-language-adapter-completion
                      (lambda (adapter)
                        (define provider (lookup adapter))
                        (and provider
                             (lambda (request)
                               (if (hash-has-key? (hash-ref request 'facts) 'completion)
                                   (check-true analysed?)
                                   (begin
                                     (check-equal? (hash-ref request 'position) (string-length (hash-ref request 'text)))
                                     (set! analysed? #t)))
                               (provider request))))])
        (define-values (doc result) (complete "List."))
        (check-true analysed?)
        (expect-member doc result "map" (last-start doc 0) (last-start doc 0)))))
  (test-case "held recovery is cancelled by edits and bounded by the analysis deadline"
    (when available?
      (dynamic-require launcher #f)
      (define lookup (current-language-adapter-completion))
      (for ([mode '(edit timeout)])
        (define entered (make-async-channel))
        (parameterize ([current-language-adapter-completion
                        (lambda (adapter)
                          (define provider (lookup adapter))
                          (and provider
                               (lambda (request)
                                 (async-channel-put entered (current-thread))
                                 (sync never-evt))))])
          (define controller (make-source-controller #:resyntax #f #:analysis-timeout 10))
          (dynamic-wind void
            (lambda ()
              (define source (uri->source "file:///tmp/held-member.rhm"))
              (define sd (new-safedoc (source-uri source) "#lang rhombus\nList." 0))
              (source-controller-open! controller source sd)
              (drive-controller controller (SafeDoc-analysis-completion sd) 90)
              (define completion
                (source-controller-ensure-analysis! controller
                  (source-controller-snapshot controller source) #:completion-position 19))
              (define worker
                (drive-controller controller
                  (choice-evt entered (wrap-evt completion (lambda (_) #f))) 90))
              (check-pred thread? worker)
              (when (thread? worker)
                (when (eq? mode 'edit)
                  (source-controller-edit! controller sd
                    (lambda (doc)
                      (doc-reset! doc "#lang rhombus\nList.map")
                      (doc-update-version! doc 1))))
                (define outcome (drive-controller controller completion 90))
                (check-eq? (Analysis-Outcome-state outcome) (if (eq? mode 'edit) 'stopped 'failed))
                (check-eq? (Analysis-Outcome-value outcome) (if (eq? mode 'edit) 'source-changed 'analysis-timeout))
                (check-not-false (sync/timeout 5 (thread-dead-evt worker)))
                (check-false (SafeDoc-available sd))))
            (lambda () (source-controller-shutdown! controller)))))))
  (test-case "overlapping accesses never read another position's recovery facts"
    (when available?
      (dynamic-require launcher #f)
      (define lookup (current-language-adapter-completion))
      (define entered (make-async-channel))
      (define release (make-semaphore 0))
      (define reads (make-async-channel))
      (define first-position 19)
      (define second-position 28)
      (parameterize ([current-language-adapter-completion
                      (lambda (adapter)
                        (and (lookup adapter)
                             (lambda (request)
                               (define position (hash-ref request 'position))
                               (define facts (hash-ref request 'facts))
                               (cond
                                 [(hash-has-key? facts 'completion)
                                  (async-channel-put reads
                                    (cons position (hash-ref facts 'completion-position)))
                                  (car (hash-ref facts 'completion))]
                                 [else
                                  (async-channel-put entered (cons position (current-thread)))
                                  (semaphore-wait release)
                                  (hasheq 'range (cons position position) 'incomplete? #f
                                          'items (list (hasheq 'label
                                                        (if (= position first-position)
                                                            "first-access-member"
                                                            "second-access-member"))))]))))])
        (define controller (make-source-controller #:resyntax #f))
        (client:with-session controller
          (lambda (session)
            (define uri "file:///tmp/overlapping-members.rhm")
            (client:open! session uri "#lang rhombus\nList.map\nList.map")
            (client:client-wait-notification session)
            (client:request! session 904 "textDocument/completion" uri
                             (hasheq 'position (hasheq 'line 1 'character 5)))
            (define first-worker (client:await entered 90))
            (check-equal? (car first-worker) first-position)
            (client:request! session 905 "textDocument/completion" uri
                             (hasheq 'position (hasheq 'line 2 'character 5)))
            (define second-worker (client:await entered 90))
            (check-equal? (car second-worker) second-position)
            (check-not-false (sync/timeout 5 (thread-dead-evt (cdr first-worker))))
            (semaphore-post release)
            (define first-response (client:response session 904 90))
            (define second-response (client:response session 905 90))
            (check-equal? (hash-ref (hash-ref first-response 'result) 'items) '())
            (check-equal? (map (lambda (item) (hash-ref item 'label))
                               (hash-ref (hash-ref second-response 'result) 'items))
                          '("second-access-member"))
            (check-equal? (async-channel-try-get reads) (cons second-position second-position))
            (check-false (async-channel-try-get reads)))))))
  (test-case "qualified annotations retain exported class fields and methods"
    (when available?
      (define root (make-temporary-file "qualified-members~a" 'directory))
      (dynamic-wind void
        (lambda ()
          (display-to-file "#lang rhombus\nexport: Point\nclass Point(oddfield1, oddfield2):\n  method unusual(): oddfield1 + oddfield2\n"
                           (build-path root "model.rhm"))
          (for ([body (list "namespace Tools:\n  export: Point\n  class Point(oddfield1, oddfield2):\n    method unusual(): oddfield1 + oddfield2\nfun use(obj :: Tools.Point): obj."
                            "import \"model.rhm\"\nfun use(obj :: model.Point): obj.")])
            (define-values (doc result)
              (complete body "" (string-append "file://" (path->string (build-path root "client.rhm")))))
            (for ([name '("oddfield1" "oddfield2" "unusual")])
              (expect-member doc result name (last-start doc 0) (last-start doc 0)))))
        (lambda () (delete-directory/files root)))))
  (test-case "multiline accesses retain syntax extents and partly typed member edits"
    (when available?
      (define provider (dynamic-require native-module 'completion))
      (for ([ending '("\n" "\r\n")])
        (define-values (doc result) (complete "List\n  .ma" "p" "file:///tmp/multiline-member.rhm" ending))
        (expect-member doc result "map" (last-start doc 3) (last-start doc 0))
        (define text (doc-get-text doc))
        (define native (provider (hasheq 'text text 'uri "file:///tmp/multiline-member.rhm"
                                        'position (sub1 (string-length text))) #f))
        (check-not-false native)
        (when native
          (define start (+ 13 (string-length ending)))
          (check-equal? (hash-ref native 'root-range) (cons start (+ start 4)))
          (check-equal? (hash-ref native 'range) (cons (last-start doc 3) (last-start doc 0)))))))
  (test-case "a dot is the only invalid edit and needs no accepted expansion"
    (when available?
      (define valid (make-doc "file:///tmp/valid-member.rhm" (string-append "#lang rhombus\n" tools "Tools.scale")))
      (check-true (doc-expand! valid))
      (define-values (doc result) (complete (string-append tools "Tools.")))
      (check-false (doc-trace-latest? doc))
      (expect-member doc result "scale" (last-start doc 0) (last-start doc 0))))
  (test-case "partly typed member replaces the full member and preserves its root"
    (when available?
      (define-values (doc result) (complete (string-append tools "Tools.sc") "ale"))
      (expect-member doc result "scale" (last-start doc 5) (last-start doc 0))))
  (test-case "CRLF and Unicode retain exact member edit positions"
    (when available?
      (define-values (doc result) (complete (string-append "def café = \"😀\"\n" tools "Tools.sc") "ale" "file:///tmp/crlf-member.rhm" "\r\n"))
      (expect-member doc result "scale" (last-start doc 5) (last-start doc 0))))
  (test-case "nested namespace member replaces only the last component"
    (when available?
      (define-values (doc result) (complete "namespace Outer:\n  export: Inner\n  namespace Inner:\n    export: deep\n    def deep = 1\nOuter.Inner."))
      (expect-member doc result "deep" (last-start doc 0) (last-start doc 0))))
  (test-case "dynamic and shadowed receivers have no invented members"
    (when available?
      (for ([body (list (string-append point "fun use(obj): obj.")
                        (string-append tools "fun use(Tools): Tools."))])
        (define-values (_doc result) (complete body))
        (check-equal? (labels result) '()))))
  (test-case "provider keeps root and member replacement ranges separate"
    (when available?
      (define provider (dynamic-require native-module 'completion (lambda () (lambda (_request _data) #f))))
      (define text "#lang rhombus\nList.maTT")
      (define result (provider (hasheq 'text text 'uri "file:///tmp/ranges.rhm" 'position (- (string-length text) 2)) #f))
      (check-not-false result)
      (when result
        (check-equal? (hash-ref result 'root-range) '(14 . 18))
        (check-equal? (hash-ref result 'range) '(19 . 23))
        (check-equal? (hash-ref result 'prefix) "ma"))))
  (test-case "ordinary identifier completion remains the fallback"
    (when available?
      (define-values (_doc result) (complete "def ordinary_name = 1\nordinary_name"))
      (check-not-false (member "ordinary_name" (labels result)))))
  (test-case "language without a provider preserves its completion result"
    (dynamic-require launcher #f)
    (define doc (make-doc "file:///tmp/plain-completion.rkt" "#lang racket/base\n(define ordinary-name 1)\nordinary-name"))
    (doc-expand! doc)
    (define before (doc-completion doc (doc-abs-pos->pos doc (string-length (doc-get-text doc)))))
    (parameterize ([current-language-adapter-resolver #f])
      (define plain (make-doc "file:///tmp/plain-completion.rkt" (doc-get-text doc)))
      (doc-expand! plain)
      ;; Separate analyses offer the same names in no promised order.
      (check-equal? (sort (labels (doc-completion plain (doc-abs-pos->pos plain (string-length (doc-get-text plain))))) string<?)
                    (sort (labels before) string<?))))
  (test-case "completion without a provider responds while analysis is held"
    (dynamic-require launcher #f)
    (define entered (make-async-channel))
    (define text "#lang racket/base\n(define ordinary-name 1)\nordinary-name")
    (define plain (make-doc "file:///tmp/held-plain.rkt" text))
    (define position (doc-abs-pos->pos plain (string-length text)))
    (define expected (->jsexpr (doc-completion plain position)))
    (define controller
      (make-source-controller #:resyntax #f
        #:analyze (lambda (_snapshot)
                    (async-channel-put entered (current-thread))
                    (sync never-evt))))
    (client:with-session controller
      (lambda (session)
        (client:open! session "file:///tmp/held-plain.rkt" text)
        (define worker (client:await entered))
        (client:request! session 901 "textDocument/completion" "file:///tmp/held-plain.rkt"
                         (hasheq 'position (->jsexpr position)))
        (define response (client:response session 901))
        (check-equal? (hash-ref response 'result #f) expected)
        (check-false (thread-dead? worker)))
      #:request-timeout 0.5))
  (test-case "completion recovery cost stays bounded as dotted accesses grow"
    (when available?
      (dynamic-require launcher #f)
      (define lookup (current-language-adapter-completion))
      (define measurements '())
      (define (measure size)
        (define elapsed 0)
        (define calls '())
        (parameterize ([current-language-adapter-completion
                        (lambda (adapter)
                          (define provider (lookup adapter))
                          (and provider
                               (lambda (request)
                                 (define start (current-inexact-monotonic-milliseconds))
                                 (define result (provider request))
                                 (unless (hash-has-key? (hash-ref request 'facts) 'completion)
                                   (set! elapsed (+ elapsed (- (current-inexact-monotonic-milliseconds) start)))
                                   (set! calls (cons (hash-ref request 'position) calls)))
                                 result)))])
          (define controller (make-source-controller #:resyntax #f))
          (client:with-session controller
            (lambda (session)
              (define text (string-append "#lang rhombus\n" (apply string-append (make-list size "List.map\n")) "List."))
              (define uri "file:///tmp/sized-members.rhm")
              (client:open! session uri text)
              (client:client-wait-notification session)
              (define position (hasheq 'line (add1 size) 'character 5))
              (for ([id '(902 903)])
                (client:request! session id "textDocument/completion" uri (hasheq 'position position))
                (define response (client:response session id 90))
                (check-not-false
                 (member "map" (map (lambda (item) (hash-ref item 'label))
                                    (hash-ref (hash-ref response 'result) 'items)))))
              (set! measurements (cons (list calls (string-length text)) measurements)))))
        elapsed)
      (measure 1)
      (define small (measure 3))
      (define large (measure 30))
      (printf "Recovery for 3 and 30 accesses: ~a ms, ~a ms\n" small large)
      (check-true (< large (* 4 small)))
      (for ([measurement (in-list measurements)])
        (check-equal? (car measurement) (list (cadr measurement))))))
  (test-case "whitespace after a dot retains members and cursor edits"
    (when available?
      (define provider (dynamic-require native-module 'completion))
      (for ([body '("List. " "List.\t" "List . " "List\n  . ")])
        (define-values (doc result) (complete body))
        (define end (last-start doc 0))
        (expect-member doc result "map" end end)
        (define text (doc-get-text doc))
        (define root-start 14)
        (define native (provider (hasheq 'text text 'uri "file:///tmp/space-member.rhm" 'position end) #f))
        (check-not-false native)
        (when native
          (check-equal? (hash-ref native 'prefix) "")
          (check-equal? (hash-ref native 'root-range) (cons root-start (+ root-start 4)))
          (check-equal? (hash-ref native 'range) (cons end end))))))
  (test-case "loading native tooling preserves generic completion triggers"
    (dynamic-require launcher #f)
    (client:with-racket-lsp
     (lambda (session)
       (define request (client:make-request session "initialize"
                          (hasheq 'processId 1 'capabilities (hasheq) 'rootUri "file:///tmp/" 'rootPath "/tmp")))
       (client:client-send session request)
       (define response (client:client-wait-response request))
       (check-equal? (hash-ref (hash-ref (hash-ref (hash-ref response 'result) 'capabilities) 'completionProvider) 'triggerCharacters)
                     '("("))))))
