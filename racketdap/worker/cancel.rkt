#lang racket/base
(provide make-evaluations queue-evaluation! forget-evaluation! call-with-evaluation cancel-evaluations!
         exn:fail:cancelled?)

(struct exn:fail:cancelled exn:fail ())
(struct evaluation (thread cancelled? order) #:mutable)
(struct evaluations (jobs lock counter) #:mutable)
(define (make-evaluations) (evaluations (make-hasheqv) (make-semaphore 1) 0))
(define (locked registry thunk) (call-with-semaphore (evaluations-lock registry) thunk))
(define (queue-evaluation! registry id)
  (locked registry (lambda () (hash-set! (evaluations-jobs registry) id (evaluation #f #f 0)))))
(define (forget-evaluation! registry id)
  (locked registry (lambda () (hash-remove! (evaluations-jobs registry) id))))
(define (cancelled) (raise (exn:fail:cancelled "cancelled" (current-continuation-marks))))
(define (call-with-evaluation registry id thunk)
  ;; A break must never land in the surrounding pause loop or a later request.
  (parameterize-break #f
    (define job (locked registry (lambda () (hash-ref (evaluations-jobs registry) id))))
    (with-handlers ([exn:break? (lambda (e) (if (evaluation-cancelled? job) (cancelled) (raise e)))])
      (dynamic-wind
        (lambda ()
          (locked registry
                  (lambda ()
                    (set-evaluations-counter! registry (add1 (evaluations-counter registry)))
                    (set-evaluation-order! job (evaluations-counter registry))
                    (set-evaluation-thread! job (current-thread)))))
        (lambda ()
          (when (evaluation-cancelled? job) (cancelled))
          (begin0 (parameterize-break #t (thunk))
            (when (evaluation-cancelled? job) (cancelled))))
        (lambda ()
          (locked registry
                  (lambda ()
                    (set-evaluation-thread! job #f)
                    (hash-remove! (evaluations-jobs registry) id)))
          ;; Drain a break that raced with completion while this handler still
          ;; owns it. Cancellation is cooperative; user code can disable breaks.
          (parameterize-break #t (void)))))))
(define (cancel-evaluations! registry [id #f])
  (locked
   registry
   (lambda ()
     ;; An interactive call can be paused while a nested console evaluation
     ;; runs on the same thread. A UI cancel targets that innermost evaluation.
     (define active (make-hasheq))
     (for ([job (in-hash-values (evaluations-jobs registry))] #:when (evaluation-thread job))
       (define old (hash-ref active (evaluation-thread job) #f))
       (when (or (not old) (> (evaluation-order job) (evaluation-order old)))
         (hash-set! active (evaluation-thread job) job)))
     (for/sum ([(key job) (in-hash (evaluations-jobs registry))]
               #:when (if id (= key id)
                          (or (not (evaluation-thread job))
                              (eq? job (hash-ref active (evaluation-thread job))))))
       (set-evaluation-cancelled?! job #t)
       (when (and (evaluation-thread job) (eq? job (hash-ref active (evaluation-thread job))))
         (break-thread (evaluation-thread job)))
       1))))
