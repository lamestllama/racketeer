#lang racket/base

;; Single-owner scheduling of analysis and Resyntax. Attempts, their queue,
;; and worker handles stay private; callers hold only completion events.
(require racket/async-channel
         racket/contract
         "../../common/settings.rkt"
         "../../common/source.rkt"
         "../../common/time.rkt"
         "../../workspace/source-store.rkt"
         "../analysis.rkt"
         "../../doclib/language-adapter.rkt"
         "completion-event.rkt"
         "supervised-worker.rkt")

(provide Analysis-Scheduler?
         make-analysis-scheduler
         scheduled-analysis-event
         scheduled-analysis-context
         request-analysis!
         defer-analysis!
         hasten-analysis!
         schedule-resyntax!
         cancel-source-analysis!
         stop-analysis-scheduler!
         pump-analysis-scheduler!
         analysis-wait-evt
         Analysis-Wait-Over?
         Analysis-Completed?
         finish-analysis-task!)

;; parent-completion identifies the accepted analysis refined by Resyntax.
;; context is the editor state imports read, or #f for ordinary loading; a
;; waiting attempt reads it when it joins the queue, so that it sees the buffers
;; as the wait left them. due is when a waiting attempt joins the queue, on the
;; deadline clock. worker is #f until execution starts. Terminal attempts leave
;; the registry.
(struct/contract Analysis-Attempt
  ([snapshot Source-Snapshot?]
   [(context #:mutable) (or/c #f Analysis-Context?)]
   [completion-position (or/c #f exact-nonnegative-integer?)]
   [kind (or/c 'analysis 'resyntax)]
   [parent-completion (or/c #f evt?)]
   [completion Completion-Event?]
   [(due #:mutable) real?]
   [(state #:mutable) (or/c 'waiting 'queued 'running 'terminal)]
   [(worker #:mutable) (or/c #f Supervised-Worker?)]))

(struct/contract Analysis-Scheduler
  ([events async-channel?]
   [analyze (-> Source-Snapshot? Analysis-Product?)]
   [resyntax (or/c #f (-> string? string? list?))]
   [timeout (and/c real? (>=/c 0))]
   [slots exact-positive-integer?]
   [wait (or/c #f (and/c real? (>=/c 0)))]
   [attempts (hash/c (cons/c Source-Id? (or/c 'analysis 'resyntax))
                     Analysis-Attempt? #:immutable #f)]
   [(queue #:mutable) (listof Analysis-Attempt?)]
   [(stopped? #:mutable) boolean?]))

;; The event envelope carries an identity privately; replay cannot revive an
;; attempt removed by completion, cancellation, or a same-revision retry.
(struct Analysis-Completed (attempt result))

;; The value of `analysis-wait-evt`. It carries nothing: the pump that follows
;; every dispatch queues whatever is due.
(struct Analysis-Wait-Over ())

;; wait is in seconds, as is timeout, or #f to read the setting at each edit.
(define (make-analysis-scheduler events #:analyze analyze #:resyntax resyntax
                                 #:timeout [timeout 90] #:slots [slots 4] #:wait [wait #f])
  (Analysis-Scheduler events analyze resyntax timeout slots wait (make-hash) '() #f))

(define (attempt-key attempt)
  (cons (Source-Snapshot-id (Analysis-Attempt-snapshot attempt))
        (Analysis-Attempt-kind attempt)))

(define (registered? scheduler attempt)
  (eq? attempt (hash-ref (Analysis-Scheduler-attempts scheduler) (attempt-key attempt) #f)))

(define (scheduled-analysis-event scheduler source)
  (define attempt
    (hash-ref (Analysis-Scheduler-attempts scheduler) (cons (source-id source) 'analysis) #f))
  (and attempt (Analysis-Attempt-completion attempt)))

;; Import context of the queued or running analysis for `source`, or #f.
(define (scheduled-analysis-context scheduler source)
  (define attempt
    (hash-ref (Analysis-Scheduler-attempts scheduler) (cons (source-id source) 'analysis) #f))
  (and attempt (Analysis-Attempt-context attempt)))

(define (enqueue! scheduler snapshot kind parent-completion [context #f] [position #f])
  (define attempt
    (Analysis-Attempt snapshot context position kind parent-completion (make-completion-event) 0 'queued #f))
  (hash-set! (Analysis-Scheduler-attempts scheduler) (attempt-key attempt) attempt)
  (set-Analysis-Scheduler-queue! scheduler
                                 (append (Analysis-Scheduler-queue scheduler) (list attempt)))
  (Analysis-Attempt-completion attempt))

;; Requests for the same revision and access share an attempt. Other analysis
;; queries can join it. A successor revision supersedes outstanding work for
;; this source, including its Resyntax.
(define (request-analysis! scheduler snapshot #:context [context #f]
                           #:completion-position [position #f])
  (define source (Source-Snapshot-source snapshot))
  (define active
    (hash-ref (Analysis-Scheduler-attempts scheduler) (cons (source-id source) 'analysis) #f))
  (cond
    [(Analysis-Scheduler-stopped? scheduler) (ready-evt (Analysis-Outcome 'stopped 'shutdown))]
    [(and active
          (or (not position) (equal? position (Analysis-Attempt-completion-position active)))
          (eq? (Source-Snapshot-revision snapshot)
               (Source-Snapshot-revision (Analysis-Attempt-snapshot active))))
     (hasten-analysis! scheduler source)
     (Analysis-Attempt-completion active)]
    [else
     (cancel-source-analysis! scheduler source)
     (enqueue! scheduler snapshot 'analysis #f context position)]))

;; Supersede outstanding work for this source with an attempt that joins the
;; queue once the wait has passed, unless a further call supersedes it first.
;; Nothing runs meanwhile: the wait is a time in the attempt, seen by
;; `analysis-wait-evt`, so settling the attempt is all it takes to end it.
(define (defer-analysis! scheduler snapshot [reason 'source-changed])
  (cond
    [(Analysis-Scheduler-stopped? scheduler) (ready-evt (Analysis-Outcome 'stopped 'shutdown))]
    [else
     (cancel-source-analysis! scheduler (Source-Snapshot-source snapshot) reason)
     (define attempt
       (Analysis-Attempt snapshot #f #f 'analysis #f (make-completion-event)
                         (+ (current-deadline-milliseconds)
                            (* 1000 (or (Analysis-Scheduler-wait scheduler) (get-analysis-wait))))
                         'waiting #f))
     (hash-set! (Analysis-Scheduler-attempts scheduler) (attempt-key attempt) attempt)
     (Analysis-Attempt-completion attempt)]))

;; End any wait of this source's analysis; the next pump queues the attempt.
(define (hasten-analysis! scheduler source)
  (define attempt
    (hash-ref (Analysis-Scheduler-attempts scheduler) (cons (source-id source) 'analysis) #f))
  (when (and attempt (waiting? attempt))
    (set-Analysis-Attempt-due! attempt 0)))

(define (waiting? attempt)
  (eq? 'waiting (Analysis-Attempt-state attempt)))

(define (schedule-resyntax! scheduler snapshot parent-completion)
  (when (and (not (Analysis-Scheduler-stopped? scheduler))
             (Analysis-Scheduler-resyntax scheduler))
    (define previous
      (hash-ref (Analysis-Scheduler-attempts scheduler) (cons (Source-Snapshot-id snapshot) 'resyntax) #f))
    (when previous (settle! scheduler previous (Analysis-Outcome 'stopped 'superseded)))
    (enqueue! scheduler snapshot 'resyntax parent-completion))
  (void))

(define (settle! scheduler attempt outcome)
  (unless (eq? 'terminal (Analysis-Attempt-state attempt))
    (when (Analysis-Attempt-worker attempt)
      (stop-supervised-worker! (Analysis-Attempt-worker attempt)))
    (set-Analysis-Attempt-state! attempt 'terminal)
    (when (registered? scheduler attempt)
      (hash-remove! (Analysis-Scheduler-attempts scheduler) (attempt-key attempt)))
    (resolve-completion! (Analysis-Attempt-completion attempt) outcome)))

(define (cancel-source-analysis! scheduler source [reason 'source-changed])
  (for ([kind (in-list '(analysis resyntax))])
    (define attempt
      (hash-ref (Analysis-Scheduler-attempts scheduler) (cons (source-id source) kind) #f))
    (when attempt (settle! scheduler attempt (Analysis-Outcome 'stopped reason))))
  (set-Analysis-Scheduler-queue!
    scheduler (filter (lambda (attempt) (registered? scheduler attempt))
                      (Analysis-Scheduler-queue scheduler))))

(define (stop-analysis-scheduler! scheduler)
  (set-Analysis-Scheduler-stopped?! scheduler #t)
  (for ([attempt (in-list (hash-values (Analysis-Scheduler-attempts scheduler)))])
    (settle! scheduler attempt (Analysis-Outcome 'stopped 'shutdown)))
  (set-Analysis-Scheduler-queue! scheduler '()))

;; current? checks source eligibility at dispatch, after any time spent queued.
;; It receives a snapshot and never receives the scheduler's private state.
;; make-context supplies the import context of each attempt whose wait is over.
(define (pump-analysis-scheduler! scheduler current? #:make-context [make-context (lambda () #f)])
  (unless (Analysis-Scheduler-stopped? scheduler)
    (queue-due-attempts! scheduler make-context)
    (let loop ()
      (define queue (Analysis-Scheduler-queue scheduler))
      (define running
        (for/sum ([attempt (in-hash-values (Analysis-Scheduler-attempts scheduler))]
                  #:when (eq? 'running (Analysis-Attempt-state attempt)))
          1))
      (when (and (pair? queue) (< running (Analysis-Scheduler-slots scheduler)))
        (define attempt (car queue))
        (set-Analysis-Scheduler-queue! scheduler (cdr queue))
        (if (and (registered? scheduler attempt)
                 (current? (Analysis-Attempt-snapshot attempt)))
            (start-attempt! scheduler attempt)
            (settle! scheduler attempt (Analysis-Outcome 'stopped 'source-changed)))
        (loop)))))

;; Oldest wait first, behind what is already queued.
(define (queue-due-attempts! scheduler make-context)
  (define now (current-deadline-milliseconds))
  (define due
    (sort (for/list ([attempt (in-hash-values (Analysis-Scheduler-attempts scheduler))]
                     #:when (and (waiting? attempt) (<= (Analysis-Attempt-due attempt) now)))
            attempt)
          < #:key Analysis-Attempt-due))
  (for ([attempt (in-list due)])
    (set-Analysis-Attempt-context! attempt (make-context))
    (set-Analysis-Attempt-state! attempt 'queued))
  (set-Analysis-Scheduler-queue! scheduler (append (Analysis-Scheduler-queue scheduler) due)))

;; Ready when the earliest wait ends. Only the owner changes the attempts and
;; syncs on this, and it syncs afresh after each change, so the guard always
;; sees the current attempts and no timer needs cancelling.
(define (analysis-wait-evt scheduler)
  (guard-evt
    (lambda ()
      (define waits
        (for/list ([attempt (in-hash-values (Analysis-Scheduler-attempts scheduler))]
                   #:when (waiting? attempt))
          (Analysis-Attempt-due attempt)))
      (if (null? waits)
          never-evt
          (wrap-evt (deadline-evt (apply min waits)) (lambda (_) (Analysis-Wait-Over)))))))

(define (start-attempt! scheduler attempt)
  (define snapshot (Analysis-Attempt-snapshot attempt))
  (set-Analysis-Attempt-state! attempt 'running)
  (define analysis? (eq? 'analysis (Analysis-Attempt-kind attempt)))
  (define worker
    (start-supervised-worker!
      (Analysis-Scheduler-events scheduler) (Analysis-Scheduler-timeout scheduler)
      (if analysis?
          (lambda ()
            (parameterize ([current-analysis-context (Analysis-Attempt-context attempt)]
                           [current-completion-position (Analysis-Attempt-completion-position attempt)])
              ((Analysis-Scheduler-analyze scheduler) snapshot)))
          (lambda () ((Analysis-Scheduler-resyntax scheduler)
                      (Source-Snapshot-text snapshot) (Source-Snapshot-uri snapshot))))
      #:fail (lambda (reason) (Analysis-Outcome 'failed reason))
      #:exited 'worker-exited
      #:timed-out 'analysis-timeout
      #:done (lambda (result) (Analysis-Completed attempt result))))
  (set-Analysis-Attempt-worker! attempt worker))

;; accept runs inline for the current running attempt only. It receives
;; snapshot, kind, completion, parent-completion, and worker result, and returns
;; an Analysis-Outcome after installing/discarding the result and translating
;; domain failures. Only then may the shared completion become ready.
(define (finish-analysis-task! scheduler message accept)
  (define attempt (Analysis-Completed-attempt message))
  (when (and (registered? scheduler attempt) (eq? 'running (Analysis-Attempt-state attempt)))
    (define outcome
      (accept (Analysis-Attempt-snapshot attempt) (Analysis-Attempt-kind attempt)
              (Analysis-Attempt-completion attempt) (Analysis-Attempt-parent-completion attempt)
              (Analysis-Completed-result message)))
    (settle! scheduler attempt outcome)))
