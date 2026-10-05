#lang racket/base

(require racket/class racket/list racket/set data/interval-map
         drracket/check-syntax "interface.rkt" "../lexer.rkt"
         "../../common/interfaces.rkt")
(provide tail%)

;; Keep the public analysis callback's relative relationship. A branch can be
;; tail-positioned within an `if` whose result is an argument to another call.
;; That does not make the branch a tail call of its enclosing function.
(define tail%
  (class base-service%
    (init-field src lexer-state)
    (super-new)
    (define anchors (make-hash))
    (define ranges (make-interval-map))
    (define parents (make-hash))
    (define children (make-hash))

    (define/override (reset)
      (hash-clear! anchors)
      (hash-clear! parents)
      (hash-clear! children)
      (set! ranges (make-interval-map)))

    ;; Any edit can change tail context outside the edited span. Suppress the
    ;; old facts until expansion supplies a fresh trace; never shift guesses.
    (define/override (text-replaced _start _end) (send this reset))

    (define/private (anchor-end pos)
      (hash-ref!
       anchors pos
       (lambda ()
         (define token (lexer-state-token-at lexer-state pos))
         (and token (= pos (LexerEntry-start token))
              (let ([end (LexerEntry-end token)])
                ;; Include the operator after an opening delimiter, but no
                ;; arguments or nested forms. Comments stop the extension.
                (if (member (LexerEntry-text token) '("(" "[" "{"))
                    (let loop ([next end])
                      (define head (lexer-state-token-at lexer-state next))
                      (cond
                        [(not head) end]
                        [(eq? (LexerEntry-type head) 'white-space)
                         (loop (LexerEntry-end head))]
                        [(eq? (LexerEntry-type head) 'symbol) (LexerEntry-end head)]
                        [else end]))
                    end))))))

    (define/override (syncheck:add-tail-arrow from-source from to-source to)
      (when (and (equal? from-source src) (equal? to-source src)
                 (exact-nonnegative-integer? from) (exact-nonnegative-integer? to)
                 (not (= from to)))
        (define from-end (anchor-end from))
        (define to-end (anchor-end to))
        (when (and from-end to-end)
          (interval-map-set! ranges from from-end from)
          (interval-map-set! ranges to to-end to)
          (set-add! (hash-ref! parents to mutable-set) from)
          (set-add! (hash-ref! children from mutable-set) to))))

    ;; Bounds and source positions belong to the same accepted snapshot.
    (define/public (at pos)
      (define key (interval-map-ref ranges pos #f))
      (if key
          (values key (hash-ref anchors key)
                  (sort (set->list (hash-ref parents key (set))) <)
                  (sort (set->list (hash-ref children key (set))) <))
          (values #f #f '() '())))))
