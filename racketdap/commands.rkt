#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list)
(provide worker-command? command-flag? command-allowed-at? stop-actions)

;; One policy table for the supervisor, worker, and advertised editor actions.
;; Handlers own the operation; this table owns routing and execution requirements.
;; before/after/exception restrict stop kinds; no kind flag means any live stop.
(define rules
  '#hasheq((setBreakpoints . ()) (setExceptionBreakpoints . ())
           (configurationDone . ()) (threads . ()) (source . ())
           (loadedSources . ()) (breakpointLocations . ())
           (pause . ()) (cancel . ()) (racketdap/cancelEvaluation . ())
           (racketdap/input . ()) (racketdap/interrupt . ()) (racketdap/logFilter . ())
           (stackTrace . (paused)) (scopes . (paused)) (variables . (paused))
           (exceptionInfo . (paused exception))
           (evaluate . (paused evaluate interactive))
           (racketdap/renderImage . (paused evaluate))
           (racketdap/openPlot . (paused evaluate))
           (setVariable . (paused evaluate))
           (continue . (paused resume all-threads))
           (next . (paused resume all-threads step))
           (stepIn . (paused resume all-threads step))
           (stepOut . (paused resume all-threads step))
           (internalContinue . (paused resume internal))
           (racketdap/continueToLocation . (paused resume action))
           (racketdap/skipExpression . (paused evaluate before executing action))
           (racketdap/replaceResults . (paused evaluate after executing action))
           (racketdap/printResults . (paused evaluate after action))
           (racketdap/printBinding . (paused evaluate action))
           (racketdap/setBinding . (paused evaluate action))))
(define (flags name) (hash-ref rules (if (symbol? name) name (string->symbol name)) '()))
(define (command-flag? name flag) (and (memq flag (flags name)) #t))
(define (worker-command? name)
  (and (hash-has-key? rules (if (symbol? name) name (string->symbol name)))
       (not (command-flag? name 'internal))))
(define (command-allowed-at? name kind)
  (define required (findf (lambda (flag) (memq flag '(before after exception))) (flags name)))
  (or (not required) (eq? kind required)))
(define (stop-actions kind)
  (sort (for/list ([name (in-hash-keys rules)]
                  #:when (and (command-flag? name 'action) (command-allowed-at? name kind)))
          (symbol->string name)) string<?))
