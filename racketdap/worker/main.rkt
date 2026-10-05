#lang racket/base

(require racket/async-channel racket/file racket/list racket/path racket/port
         racket/string racket/tcp
         "../protocol.rkt" "../commands.rkt" "../source.rkt" "../packages.rkt" "../process-group.rkt" "load.rkt" "../instrumentation/instrument.rkt"
         "inspect.rkt" "stepping.rkt" "expressions.rkt" "cancel.rkt" "images.rkt" "plots.rkt" "coverage.rkt" "interactions.rkt")

(define bootstrap (read-message (current-input-port)))
(join-process-group! (hash-ref bootstrap 'processGroup #f))
(define-values (control-in control-out) (tcp-connect "127.0.0.1" (hash-ref bootstrap 'port)))
(define output-lock (make-semaphore 1))
(define (send object) (call-with-semaphore output-lock (lambda () (write-message object control-out))))
(send (hasheq 'type "hello" 'version 1 'token (hash-ref bootstrap 'token)))
(define config (hash-ref bootstrap 'config))
(define-values (program-input input-writer)
  (if (equal? (hash-ref config 'console "internalConsole") "integratedTerminal")
      (make-pipe) (values (open-input-bytes #"") #f)))
(define target-thread #f)
(define client (hash-ref bootstrap 'client))
(define controller-custodian (current-custodian))
(define (arg h key [default #f]) (hash-ref h key default))
(define (event name [body (hasheq)]) (send (hasheq 'type "event" 'event name 'body body)))
(define awaiting (make-hasheqv))
(define (reply request [body (hasheq)] [error #f])
  (hash-remove! awaiting (hash-ref request 'seq))
  (forget-evaluation! evaluations (hash-ref request 'seq))
  (send (hasheq 'type "response" 'request_seq (hash-ref request 'seq)
                'command (hash-ref request 'command) 'success (not error)
                'body body 'message (or error ""))))
(define next-id 0)
(define id-lock (make-semaphore 1))
(define (fresh-id)
  (call-with-semaphore id-lock (lambda () (set! next-id (add1 next-id)) next-id)))
(define sources (make-hash))
(define sites (make-hash))
(define coverage-hits (make-hasheqv))
(define (on-coverage-event stop)
  (when (eq? (stop-kind stop) 'before)
    (hash-set! coverage-hits (site-id (stop-site stop)) #t)))
(define breakpoints (make-hash))
(define frames (make-hasheqv))
(define variables (make-hasheqv))
(define states (make-hasheq))
(define states-by-id (make-hasheqv))
(struct state (id thread paused step pause? run-to) #:mutable)
(struct paused (state stop inbox ids) #:transparent)
(struct breakpoint (id request targets description rule hits phase) #:mutable)
(define evaluations (make-evaluations))
(define exception-enabled? #f)
(define interaction #f)
(define (error-text value) (if (exn? value) (exn-message value) (value-preview value)))
(define (flush-program-output)
  (for ([port (in-list (list (current-output-port) (current-error-port)))])
    (unless (port-closed? port) (flush-output port))))
(define (new-breakpoint request)
  (define bp (breakpoint (fresh-id) request '() "Pending source loading" #f 0 'before))
  (with-handlers ([exn:fail? (lambda (e) (set-breakpoint-description! bp (exn-message e)))])
    (set-breakpoint-rule! bp (compile-breakpoint-rule request)))
  bp)
(define started? #f)
(define ended? #f)
(define entry-pending? (arg config 'stopOnEntry #f))
(define lines-one? (arg client 'linesStartAt1 #t))
(define columns-one? (arg client 'columnsStartAt1 #t))
(define line-base (if lines-one? 1 0))
(define column-base (if columns-one? 1 0))
(define (coordinate request key base [default #f])
  (define value (hash-ref request key default))
  (unless (and (exact-integer? value) (>= value base))
    (error 'breakpoint "~a must be an integer greater than or equal to ~a" key base))
  value)
(define (validate-breakpoint request)
  (unless (hash? request) (error 'breakpoint "Each breakpoint must be an object"))
  (coordinate request 'line line-base)
  (when (hash-has-key? request 'column) (coordinate request 'column column-base))
  (when (and (hash-has-key? request 'phase) (not (member (hash-ref request 'phase) '("before" "after"))))
    (error 'breakpoint "phase must be before or after")))
(define (canonical p) (simplify-path (path->complete-path p)))
(define (referenced-source reference)
  (or (and (exact-positive-integer? reference)
           (findf (lambda (source) (= (source-file-id source) reference)) (hash-values sources)))
      (error 'source "Unknown source reference.")))
(define (source-path source)
  (define reference (arg source 'sourceReference 0))
  (if (equal? reference 0)
      (canonical (hash-ref source 'path))
      (source-file-path (referenced-source reference))))
(define (source-json source)
  (hasheq 'name (path->string (file-name-from-path (source-file-path source)))
          'path (path->string (source-file-path source)) 'sourceReference (source-file-id source)))
(define (location source position span)
  (define-values (line column) (source-location source position))
  (define-values (end-line end-column) (source-location source (+ (or position 1) (or span 0))))
  (hasheq 'source (source-json source) 'line (- line (if lines-one? 0 1))
          'column (- column (if columns-one? 0 1))
          'endLine (- end-line (if lines-one? 0 1))
          'endColumn (- end-column (if columns-one? 0 1))))
(define (breakpoint-json bp path)
  (define targets (breakpoint-targets bp))
  (define source (hash-ref sources path #f))
  (define base (hasheq 'id (breakpoint-id bp) 'verified (pair? targets)
                       'message (breakpoint-description bp)))
  (if (and source (pair? targets))
      (for/fold ([result base]) ([(key value) (in-hash (location source (site-boundary-position (car targets) (breakpoint-phase bp))
                                                               (if (eq? (breakpoint-phase bp) 'after) 1 (site-span (car targets)))))])
        (hash-set result key value))
      (hash-set base 'line (arg (breakpoint-request bp) 'line 1))))
(define (select-targets path request)
  (define source (hash-ref sources path #f))
  (define phase (arg request 'phase #f))
  (unless (member phase '(#f "before" "after")) (error 'breakpoint "phase must be before or after"))
  (define line (+ (hash-ref request 'line) (if lines-one? 0 1)))
  (define column (and (arg request 'column) (+ (arg request 'column) (if columns-one? 0 1))))
  (define (select kind [exact? #f])
    (if source (choose-sites (hash-ref sites path '()) source line column #:phase kind #:exact? exact?) '()))
  (cond
    [phase (values (select (string->symbol phase)) (string->symbol phase))]
    [(and column (pair? (select 'before #t))) (values (select 'before #t) 'before)]
    [(and column (pair? (select 'after #t))) (values (select 'after #t) 'after)]
    [else (values (select 'before) 'before)]))
(define (resolve! path)
  (define source (hash-ref sources path #f))
  (for ([bp (in-list (hash-ref breakpoints path '()))])
    (define request (breakpoint-request bp))
    (define-values (selected phase)
      (if (and source (breakpoint-rule bp)) (select-targets path request) (values '() 'before)))
    (set-breakpoint-targets! bp selected)
    (set-breakpoint-phase! bp phase)
    (set-breakpoint-description!
     bp (cond [(not (breakpoint-rule bp)) (breakpoint-description bp)]
              [(pair? selected) (if (eq? phase 'after) "Expression completion breakpoint" "Expression breakpoint")]
              [source "No executable expression begins at this location."]
              [else "Pending source loading; an already loaded dependency requires restart."]))))
(define (on-source-snapshot path text)
  (unless (hash-has-key? sources path)
    (define source (capture-source path (fresh-id) #:text text))
    (hash-set! sources path source)
    (event "loadedSource" (hasheq 'reason "new" 'source (source-json source)))))
(define (on-test-event result)
  (when (and (arg config 'coverage #f) (equal? (hash-ref result 'kind) "summary")
             (not (equal? (hash-ref result 'status) "errored")))
    (for ([file (in-list (coverage-files sources sites coverage-hits))])
      (event "racketdap/coverage" file)))
  (when (and (equal? (hash-ref result 'kind) "failure") (arg result 'location))
    (define raw (hash-ref result 'location))
    (define source (hash-ref sources (canonical (hash-ref raw 'path)) #f))
    ;; Source positions count Racket characters; the editor needs UTF-16.
    ;; Use the captured program text, even if the user has since saved edits.
    (set! result
          (if (and source (arg raw 'position))
              (let-values ([(line column) (source-location source (hash-ref raw 'position))])
                (hash-set result 'location (hasheq 'path (path->string (source-file-path source))
                                                   'line line 'column column)))
              (hash-remove result 'location))))
  (event "racketdap/test" result))
(define (on-sites more)
  (for ([site (in-list more)])
    (hash-update! sites (site-source site) (lambda (old) (cons site old)) '()))
  (for ([path (in-list (remove-duplicates (map site-source more)))])
    (resolve! path)
    (for ([bp (in-list (hash-ref breakpoints path '()))])
      (event "breakpoint" (hasheq 'reason "changed" 'breakpoint (breakpoint-json bp path))))))
(define (register-thread)
  (hash-ref!
   states (current-thread)
   (lambda ()
     (define st (state (fresh-id) (current-thread) #f #f #f #f))
     (hash-set! states-by-id (state-id st) st)
     (event "thread" (hasheq 'reason "started" 'threadId (state-id st)))
     (parameterize ([current-custodian controller-custodian])
       (thread (lambda ()
                 (sync (thread-dead-evt (state-thread st)))
                 (when (state-paused st)
                   (release-pause! (state-paused st))
                   (set-state-paused! st #f))
                 (hash-remove! states (state-thread st))
                 (hash-remove! states-by-id (state-id st))
                 (unless ended? (event "thread" (hasheq 'reason "exited" 'threadId (state-id st)))))))
     st)))
(define (new-handle table pause value)
  (define id (fresh-id))
  (hash-set! table id (cons pause value))
  (set-box! (paused-ids pause) (cons (cons table id) (unbox (paused-ids pause))))
  id)
(define (invalidate! pause)
  (for ([entry (in-list (unbox (paused-ids pause)))]) (hash-remove! (car entry) (cdr entry)))
  (set-box! (paused-ids pause) '()))
(define (release-pause! pause)
  (invalidate! pause)
  (for ([entry (in-list (hash-values awaiting))] #:when (eq? (car entry) pause))
    (reply (cdr entry) (hasheq) "The paused thread resumed or ended.")))
(define (describe pause name value)
  (define image? (image-value? value))
  (define plot? (plot-value? value))
  (define result
    (hasheq 'name name 'value (if plot? "#<interactive plot>" (value-preview value))
            'type (if plot? "plot" (value-type value))
            'variablesReference (if (or image? plot? (expandable? value))
                                    (new-handle variables pause (cons 'value value)) 0)))
  (define visual (if image? (hash-set result 'racketdapImage #t) result))
  (cond [plot? (hash-set (hash-set visual 'racketdapPlot #t) '__vscodeVariableMenuContext "racketdap.plot")]
        [image? (hash-set visual '__vscodeVariableMenuContext "racketdap.image")]
        [else visual]))
(define (describe-results pause result)
  (define display-result
    (cond [(null? result) (hasheq 'value "#<zero values>" 'type "values" 'variablesReference 0)]
          [(null? (cdr result)) (describe pause "" (car result))]
          [else
           ;; Bound the picker metadata and retained handles like a variables page.
           (define image-count 0)
           (hasheq 'value (string-join (map value-preview (take result (min 10 (length result)))) "\n")
                        'type "values" 'variablesReference (new-handle variables pause (cons 'results result))
                        'racketdapImages
                        (for/list ([value (in-list result)] [i (in-naturals 1)]
                                   #:break (= image-count 200)
                                   #:when (or (image-value? value) (plot-value? value)))
                          (set! image-count (add1 image-count))
                          (describe pause (format "value ~a" i) value)))]))
  (hash-set (hash-remove (hash-remove display-result 'name) 'value) 'result (hash-ref display-result 'value)))
(define (interaction-results request pause result)
  (when (and (arg config 'racketdapRichInteractions #f)
             (equal? (arg (arg request 'arguments (hasheq)) 'context) "repl"))
    (for ([value (in-list result)]) ((current-print) value)))
  (describe-results pause result))
(define (owned table id pause)
  (define entry (hash-ref table id #f))
  (unless (and entry (eq? (car entry) pause)) (error 'debugger "Expired or invalid reference; refresh the paused frame."))
  (cdr entry))
(define (inspect-request request pause)
  (define stop (paused-stop pause))
  (define a (arg request 'arguments (hasheq)))
  (define command (hash-ref request 'command))
  (unless (command-allowed-at? command (and stop (stop-kind stop)))
    (error 'debugger "This action is unavailable at the current stop."))
  (when (and (command-flag? command 'executing) (arg a 'frameId)
             (not (zero? (owned frames (arg a 'frameId) pause))))
    (error 'debugger "Expression actions apply to the executing frame."))
  (case (string->symbol command)
    [(racketdap/openPlot)
     (define descriptor (owned variables (hash-ref a 'variablesReference) pause))
     (unless (eq? (car descriptor) 'value) (error 'plot "Select a single interactive plot."))
     (open-plot (cdr descriptor))]
    [(racketdap/renderImage)
     (define descriptor (owned variables (hash-ref a 'variablesReference) pause))
     (unless (eq? (car descriptor) 'value) (error 'image "Select a single image value."))
     (render-image (cdr descriptor))]
    [(racketdap/skipExpression racketdap/replaceResults)
     (define result (call-with-values (lambda () (stop-evaluate stop (read-expression (hash-ref a 'expression)))) list))
     (if (equal? command "racketdap/skipExpression")
         (stop-skip! stop result)
         (stop-replace-results! stop result))
     (event "invalidated" (hasheq 'areas (if (equal? command "racketdap/replaceResults")
                                           '("stacks" "variables") '("variables"))
                                  'threadId (state-id (paused-state pause))))
     (describe-results pause result)]
    [(racketdap/printBinding racketdap/setBinding)
     (define index (if (arg a 'frameId) (owned frames (arg a 'frameId) pause) 0))
     (define value
       (if (equal? (hash-ref request 'command) "racketdap/setBinding")
           (stop-set-binding! stop (hash-ref a 'name) (read-expression (hash-ref a 'expression)) index)
           (stop-binding-value stop (hash-ref a 'name) index)))
     (if (equal? (hash-ref request 'command) "racketdap/printBinding")
         (event "output" (hasheq 'category "console" 'output
                                (parameterize ([print-graph #t]) (format "~s\n" value))))
         (event "invalidated" (hasheq 'areas '("variables") 'threadId (state-id (paused-state pause)))))
     (describe-results pause (list value))]
    [(racketdap/printResults)
     (define result (describe-results pause (stop-results stop)))
     (define output (open-output-string))
     (parameterize ([print-graph #t])
       (if (null? (stop-results stop)) (display "#<zero values>\n" output)
           (for ([value (in-list (stop-results stop))]) (write value output) (newline output))))
     (event "output" (hasheq 'category "console" 'output (get-output-string output)))
     result]
    [(exceptionInfo)
     (define value (car (stop-results stop)))
     (define name (cond [(exn:fail:contract? value) "exn:fail:contract"]
                        [(exn:fail? value) "exn:fail"] [(exn? value) "exn"] [else "raised value"]))
     (hasheq 'exceptionId name 'description (error-text value) 'breakMode "unhandled"
             'details (hasheq 'message (error-text value) 'typeName name))]
    [(stackTrace)
     (define total (stop-frame-count stop))
     (define start (max 0 (arg a 'startFrame 0)))
     (define levels (arg a 'levels 0))
     (define end (min total (+ start (if (zero? levels) 100 levels))))
     (hasheq 'totalFrames total 'stackFrames
             (for/list ([i (in-range (min start total) end)])
               (define raw (stop-frame-source stop i))
               (define source (hash-ref sources (syntax-source raw) #f))
               (define returned? (and (zero? i) (eq? (stop-kind stop) 'after)))
               (define return-position (and returned? (site-boundary-position (stop-site stop) 'after)))
               (define position (or return-position (syntax-position raw)))
               (define loc (if source (location source position (if return-position 1 (syntax-span raw)))
                               (hasheq 'line 1 'column 1)))
               (define label
                 (cond
                   [(positive? i) "Waiting for return"]
                   [returned?
                    (define count (length (stop-results stop)))
                    (format "Returned ~a ~a" count (if (= count 1) "value" "values"))]
                   [else (case (stop-kind stop)
                           [(before) "Before evaluation"]
                           [(exception) "Exception"]
                           [else "Paused (approximate)"])]))
               (hash-set (hash-set loc 'id (new-handle frames pause i))
                         'name (format "~a at ~a:~a" label
                                       (if source (path->string (file-name-from-path (source-file-path source))) "Racket")
                                       (hash-ref loc 'line)))))]
    [(scopes)
     (define index (owned frames (hash-ref a 'frameId) pause))
     (hasheq 'scopes
             (append
              (list (hasheq 'name "Locals" 'presentationHint "locals" 'expensive #f
                            'variablesReference (new-handle variables pause (cons 'locals index))))
              (if (and (zero? index) (eq? (stop-kind stop) 'after))
                  (list (hasheq 'name (format "Results (~a values)" (length (stop-results stop)))
                                'expensive #f 'variablesReference
                                (new-handle variables pause (cons 'return-results stop)))) '())
              (if (and (zero? index) (eq? (stop-kind stop) 'exception))
                  (list (hasheq 'name "Exception" 'expensive #f 'variablesReference
                                (new-handle variables pause (cons 'results (stop-results stop))))) '())))]
    [(variables)
     (define descriptor (owned variables (hash-ref a 'variablesReference) pause))
     (define start (min 10000 (max 0 (arg a 'start 0))))
     (define count (min 200 (max 1 (let ([n (arg a 'count 100)]) (if (zero? n) 100 n)))))
     (define pairs
       (case (car descriptor)
         [(value) (children (cdr descriptor) start count)]
         [else
          (define all
            (if (eq? (car descriptor) 'locals)
                (map (lambda (p) (cons (symbol->string (car p)) (cdr p))) (stop-locals stop (cdr descriptor)))
                (for/list ([v (in-list (if (eq? (car descriptor) 'return-results)
                                          (stop-results (cdr descriptor)) (cdr descriptor)))]
                           [i (in-naturals 1)]) (cons (format "value ~a" i) v))))
          (take (drop all (min start (length all))) (min count (max 0 (- (length all) start))))]))
     (hasheq 'variables (map (lambda (pair) (describe pause (car pair) (cdr pair))) pairs))]
    [(evaluate)
     (define index (if (arg a 'frameId) (owned frames (arg a 'frameId) pause) 0))
     (define expression (hash-ref a 'expression))
     (define result
       (if (equal? (arg a 'context) "hover")
           (list (stop-binding-value stop expression index))
           (call-with-values (lambda () (stop-evaluate stop (read-expression expression) index)) list)))
     (interaction-results request pause result)]
    [(setVariable)
     (define descriptor (owned variables (hash-ref a 'variablesReference) pause))
     (unless (eq? (car descriptor) 'locals) (error 'setVariable "Only lexical locals can be assigned here."))
     (hash-remove (describe pause (hash-ref a 'name)
                            (stop-set-binding! stop (hash-ref a 'name)
                                                (read-expression (hash-ref a 'value)) (cdr descriptor) #:scope 'lexical)) 'name)]
    [else (error 'debugger "Unsupported paused request")]))
(define (respond-to request thunk)
  (define a (arg request 'arguments (hasheq)))
  (define echo? (and (equal? (hash-ref request 'command) "evaluate")
                     (equal? (arg a 'context) "repl") (arg a 'racketdapEcho #f)))
  (define (echo text)
    (when echo? (event "output" (hasheq 'category "console" 'output (string-append text "\n")))))
  (with-handlers ([(lambda (_) #t) (lambda (e) (echo (error-text e)) (reply request (hasheq) (error-text e)))])
    (when echo? (echo (string-append "> " (hash-ref a 'expression))))
    (define result
      (if (command-flag? (hash-ref request 'command) 'evaluate)
          (call-with-evaluation evaluations (hash-ref request 'seq) thunk)
          (thunk)))
    (when echo? (echo (hash-ref result 'result)))
    (reply request result)))
(define (pause-loop st stop reason description hit-ids)
  (define pause (paused st stop (make-async-channel) (box '())))
  (set-state-paused! st pause)
  (set-state-step! st #f)
  (set-state-pause?! st #f)
  (event "stopped" (hasheq 'reason reason 'description description 'threadId (state-id st)
                            'allThreadsStopped #f 'hitBreakpointIds hit-ids
                            'racketdapStopKind (symbol->string (stop-kind stop))
                            'racketdapApproximate (stop-approximate? stop)
                            'racketdapActions (stop-actions (stop-kind stop))))
  (dynamic-wind
    void
    (lambda ()
      (let loop ()
        (define request (async-channel-get (paused-inbox pause)))
        (define command (hash-ref request 'command))
        (cond
          [(command-flag? command 'resume)
           (define a (arg request 'arguments (hasheq)))
           (define valid?
             (with-handlers ([exn:fail? (lambda (e) (reply request (hasheq) (exn-message e)) #f)])
               (when (equal? command "racketdap/continueToLocation")
                 (define path (source-path (hash-ref a 'source)))
                 (define-values (targets phase) (select-targets path a))
                 (when (null? targets) (error 'continue-to "No executable expression boundary at this location."))
                 (set-state-run-to! st (cons phase targets)))
               #t))
           (cond
             [valid?
              (set-state-step! st (and (command-flag? command 'step)
                                      (make-step (string->symbol command) stop)))
              (when (state-step st) (set-state-run-to! st #f))
              (unless (command-flag? command 'internal)
                (reply request (if (equal? command "continue")
                                   (hasheq 'allThreadsContinued (not (arg a 'singleThread #f))) (hasheq))))
              (set-state-paused! st #f)
              (invalidate! pause)
              (event "continued" (hasheq 'threadId (state-id st) 'allThreadsContinued #f))]
             [else (loop)])]
          [else
           (respond-to request (lambda () (inspect-request request pause)))
           (loop)])))
    (lambda ()
      (release-pause! pause)
      (when (state-paused st)
        (set-state-paused! st #f)
        (event "continued" (hasheq 'threadId (state-id st) 'allThreadsContinued #f))))))
(define (on-event stop)
  (define st (register-thread))
  (define where (stop-site stop))
  (define before? (eq? (stop-kind stop) 'before))
  (define failure #f)
  (define hit-ids
        (for/list ([bp (in-list (hash-ref breakpoints (site-source where) '()))]
                   #:when (eq? (breakpoint-phase bp) (stop-kind stop))
                   #:when (for/or ([target (in-list (breakpoint-targets bp))]) (= (site-id target) (site-id where)))
                   #:when
                   (let ([rule (breakpoint-rule bp)])
                     (set-breakpoint-hits! bp (add1 (breakpoint-hits bp)))
                     (and ((breakpoint-rule-hit? rule) (breakpoint-hits bp))
                          (with-handlers ([(lambda (_) #t)
                                           (lambda (e)
                                             (set! failure (string-append "Breakpoint expression failed: " (error-text e)))
                                             #t)])
                            (define id (- (fresh-id)))
                            (queue-evaluation! evaluations id)
                            (call-with-evaluation
                             evaluations id
                             (lambda ()
                               (define condition (breakpoint-rule-condition rule))
                               (and (or (not condition) (stop-evaluate stop (expression-form condition)))
                                    (if (breakpoint-rule-log rule)
                                        (begin
                                          (event "output"
                                                 (hash-set
                                                  (location (hash-ref sources (site-source where))
                                                            (site-position where) (site-span where))
                                                  'output (render-log-message
                                                           (breakpoint-rule-log rule)
                                                           (lambda (form) (stop-evaluate stop form)) value-preview)))
                                          #f)
                                        #t))))))))
          (breakpoint-id bp)))
  (define step-message (step-reason (state-step st) stop))
  (define run-to (state-run-to st))
  (define reached?
    (and run-to (eq? (car run-to) (stop-kind stop))
         (for/or ([target (in-list (cdr run-to))]) (= (site-id target) (site-id where)))))
  (when reached? (set-state-run-to! st #f))
  (cond
    [(pair? hit-ids) (set! entry-pending? #f) (pause-loop st stop "breakpoint" (or failure (if before? "Before expression" "Expression returned")) hit-ids)]
    [reached? (pause-loop st stop "goto" "Continue-to target reached" '())]
    [(and before? entry-pending?) (set! entry-pending? #f) (pause-loop st stop "entry" "Starting program; first expression has not run" '())]
    [(and before? (eq? (state-pause? st) 'deferred)) (pause-loop st stop "pause" "Paused at an expression" '())]
    [step-message (pause-loop st stop "step" step-message '())]))
(define (on-exception stop)
  (when exception-enabled?
    (pause-loop (register-thread) stop "exception" (error-text (car (stop-results stop))) '())))
(define (on-pause raised)
  (define st (hash-ref states (current-thread) #f))
  (and st (state-pause? st)
       (begin
         (set-state-pause?! st 'deferred)
         (call-with-pause-stop raised
           (lambda (stop) (pause-loop st stop "pause" "Paused; source location is approximate" '())))
         #t)))
(define (interactive-loop namespace)
  (define st (register-thread))
  (set! interaction (paused st #f (make-async-channel) (box '())))
  (flush-program-output)
  (event "output" (hasheq 'category "console" 'output "Module loaded. Evaluate Racket expressions in the Debug Console.\n"))
  (let loop ()
    (event "racketdap/ready")
    (define gui-namespace
      (with-handlers ([exn:fail? (lambda (_) #f)]) (module->namespace 'racket/gui/base)))
    (define request
      (if gui-namespace
          ((dynamic-require 'racket/gui/base 'yield) (paused-inbox interaction))
          (async-channel-get (paused-inbox interaction))))
    (respond-to
     request
     (lambda ()
       (cond
         [(equal? (hash-ref request 'command) "evaluate")
          (invalidate! interaction)
          (interaction-results
           request interaction
           (call-with-values
            (lambda ()
              (call-with-exception-handler
               (make-debug-exception-handler on-exception on-pause)
               (lambda () (eval (read-expression (hash-ref (arg request 'arguments) 'expression)) namespace))))
            list))]
         [else (inspect-request request interaction)])))
    (flush-program-output)
    (loop)))
(define (rich-port original category)
  (if (arg config 'racketdapRichInteractions #f)
      (interaction-output-port original category
                               (lambda (body) (event "racketdap/interactionOutput" body)))
      original))
(define (start-program)
  (set! started? #t)
  (set! target-thread
   (thread
   (lambda ()
     (define exit-code 0)
     ;; GUI callbacks can run while the interaction loop is waiting. Flush each
     ;; output line without requiring another console request to release it.
     (for ([port (in-list (list (current-output-port) (current-error-port)))])
       (when (file-stream-port? port) (file-stream-buffer-mode port 'line)))
     (with-handlers ([(lambda (_) #t)
                      (lambda (e)
                        (set! exit-code 1)
                        ((error-display-handler) (error-text e) e))])
       (parameterize ([current-input-port program-input]
                      [current-output-port (rich-port (current-output-port) "stdout")]
                      [current-error-port (rich-port (current-error-port) "stderr")]
                      [current-inspector (if (arg config 'noDebug #f)
                                             (current-inspector) (make-inspector))]
                      [current-subprocess-custodian-mode 'kill]
                      [exit-handler
                       (lambda (status)
                         ;; Let the adapter drain output and clean up this worker
                         ;; and its descendants through the owned group anchor.
                         (flush-program-output)
                         (set! ended? #t)
                         (send (hasheq 'type "workerExit" 'exitCode (if (byte? status) status 1)))
                         (sync never-evt))]
                      [current-command-line-arguments (list->vector (arg config 'args '()))])
         (run-module (hash-ref config 'program)
                     #:instrument? (or (arg config 'coverage #f) (not (arg config 'noDebug #f)))
                     #:coverage? (arg config 'coverage #f)
                     #:on-event (if (arg config 'coverage #f) on-coverage-event on-event)
                     #:on-exception (and (not (arg config 'noDebug #f)) on-exception)
                     #:on-pause (and (not (arg config 'noDebug #f)) on-pause)
                     #:language (and (arg config 'language) (string->symbol (arg config 'language)))
                     #:on-sites on-sites #:on-source-snapshot on-source-snapshot
                     #:source-roots (append (arg config 'sourceRoots (list (arg config 'cwd)))
                                            (if (arg config 'noDebug #f) '()
                                                (package-source-roots (arg config 'debugPackages '()))))
                     #:source-selected? (lambda (path) (pair? (hash-ref breakpoints path '())))
                     #:submodule (map string->symbol (arg config 'submodule '()))
                     #:main? (and (not (arg config 'testMode #f)) (not (hash-has-key? config 'submodule)))
                     #:test? (arg config 'testMode #f)
                     #:test-selection (arg config 'testSelection #f)
                     #:on-test-event
                     (lambda (result)
                       (when (and (equal? (hash-ref result 'kind) "summary")
                                  (not (equal? (hash-ref result 'status) "passed")))
                         (set! exit-code 1))
                       (on-test-event result))
                     #:on-ready (and (arg config 'interactive #f) interactive-loop)
                     #:entry (and (arg config 'entry) (string->symbol (arg config 'entry))))))
     (flush-program-output)
     (set! ended? #t)
     (send (hasheq 'type "workerExit" 'exitCode exit-code)))))
  (thread
   (lambda ()
     (sync (thread-dead-evt target-thread))
     (unless ended?
       (set! ended? #t)
       (send (hasheq 'type "workerExit" 'exitCode 1))))))
(define (dispatch request)
  (define a (arg request 'arguments (hasheq)))
  (define command (hash-ref request 'command))
  (case (string->symbol command)
    [(setBreakpoints)
     (define path (source-path (hash-ref a 'source)))
     (define requested (arg a 'breakpoints '()))
     (unless (list? requested) (error 'setBreakpoints "breakpoints must be an array"))
     ;; A pending breakpoint is resolved later on the target thread. Validate
     ;; all locations now so a malformed request cannot poison source loading
     ;; or replace the previously installed breakpoint set.
     (for-each validate-breakpoint requested)
     (define old (hash-ref breakpoints path '()))
     (define updated
       (for/list ([b (in-list requested)])
         (define existing (findf (lambda (o) (equal? (breakpoint-request o) b)) old))
         (or existing (new-breakpoint b))))
     (hash-set! breakpoints path updated)
     (resolve! path)
     (reply request (hasheq 'breakpoints (map (lambda (b) (breakpoint-json b path)) updated)))]
    [(setExceptionBreakpoints)
     (define filters (arg a 'filters '()))
     (unless (andmap (lambda (f) (equal? f "uncaught")) filters)
       (error 'setExceptionBreakpoints "Only uncaught runtime exception stops are supported."))
     (set! exception-enabled? (and (member "uncaught" filters) #t))
     (reply request (hasheq 'breakpoints (for/list ([filter (in-list filters)]) (hasheq 'verified #t))))]
    [(cancel)
     (when (arg a 'requestId) (cancel-evaluations! evaluations (arg a 'requestId)))
     (reply request)]
    [(racketdap/cancelEvaluation)
     (reply request (hasheq 'cancelled (cancel-evaluations! evaluations)))]
    [(racketdap/input)
     (unless (and input-writer (not (port-closed? input-writer)))
       (error 'input "Program input is closed or the integrated terminal was not selected."))
     (when (arg a 'text) (display (arg a 'text) input-writer) (flush-output input-writer))
     (when (arg a 'eof #f) (close-output-port input-writer))
     (reply request)]
    [(racketdap/interrupt)
     (when (and target-thread (zero? (cancel-evaluations! evaluations))) (break-thread target-thread))
     (reply request)]
    [(configurationDone)
     (when started? (error 'launch "Program has already started."))
     (reply request) (start-program)]
    [(threads)
     (reply request
            (hasheq 'threads (for/list ([st (in-hash-values states-by-id)] #:unless (thread-dead? (state-thread st)))
                               (hasheq 'id (state-id st) 'name (format "Racket thread ~a" (state-id st))))))]
    [(source)
     (define source (referenced-source (arg a 'sourceReference 0)))
     (reply request (hasheq 'content (source-file-text source) 'mimeType "text/x-racket"))]
    [(loadedSources) (reply request (hasheq 'sources (map source-json (hash-values sources))))]
    [(breakpointLocations)
     (define path (source-path (hash-ref a 'source)))
     (define source (hash-ref sources path #f))
     (define first-line (coordinate a 'line line-base line-base))
     (define last-line (coordinate a 'endLine line-base first-line))
     (define first-column (coordinate a 'column column-base column-base))
     (define last-column (if (hash-has-key? a 'endColumn) (coordinate a 'endColumn column-base) +inf.0))
     (unless (or (< first-line last-line) (and (= first-line last-line) (<= first-column last-column)))
       (error 'breakpointLocations "The end of the range must not precede its start"))
     (define (in-range? position)
       (define-values (line column) (source-location source position))
       (define l (- line (- 1 line-base)))
       (define c (- column (- 1 column-base)))
       (and (<= first-line l last-line)
            (or (> l first-line) (>= c first-column))
            (or (< l last-line) (<= c last-column))))
     (reply request (hasheq 'breakpoints
                            (if source
                                (sort (remove-duplicates
                                 (for*/list ([s (in-list (hash-ref sites path '()))]
                                             [phase (in-list (site-phases s))]
                                            #:when (site-boundary-position s phase)
                                            #:when (in-range? (site-boundary-position s phase)))
                                   (hash-set (hash-remove (location source (site-boundary-position s phase)
                                                                  (if (eq? phase 'after) 1 (site-span s))) 'source)
                                             'racketdapPhase (symbol->string phase))))
                                      (lambda (left right)
                                        (or (< (hash-ref left 'line) (hash-ref right 'line))
                                            (and (= (hash-ref left 'line) (hash-ref right 'line))
                                                 (< (hash-ref left 'column) (hash-ref right 'column)))))) '())))]
    [(pause)
     (define st (hash-ref states-by-id (hash-ref a 'threadId)))
     (reply request)
     (unless (or (state-paused st) (state-pause? st))
       (set-state-pause?! st 'requested)
       (break-thread (state-thread st)))]
    [else
     (unless (command-flag? command 'paused) (error 'debugger "Unsupported request: ~a" command))
     (define owner
       (cond [(arg a 'frameId) (car (hash-ref frames (arg a 'frameId) (lambda () (error 'debugger "Expired frame reference."))))]
             [(arg a 'variablesReference) (car (hash-ref variables (arg a 'variablesReference) (lambda () (error 'debugger "Expired variable reference."))))]
             [(arg a 'threadId) (state-paused (hash-ref states-by-id (arg a 'threadId)))]
             [else (or (for/first ([st (in-hash-values states-by-id)] #:when (state-paused st)) (state-paused st))
                       (and (command-flag? command 'interactive)
                            (equal? (arg a 'context "repl") "repl") interaction))]))
     (unless (and owner (or (eq? owner interaction) (eq? owner (state-paused (paused-state owner)))))
       (error 'debugger "Pause the program before using this command."))
     (when (and (command-flag? command 'all-threads) (not (arg a 'singleThread #f)))
       (for ([st (in-hash-values states-by-id)] #:when (and (state-paused st) (not (eq? (state-paused st) owner))))
         (async-channel-put (paused-inbox (state-paused st)) (hasheq 'command "internalContinue"))))
     (when (command-flag? command 'evaluate)
       (queue-evaluation! evaluations (hash-ref request 'seq)))
     (hash-set! awaiting (hash-ref request 'seq) (cons owner request))
     (async-channel-put (paused-inbox owner) request)]))

(let loop ()
  (define request (read-message control-in))
  (unless (eof-object? request)
    (with-handlers ([exn:fail? (lambda (e) (reply request (hasheq) (exn-message e)))]) (dispatch request))
    (loop)))
