#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require "support/events.rkt" rackunit racket/runtime-path racket/list racket/file
         compiler/compile-file
         "../racketdap/worker/load.rkt"
         "../racketdap/instrumentation/instrument.rkt")
(define-runtime-path fixtures "fixtures")
(define (fixture name) (build-path fixtures name))
(define (run-values name instrument? #:submodule [submodule '()] #:sources [sources '()]
                    #:entry [entry 'run] #:on-event [on-event #f] #:on-sites [on-sites void])
  (define out (open-output-string))
  (define err (open-output-string))
  (define result
    (parameterize ([current-output-port out] [current-error-port err])
      (call-with-values
       (lambda ()
         (run-module (fixture name) #:instrument? instrument? #:entry entry
                     #:submodule submodule #:sources sources
                     #:on-event on-event #:on-sites on-sites)) list)))
  (list result (get-output-string out) (get-output-string err)))

(module+ test
  (test-case "a real expression stop exposes and mutates live lexical bindings"
    (define stops 0)
    (define expired #f)
    (define result
      (call-with-values
       (lambda ()
         (run-module
          (fixture "locals.rkt") #:entry 'run
          #:on-event
          (before-events
           (lambda (where) (equal? (site-expression where) '(#%app * subtotal rate)))
           (lambda (stop)
             (set! stops (add1 stops))
             (set! expired stop)
             (check-equal? (cdr (assq 'subtotal (stop-locals stop))) 100)
             (check-equal? (stop-evaluate stop '(+ subtotal 20)) 120)
             (check-equal? (stop-evaluate stop '(add-private subtotal)) 107)
             (stop-evaluate stop '(set! subtotal 200))))))
       list))
    (check-equal? stops 1)
    (check-equal? result '(220 20))
    (check-exn #rx"expired" (lambda () (stop-locals expired))))

  (test-case "hygienic macro locals do not hide the programmer's bindings"
    (define stops 0)
    (define captured #f)
    (define outcome
      (run-values
       "shadowing.rkt" #t
       #:on-event
       (before-events
        (lambda (where) (equal? (site-expression where) '(#%app + x private-value)))
        (lambda (stop)
          (set! stops (add1 stops))
          (check-equal? (stop-evaluate stop 'x) 20)
          (check-equal? (stop-evaluate stop '(f x)) 21)
          (check-equal? (stop-evaluate stop '(let ([x 99]) (f x))) 100)
          (check-equal? (stop-evaluate stop 'private-value) 1000)
          (check-equal? (stop-evaluate stop '(add-private x)) 27)
          (check-equal? (call-with-values (lambda () (stop-evaluate stop '(values x (f x)))) list)
                        '(20 21))
          (check-equal? (call-with-values (lambda () (stop-evaluate stop '(values))) list) '())
          (check-true (void? (stop-evaluate stop '(void))))
          (set! captured (stop-evaluate stop '(lambda () x)))
          (stop-evaluate stop '(set! x 30))
          (stop-evaluate stop '(set! mutable-value 50))
          (check-equal? (captured) 30)))))
    (check-equal? stops 1)
    (check-equal? (car outcome) '((1030 11 10 50 11)))
    (check-equal? (captured) 30))

  (test-case "callee evaluation does not see an unrelated caller's locals"
    (define stops 0)
    (run-values
     "shadowing.rkt" #t
     #:on-event
     (before-events
      (lambda (where) (equal? (site-expression where) '(#%app + value '1)))
      (lambda (stop)
        (set! stops (add1 stops))
        (check-equal? (stop-evaluate stop 'value) 10)
        (check-false (assq 'x (stop-locals stop)))
        (check-exn exn:fail? (lambda () (stop-evaluate stop 'x)))
        (check-equal? (stop-evaluate stop '(begin (set! private-value 100) private-value)) 100)
        (stop-evaluate stop '(set! private-value 7))
        (check-exn exn:fail? (lambda () (stop-evaluate stop '(set! add1 100))))
        (check-equal? (stop-evaluate stop 'private-value) 7)
        (check-true (> (stop-frame-count stop) 1))
        (check-equal? (stop-evaluate stop 'x 1) 10))))
    (check-equal? stops 1))

  (for ([name '("semantics.rkt" "reentry.rkt" "cross-thread.rkt"
               "expansion-effects.rkt" "racket-language.rkt")])
    (test-case (format "normal and instrumented execution agree: ~a" name)
      (define stops 0)
      (define normal (run-values name #f))
      (define debug
        (run-values name #t #:on-event
                            (before-events
                             (lambda (_) #t)
                             (lambda (stop) (set! stops (add1 stops))))))
      (check-equal? debug normal)
      (check-true (> stops 0))))

  (test-case "tail recursion keeps bounded debugger frame depth"
    (define depth 0)
    (define stops 0)
    (define debug
      (run-values "tail.rkt" #t #:on-event
                                (before-events
                                 (lambda (_) #t)
                                 (lambda (stop)
                                   (set! stops (add1 stops))
                                   (set! depth (max depth (stop-frame-count stop)))))))
    (check-equal? debug (run-values "tail.rkt" #f))
    (check-true (> stops 20000))
    (check-true (<= depth 2)))

  (test-case "for and match retain source-visible locals"
    (define found '())
    (run-values
     "semantics.rkt" #t
     #:on-event
     (before-events
      (lambda (where) (equal? (site-expression where) '(#%app + y '10)))
      (lambda (stop)
        (set! found (cons (stop-evaluate stop '(list x y)) found)))))
    (check-equal? (reverse found) '((0 0) (1 1) (2 2) (3 3))))

  (test-case "recursive activations expose distinct lexical cells"
    (define found #f)
    (run-values
     "semantics.rkt" #t
     #:on-event
     (before-events
      (lambda (where) (equal? (site-expression where) '(#%app zero? n)))
      (lambda (stop)
        (when (zero? (stop-evaluate stop 'n))
          (set! found
                (for/list ([frame (in-range 9)])
                  (stop-evaluate stop 'n frame)))))))
    (check-equal? found '(0 1 2 3 4 5 6 7 8)))

  (test-case "duplicated macro occurrences have distinct sites and both stop"
    (define occurrences '())
    (define debug
      (run-values
       "duplicated.rkt" #t
       #:on-event
       (before-events
        (lambda (where) (equal? (site-expression where) '(#%app add1 x)))
        (lambda (stop) (set! occurrences (cons (stop-site stop) occurrences))))))
    (check-equal? debug (run-values "duplicated.rkt" #f))
    (check-equal? (length occurrences) 2)
    (check-equal? (length (remove-duplicates (map site-id occurrences))) 2)
    (check-equal? (length (remove-duplicates (map site-position occurrences))) 1))

  (test-case "selected modules expand and instantiate once per normal phase instance"
    (define sites '())
    (define normal (run-values "modules.rkt" #f #:sources (list (fixture "support.rkt"))))
    (define debug
      (run-values "modules.rkt" #t #:sources (list (fixture "support.rkt"))
                  #:on-sites (lambda (more) (set! sites (append more sites)))))
    (check-equal? debug normal)
    (check-equal? (length sites) (length (remove-duplicates (map site-id sites))))
    (check-not-false (member (fixture "support.rkt") (map site-source sites)))
    (check-equal? (car debug) '(42)))

  (for ([submodule '((main) (test) (nested))])
    (test-case (format "submodule loading preserves behavior: ~a" submodule)
      (define entry (and (equal? submodule '(nested)) 'run))
      (define stops 0)
      (check-equal?
       (run-values "modules.rkt" #t #:submodule submodule #:entry entry
                   #:on-event
                   (before-events
                    (lambda (_) #t)
                    (lambda (_) (set! stops (add1 stops)))))
       (run-values "modules.rkt" #f #:submodule submodule #:entry entry))
      (check-true (> stops 0))))

  (test-case "submodule frames evaluate in their own module namespace"
    (define stops 0)
    (run-values "modules.rkt" #t #:submodule '(nested)
                #:on-event
                (before-events
                 (lambda (_) #t)
                 (lambda (stop)
                   (set! stops (add1 stops))
                   (check-equal? (stop-evaluate stop 'private-value) 99))))
    (check-equal? stops 1))

  (test-case "phase-shifted instances run normally without runtime debugger stops"
    (define stops 0)
    (run-values
     "modules.rkt" #t #:sources (list (fixture "support.rkt"))
     #:on-event
     (before-events
      (lambda (where) (equal? (site-expression where) '(#%app displayln 'load-support)))
      (lambda (stop)
        (set! stops (add1 stops))
        (check-equal? (stop-evaluate stop '(namespace-base-phase (current-namespace))) 0))))
    (check-equal? stops 1))

  (test-case "paused evaluation preserves parameters and suppresses recursive stops"
    (define stops 0)
    (define target-thread (current-thread))
    (run-values
     "dynamic.rkt" #t
     #:on-event
     (before-events
      (lambda (where) (equal? (site-expression where) '(#%app helper)))
      (lambda (stop)
        (set! stops (add1 stops))
        (check-eq? (stop-evaluate stop '(current-thread)) target-thread)
        (check-equal? (stop-evaluate stop '(current-label)) 'paused)
        (check-equal? (stop-evaluate stop '(helper)) 3)
        (define escaped (stop-evaluate stop '(call/cc values)))
        (check-exn exn:fail:contract:continuation? (lambda () (escaped 'escape)))
        (check-exn exn:fail? (lambda () (stop-evaluate stop '(error 'probe "failed"))))
        (check-equal? (stop-evaluate stop '(helper)) 3)
        (check-exn #rx"frame index" (lambda () (stop-evaluate stop 'x 100)))
        (define result (make-channel))
        (define inspector
          (thread
           (lambda ()
             (with-handlers ([exn:fail? (lambda (e) (channel-put result (exn-message e)))])
               (channel-put result (stop-locals stop))))))
        (check-regexp-match #rx"stopped program thread|different thread" (channel-get result))
        (thread-wait inspector))))
    (check-equal? stops 1))

  (test-case "uninitialized lexical cells have an explicit inspection state"
    (define stops 0)
    (run-values
     "uninitialized.rkt" #t
     #:on-event
     (before-events
      (lambda (where) (equal? (site-expression where) '(#%app + '1 '2)))
      (lambda (stop)
        (set! stops (add1 stops))
        (check-true (unavailable? (cdr (assq 'x (stop-locals stop)))))
        (check-exn exn:fail:contract:variable? (lambda () (stop-evaluate stop 'x))))))
    (check-equal? stops 1))

  (test-case "program resources are closed at return and callback failure"
    (define background (caar (run-values "resources.rkt" #t)))
    (check-true (thread-dead? (car background)))
    (define stopped #f)
    (define target-thread #f)
    (check-exn
     #rx"callback failed"
     (lambda ()
       (run-values
        "resources.rkt" #t
        #:on-event
        (before-events
         (lambda (where) (equal? (site-expression where) '(#%app list background)))
         (lambda (stop)
           (set! stopped stop)
           (set! target-thread (stop-evaluate stop 'background))
           (error 'probe "callback failed"))))))
    (check-true (thread-dead? target-thread))
    (check-exn #rx"expired" (lambda () (stop-evaluate stopped 'background))))

  (test-case "selected source bypasses existing bytecode without changing it"
    (define directory (make-temporary-file "racketdap-cache-~a" 'directory))
    (dynamic-wind
      void
      (lambda ()
        (define source (build-path directory "cached.rkt"))
        (define cache-directory (build-path directory "compiled"))
        (define cache (build-path cache-directory "cached_rkt.zo"))
        (copy-file (fixture "locals.rkt") source)
        (make-directory cache-directory)
        (parameterize ([read-accept-reader #t]
                       [read-accept-lang #t]
                       [current-namespace (make-base-namespace)])
          (compile-file source cache))
        (define original (file->bytes cache))
        (define modified (file-or-directory-modify-seconds cache))
        (define stops 0)
        (check-equal?
         (call-with-values
          (lambda ()
            (run-module source #:entry 'run #:on-event
                                            (before-events
                                             (lambda (_) #t)
                                             (lambda (_) (set! stops (add1 stops)))))) list)
         '(110 10))
        (check-true (> stops 0))
        (check-equal? (file->bytes cache) original)
        (check-equal? (file-or-directory-modify-seconds cache) modified)
        (check-equal? (map path->string (directory-list cache-directory)) '("cached_rkt.zo")))
      (lambda () (delete-directory/files directory)))))
