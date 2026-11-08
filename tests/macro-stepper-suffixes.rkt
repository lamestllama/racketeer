;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
#lang racket/base

;; Verify session redraws share their partition, including the palette boundary.
(require rackunit racket/class racket/list racket/string
         macro-debugger/model/steps
         "../racketdap/tools/macro-steps/answer.rkt"
         "../racketdap/tools/macro-steps/printing.rkt")

(module+ test
  (test-case "position suffix toggles retain numbering assigned by earlier navigation"
    (define partition (new-foreground-partition))
    (define seeds
      (for/list ([i (in-range 18)])
        ((make-syntax-introducer) (read-syntax 'program (open-input-string "'seed")))))
    (define (state-of term) (state term (list term) null null (hasheq) (hasheq) (hasheq) 0))
    (define query #f)
    (expansion-answer
     (for/list ([seed seeds])
       (step 'macro (state-of (datum->syntax #f '(quoted))) (state-of seed)))
     (hasheq) (hasheq) (last seeds) #f (car seeds) 'null null
     #:partition partition #:retain-inspector (lambda (value) (set! query value)))
    (define (at n [option "over-limit"])
      (query (hasheq 'mode "position" 'position n 'suffixOption option)))
    (define (after reply) (hash-ref (hash-ref reply 'record) 'after))
    (define (text reply) (string-trim (hash-ref (after reply) 'text)))
    ;; Visit the end first: the final seed gets 1, even though it is last.
    (define end (at 19))
    (check-equal? (send partition get-partition (last seeds)) 1)
    (for ([n (in-range 1 18)]) (at n))
    (for ([n '(15 16 17)] [group '(16 17 18)])
      (define default (at n))
      (define always (at n "always"))
      (check-equal? (text default) (if (= group 18) "'seed:18" "'seed"))
      (check-equal? (text always) (format "'seed:~a" group))
      (check-equal? (map (lambda (o) (hash-ref o 'macroScopeGroup)) (hash-ref (after default) 'occurrences))
                    (map (lambda (o) (hash-ref o 'macroScopeGroup)) (hash-ref (after always) 'occurrences)))
      (check-equal? (hash-ref default 'nextGroup) (hash-ref always 'nextGroup))
      (check-equal? (at n) default))
    (define shown (hash-ref (at 19 "always") 'final))
    (check-equal? (hash-ref shown 'id) (hash-ref (hash-ref end 'final) 'id))
    (check-equal? (hash-ref shown 'text) "'seed:1\n")
    (check-equal? (hash-ref (at 19) 'final) (hash-ref end 'final)))

  (test-case "suffix mode is validated at the session boundary"
    (define query #f)
    (expansion-answer null (hasheq) (hasheq) #'x #f #'x 'null null
                      #:retain-inspector (lambda (value) (set! query value)))
    (check-exn exn:fail? (lambda () (query (hasheq 'mode "position" 'position 1 'suffixOption "never"))))))
