#lang racket/base

;; Loaded in the program's namespace, so these parameters and counters are the
;; same instances used by its tests. All RackUnit access uses public exports.
(require rackunit raco/testing racket/list)
(provide make-test-runner call-with-discovered-test)

(define current-test-events (make-parameter void))
(define current-test-selection (make-parameter #f))

(define (call-with-discovered-test id name thunk)
  (when (or (not (current-test-selection)) (member id (current-test-selection)))
    (define emit (current-test-events))
    (define before (test-report))
    (emit (hasheq 'kind "case" 'id id 'name name 'status "started"))
    (begin0 (thunk)
      (emit (hasheq 'kind "case" 'id id 'name name
                    'status (if (> (car (test-report)) (car before)) "failed" "passed"))))))

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

(define (make-test-runner emit [selection #f])
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
      (define totals (test-report))
      (define failed (- (car totals) (car initial)))
      (emit (hasheq 'kind "summary" 'status (if (and (equal? status "passed") (positive? failed)) "failed" status)
                    'failed failed 'total (- (cdr totals) (cdr initial))))))
  (values
   (lambda (thunk)
     (parameterize ([current-check-around (observe (current-check-around))]
                    [current-test-case-around (observe (current-test-case-around))]
                    [current-test-events emit]
                    [current-test-selection selection]
                    [current-test-invocation-directory (current-directory)])
       (thunk))
     (report "passed"))
   (lambda (value)
     ;; The loader calls this from its existing exception handler, after the
     ;; debugger has had access to the original live continuation.
     (unless reported? (emit (failure-message value)) (report "errored")))))
