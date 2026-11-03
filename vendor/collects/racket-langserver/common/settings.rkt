#lang racket/base

(require racket/contract
         "interfaces.rkt")

(provide get-resyntax-enabled
         set-resyntax-enabled!
         default-resyntax-enabled
         get-analysis-wait
         set-analysis-wait-milliseconds!
         default-analysis-wait-milliseconds
         (struct-out Formatting-Settings)
         default-formatting-settings
         current-formatting-settings
         set-formatting-settings!)

(define default-resyntax-enabled #t)

(define resyntax-enabled? default-resyntax-enabled)

(define (get-resyntax-enabled)
  resyntax-enabled?)

(define (set-resyntax-enabled! val)
  (set! resyntax-enabled? val))

;; The pause after an edit before analysing it. Process-wide, like
;; `resyntax-enabled?`. Anything but an integer in range is the default, as an
;; omitted setting is, so a bad value can neither stop the server nor stop analysis.
(define default-analysis-wait-milliseconds 250)
(define maximum-analysis-wait-milliseconds 10000)

(define analysis-wait-milliseconds default-analysis-wait-milliseconds)

(define (set-analysis-wait-milliseconds! value)
  (set! analysis-wait-milliseconds
        (if (and (exact-integer? value) (<= 0 value maximum-analysis-wait-milliseconds))
            value
            default-analysis-wait-milliseconds)))

;; In seconds, as the scheduler keeps its times.
(define (get-analysis-wait)
  (/ analysis-wait-milliseconds 1000))

;; Document formatting may reflow a complete buffer, while indentation
;; formatting must remain safe for ranges and on-type requests. Keep the two
;; selections distinct instead of silently substituting one for the other.
(struct/contract Formatting-Settings
  ([document-formatter (or/c 'fixw 'drracket 'fmt)]
   [indentation-formatter (or/c 'fixw 'drracket)]
   [fmt-settings Fmt-Settings?])
  #:transparent)

(define default-formatting-settings
  (Formatting-Settings 'fixw 'fixw (jsexpr->Fmt-Settings (hasheq))))

;; Process-wide, like `resyntax-enabled?`.
(define current-formatting-settings default-formatting-settings)

(define/contract (set-formatting-settings! settings)
  (-> Formatting-Settings? void?)
  (set! current-formatting-settings settings))
