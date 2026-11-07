#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Macro steps answer tests.
(require racket/list
         racket/string
         rackunit
         (only-in "support/macro-stepper.rkt" steps-of sample text-of focused-text without-name-suffixes
                  structural-focus))

(module+ test
  (define (sample-program guard-body swap-body)
    `(module anonymous-module racket/base
       (#%module-begin
        (define-syntax-rule (guard test result) (unless test result))
        (define-syntax-rule (swap! a b) (let ([tmp a]) (set! a b) (set! b tmp)))
        (define (f n) ,guard-body n)
        (define (g) (define tmp 1) (define other 2) ,swap-body tmp))))

  (test-case "each rewrite of the program's own macros is a step, with its source"
    (define steps (hash-ref (steps-of sample) 'steps))
    (check-equal? (map (lambda (step) (hash-ref step 'macro)) steps) '("guard" "swap!"))
    (define guard (car steps))
    (check-equal? (hash-ref (hash-ref guard 'source) 'line) 5)
    (check-equal? (hash-ref (hash-ref guard 'source) 'column) 2))

  (for ([index '(0 1)] [macro '("guard" "swap!")]
        [before-focus '("(guard (number? n) 'no)" "(swap! tmp other)")]
        [after-focus '("(unless (number? n) 'no)" "(let ([tmp tmp]) (set! tmp other) (set! other tmp))")])
    (test-case (string-append macro " shows the whole program on both sides with the rewrite focused")
      (define step (list-ref (hash-ref (steps-of sample) 'steps) index))
      (define guard-call '(guard (number? n) 'no))
      (define guard-result '(unless (number? n) 'no))
      (define swap-call '(swap! tmp other))
      (define swap-result '(let ([tmp tmp]) (set! tmp other) (set! other tmp)))
      (check-equal? (read (open-input-string (without-name-suffixes (text-of step 'before))))
                    (sample-program (if (zero? index) guard-call guard-result) swap-call))
      (check-equal? (read (open-input-string (without-name-suffixes (text-of step 'after))))
                    (sample-program guard-result (if (zero? index) swap-call swap-result)))
      (check-equal? (structural-focus (hash-ref step 'before)) (list before-focus))
      (check-equal? (structural-focus (hash-ref step 'after)) (list after-focus))))

  (test-case "swap! preserves its square binding brackets and the name range inside them"
    (define swap (cadr (hash-ref (steps-of sample) 'steps)))
    (define after (hash-ref swap 'after))
    (define text (hash-ref after 'text))
    (define brackets (regexp-match-positions #px"\\[tmp tmp\\]" text))
    (check-not-false brackets)
    (define start (add1 (caar brackets)))
    (define name (findf (lambda (name) (equal? (take name 2) (list start (+ start 3)))) (hash-ref after 'names)))
    (check-not-false name)
    (check-equal? (caddr name) "tmp")
    (check-equal? (apply substring text (take name 2)) "tmp")
    (check-equal? (structural-focus after) '("(let ([tmp tmp]) (set! tmp other) (set! other tmp))")))

  (test-case "every section and the finished program retain list shapes and their ranges"
    (define result
      (steps-of
       (string-append "#lang racket/base\n"
                      "(define-syntax-rule (keep value) {list value '[] '{a . b} [quote q]})\n"
                      "[let ([x 1]) [list x (keep x)]]\n")))
    (define step (car (hash-ref result 'steps)))
    (check-regexp-match #rx"\\[let \\(\\[x 1\\]\\) \\[list x \\(keep x\\)\\]\\]" (text-of step 'before))
    (check-regexp-match #rx"\\[let \\(\\[x 1\\]\\)" (text-of step 'after))
    (check-equal? (structural-focus (hash-ref step 'after)) '("{list x '[] '{a . b} [quote q]}"))
    (for ([key '(before after)])
      (define part (hash-ref step key))
      (define text (hash-ref part 'text))
      (for ([name (in-list (hash-ref part 'names))])
        (check-equal? (apply substring text (take name 2)) (caddr name)))
      (for ([binder (in-list (hash-ref part 'binders))])
        (check-not-false (member (apply substring text binder) '("keep" "x"))))
      (for ([link (in-list (hash-ref part 'links))])
        (check-not-false (member (apply substring text (take link 2)) '("keep" "x")))
        (check-equal? (apply substring text (take link 2))
                      (apply substring text (drop link 2))))
      (check-not-equal? (hash-ref part 'binders) '())
      (check-not-equal? (hash-ref part 'links) '()))
    (check-regexp-match #rx"\\[\\]" (hash-ref result 'final))
    (check-regexp-match #rx"\\{a [.] b\\}" (hash-ref result 'final))
    ;; Delimiter edits use bytes, independently of the character ranges above.
    (define unicode
      (steps-of "#lang racket/base\n(define-syntax-rule (keep value) value)\n[keep (list '|λ\r\nx| '[] '{a . b})]\n"))
    (check-true (string-contains? (text-of (car (hash-ref unicode 'steps)) 'before)
                                  "[keep (list '|λ\r\nx| '[] '{a . b})]"))
    (define after (hash-ref (car (hash-ref unicode 'steps)) 'after))
    (check-true (string-contains? (hash-ref after 'text) "[list '|λ\r\nx| '[] '{a . b}]"))
    (define positions (regexp-replace* #rx"\r\n" (hash-ref after 'text) "\n"))
    (define name (findf (lambda (name) (equal? (caddr name) "b")) (hash-ref after 'names)))
    (check-not-false name)
    (check-equal? (apply substring positions (take name 2)) "b"))

  (test-case "steps have no where section or hole marker"
    (for ([step (in-list (hash-ref (steps-of sample) 'steps))])
      (check-false (hash-has-key? step 'where))
      (for ([key '(before after)])
        (define part (hash-ref step key))
        (check-false (hash-has-key? part 'here))
        (check-false (string-contains? (hash-ref part 'text) "«here»")))))

  (test-case "a user's former marker name remains ordinary program text"
    (define steps
      (hash-ref (steps-of "#lang racket/base\n(define «here» 1)\n(define-syntax-rule (m) 42)\n(list «here» (m))\n") 'steps))
    (for ([key '(before after)] [focus '("(m)" "42")])
      (define part (hash-ref (car steps) key))
      (check-equal? (length (regexp-match* #rx"«here»" (hash-ref part 'text))) 2)
      (check-equal? (focused-text part) (list focus))))

  (test-case "an expansion that stops is reported where it stops, with the steps before it"
    (define result (steps-of (string-append sample "(define (h) (guard))\n")))
    (define last-step (last (hash-ref result 'steps)))
    (check-regexp-match #rx"guard" (or (hash-ref last-step 'error #f) (hash-ref result 'error)))
    (check-false (hash-ref result 'final))
    (check-false (hash-has-key? last-step 'where)))
)
