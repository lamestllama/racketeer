#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/list racket/path "../source.rkt")
(provide error-locations interaction-source)

(define interaction-source 'racketeer-interaction)
(define (syntax-location value)
  (srcloc (syntax-source value) (syntax-line value) (syntax-column value)
          (syntax-position value) (syntax-span value)))

;; Use only built-in exception metadata. A custom srcloc property can execute
;; arbitrary code and must not be invoked while reporting another failure.
(define (error-locations value loaded frames [expression #f])
  (define explicit
    (cond [(exn:fail:read? value) (exn:fail:read-srclocs value)]
          [(exn:fail:syntax? value) (map syntax-location (exn:fail:syntax-exprs value))]
          [else '()]))
  (define context
    (if (exn? value)
        (filter values (map cdr (continuation-mark-set->context (exn-continuation-marks value)))) '()))
  (define input (and expression (capture-source (string->path "Interaction.rkt") 0 #:text expression)))
  (define snapshots '())
  (define locations '())
  (define seen (make-hash))
  (define snapshot-ids (make-hasheq))
  (define bytes 0)
  (define omitted? #f)
  (define (lookup name)
    (cond [(eq? name interaction-source) input]
          [(or (path? name) (string? name))
           (hash-ref loaded (simplify-path (path->complete-path name)) #f)]
          [else #f]))
  (define (add! raw approximate? [submitted? #f])
    (when (srcloc? raw)
      (define source (lookup (srcloc-source raw)))
      (when source
        (define text (source-file-text source))
        (define position
          (or (srcloc-position raw)
              (and (exact-positive-integer? (srcloc-line raw))
                   (exact-nonnegative-integer? (srcloc-column raw))
                   (<= (srcloc-line raw) (vector-length (source-file-starts source)))
                   (+ 1 (vector-ref (source-file-starts source) (sub1 (srcloc-line raw)))
                      (srcloc-column raw)))))
        (define span (or (srcloc-span raw) 0))
        (define key (list (source-file-path source) position span))
        (when (and (exact-positive-integer? position) (<= position (add1 (string-length text)))
                   (exact-nonnegative-integer? span) (not (hash-ref seen key #f)))
          (hash-set! seen key #t)
          (define size (bytes-length (string->bytes/utf-8 text)))
          (cond
            [(or (>= (length locations) 8)
                 (> (+ bytes (if (hash-has-key? snapshot-ids source) 0 size)) (* 1024 1024)))
             (set! omitted? #t)]
            [else
             (define id
               (hash-ref! snapshot-ids source
                          (lambda ()
                            (define id (length snapshots))
                            (set! bytes (+ bytes size))
                            (set! snapshots
                                  (append snapshots
                                          (list (hasheq 'name (if (eq? source input) "Interaction" (path->string (file-name-from-path (source-file-path source))))
                                                        'path (and (not (eq? source input)) (path->string (source-file-path source)))
                                                        'content text))))
                            id)))
             (define-values (line column) (source-location source position))
             (define-values (end-line end-column) (source-location source (+ position span)))
             (set! locations (append locations (list (hasheq 'source id 'line line 'column column
                                                            'endLine end-line 'endColumn end-column
                                                            'approximate approximate? 'submitted submitted?))))])))))
  (for ([raw (in-list explicit)]) (add! raw #f))
  (for ([raw (in-list frames)]) (add! (syntax-location raw) #f))
  ;; An entered expression remains a useful navigation target even when the
  ;; evaluator has no exact location within it. Do not label it as a failing site.
  (when input (add! (srcloc interaction-source 1 0 1 (string-length expression)) #f #t))
  (for ([raw (in-list context)]) (add! raw #t))
  (hasheq 'sources snapshots 'locations locations 'omitted omitted?))
