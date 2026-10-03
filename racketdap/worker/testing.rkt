#lang racket/base

;; Loaded in the program's namespace, so these parameters and counters are the
;; same instances used by its tests. Framework access uses public exports.
(require rackunit raco/testing racket/list
         (prefix-in teaching: test-engine/test-engine))
(provide make-test-runner call-with-discovered-test run-discovered-tests)

(define current-test-events (make-parameter void))
(define current-test-selection (make-parameter #f))
(define current-test-paths (make-parameter '()))
;; Retain RackUnit's public default formatter before project code configures
;; check handlers. Rendering a suite result must not invoke project handlers.
(define display-check-result (current-check-handler))

(define (teaching-failures)
  (define teaching (teaching:current-test-object))
  (append (teaching:test-object-failed-checks teaching)
          (teaching:test-object-signature-violations teaching)))

(define (call-with-discovered-test id name thunk [suite? #f])
  (when (or (not (current-test-selection)) (member id (current-test-selection)))
    (when (and (not suite?) (ormap (lambda (item) (= id (hash-ref item 'id))) (current-test-paths)))
      (error 'test-selection "Nested selections require a RackUnit runner call."))
    (define emit (current-test-events))
    (define before (car (test-report)))
    (define previous (teaching-failures))
    (emit (hasheq 'kind "case" 'id id 'name name 'status "started"))
    (begin0 (thunk)
      (emit (hasheq 'kind "case" 'id id 'name name
                    ;; test-engine replaces its results when test runs again.
                    ;; A fresh failure matters even if the count is unchanged.
                    'status (if (or (> (car (test-report)) before)
                                    (ormap (lambda (failure) (not (memq failure previous)))
                                           (teaching-failures)))
                                "failed" "passed"))))))

(define (failure-message value)
  (define infos (if (exn:test:check? value) (exn:test:check-stack value) '()))
  (define (info name)
    (define entry (findf (lambda (entry) (eq? (check-info-name entry) name)) infos))
    (and entry (check-info-value entry)))
  (define name (current-test-name))
  (define message
    (cond [(exn:test:check? value)
           (format "~a failed~a" (or (info 'name) "Check")
                   (if (string? (info 'message)) (string-append ": " (info 'message)) ""))]
          [(exn? value) (exn-message value)]
          [else "Test raised a non-exception value; see test output."]))
  (define locations
    (if (exn:srclocs? value) ((exn:srclocs-accessor value) value) '()))
  (define loc (findf (lambda (loc) (path-string? (srcloc-source loc))) locations))
  (define base (hasheq 'kind "failure" 'message (if name (format "~a: ~a" name message) message)))
  (if loc
      (hash-set base 'location
                (hasheq 'path (path->string (path->complete-path (srcloc-source loc)))
                        'position (srcloc-position loc)))
      base))

;; RackUnit's public fold owns suite construction, fixtures and check semantics.
;; Paths include sibling ordinals and names so duplicate names remain distinct.
;; Traversal still occurs during selection; only unselected case bodies are skipped.
(define (run-discovered-tests id tests [mode 'normal])
  (unless (memq mode '(quiet normal verbose))
    (raise-argument-error 'run-tests "(or/c 'quiet 'normal 'verbose)" mode))
  (define emit (current-test-events))
  (define selected
    (filter (lambda (item) (= id (hash-ref item 'id))) (current-test-paths)))
  (define missing (remove-duplicates (map (lambda (item) (hash-ref item 'path)) selected)))
  (define parents '())
  (define next 0)
  (define (next-path name)
    (begin0 (append (map car (reverse parents)) (list (list next (or name #f))))
      (set! next (add1 next))))
  (define total 0)
  (define failed
    (fold-test-results
     (lambda (failure count) (+ count failure)) 0 tests
     #:fdown (lambda (name count)
               (define path (next-path name))
               (set! parents (cons (cons (last path) next) parents))
               (set! next 0)
               count)
     #:fup (lambda (_ count)
             (set! next (cdar parents))
             (set! parents (cdr parents))
             count)
     #:run
     (lambda (name action)
       (define path (next-path name))
       (define event (hasheq 'kind "case" 'id id 'path path 'name (or name "Unnamed test")))
       (define (status value) (emit (hash-set event 'status value)))
       (cond
         [(and (pair? selected) (not (member path missing))) (status "skipped") 0]
         [else
          (set! missing (remove path missing))
          (status "started")
          (define before (car (test-report)))
          (define result (run-test-case name action))
          (define passed? (test-success? result))
          (test-log! passed?)
          (set! total (add1 total))
          (unless passed?
            (define value (if (test-failure? result) (test-failure-result result) (test-error-result result)))
            (parameterize ([current-test-name name])
              (emit (failure-message value))
              (display-check-result value)))
          (status (cond [(test-error? result) "errored"]
                        [(or (not passed?) (> (car (test-report)) before)) "failed"]
                        [else "passed"]))
          (if passed? 0 1)]))))
  (unless (null? missing)
    (error 'run-tests "Selected tests changed or disappeared. Run the suite again to refresh its results."))
  (unless (eq? mode 'quiet) (printf "~a tests, ~a failures.\n" total failed))
  failed)

(define (make-test-runner emit [selection #f] [paths '()])
  (define initial (test-report))
  (define reported? #f)
  (define (observe around)
    (lambda (body)
      ;; Delegate control flow and logging to RackUnit. Observe exceptions only
      ;; after the body's own handlers have had the opportunity to handle them.
      (around (lambda ()
                (with-handlers ([(lambda (value) (not (exn:break? value)))
                                 (lambda (value) (emit (failure-message value)) (raise value))])
                  (body))))))
  (define (report status)
    (unless reported?
      (set! reported? #t)
      ;; Teaching languages run their own registered checks. Read their public
      ;; result object after execution; running the checks again would repeat
      ;; effects and would disagree with the program's test configuration.
      (define teaching (teaching:current-test-object))
      (define checks (teaching:test-object-failed-checks teaching))
      (define violations (teaching:test-object-signature-violations teaching))
      (define registered (length (teaching:test-object-tests teaching)))
      (define completed (+ (length (teaching:test-object-successful-tests teaching)) (length checks)))
      (define (teaching-failure message loc)
        (define result (hasheq 'kind "failure" 'message message))
        (emit (if (and loc (path-string? (srcloc-source loc)))
                  (hash-set result 'location
                            (hasheq 'path (path->string (path->complete-path (srcloc-source loc)))
                                    'position (srcloc-position loc))) result)))
      (for ([check (in-list (reverse checks))])
        (teaching-failure "Teaching-language check failed; see test output for the actual and expected results."
                          (teaching:fail-reason-srcloc (teaching:failed-check-reason check))))
      (for ([violation (in-list (reverse violations))])
        (teaching-failure "Teaching-language signature violation; see test output."
                          (or (teaching:signature-violation-blame-srcloc violation)
                              (teaching:signature-violation-srcloc violation))))
      (when (< completed registered)
        (set! status "errored")
        (teaching-failure "Registered teaching-language checks did not all run. Enable test execution and invoke test in plain Racket modules."
                          #f))
      (define totals (test-report))
      (define failed (+ (- (car totals) (car initial)) (length checks) (length violations)))
      (emit (hasheq 'kind "summary" 'status (if (and (equal? status "passed") (positive? failed)) "failed" status)
                    'failed failed 'total (+ (- (cdr totals) (cdr initial)) registered (length violations))))))
  (values
   (lambda (thunk)
     (parameterize ([current-check-around (observe (current-check-around))]
                    [current-test-case-around (observe (current-test-case-around))]
                    [current-test-events emit]
                    [current-test-selection selection]
                    [current-test-paths paths]
                    [current-test-invocation-directory (current-directory)])
       (thunk))
     (report "passed"))
   (lambda (value)
     ;; The loader calls this from its existing exception handler, after the
     ;; debugger has had access to the original live continuation.
     (unless reported? (emit (failure-message value)) (report "errored")))))
