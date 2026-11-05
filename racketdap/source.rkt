#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/file racket/path racket/string racket/list "instrumentation/instrument.rkt")
(provide (struct-out source-file) capture-source source-current? source-location source-position choose-sites same-file? make-within?)
(struct source-file (path text id starts) #:transparent)
;; A path can name a file through a symbolic link or in another case, so two spellings
;; name one file when the file system says so. Identity is read each time, because saving
;; can replace a file with a new one. A path that cannot be read matches only itself.
(define (file-identity path)
  (with-handlers ([exn:fail? (lambda (_) path)])
    (file-or-directory-identity path)))
(define (same-file? a b)
  (or (equal? a b) (equal? (file-identity a) (file-identity b))))
;; A predicate for whether a complete path is one of these files or folders or lies under
;; one, however either is spelled. It walks up the path's own folders, so a link inside a
;; folder that leads out of it still counts by the name it was reached through. Answers
;; are kept, since every module loaded asks, often more than once.
(define (make-within? roots)
  (define identities (map file-identity roots))
  (define answers (make-hash))
  (define (within? path)
    (hash-ref! answers path
               (lambda ()
                 (or (and (member (file-identity path) identities) #t)
                     (let-values ([(parent _name _directory?) (split-path path)])
                       (and (path? parent) (within? parent)))))))
  within?)
;; Racket counted positions treat CRLF as one character.
(define (counted-text text) (regexp-replace* #rx"\r\n" text "\n"))
(define (capture-source path id #:text [loaded-text #f])
  (define text (counted-text (or loaded-text (file->string path))))
  (source-file path text id
               (list->vector
                (cons 0 (for/list ([c (in-string text)] [i (in-naturals)] #:when (char=? c #\newline))
                          (add1 i))))))
;; Whether the file still holds the captured text. A WXME document's text is never its file's.
;; Every source reported asks, so the file is read again only when its date or size changes.
(define current-answers (make-weak-hasheq))
(define (source-current? source)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (define stat (file-or-directory-stat (source-file-path source)))
    (define key (cons (hash-ref stat 'modify-time-nanoseconds) (hash-ref stat 'size)))
    (define known (hash-ref current-answers source #f))
    (cond
      [(and known (equal? (car known) key)) (cdr known)]
      [else
       (define answer (equal? (source-file-text source) (counted-text (file->string (source-file-path source)))))
       (hash-set! current-answers source (cons key answer))
       answer])))
(define (source-location source position [one-based? #t])
  (define offset (min (string-length (source-file-text source)) (max 0 (sub1 (or position 1)))))
  (define starts (source-file-starts source))
  (define line
    (let loop ([low 0] [high (vector-length starts)])
      (if (= (add1 low) high) low
          (let ([mid (quotient (+ low high) 2)])
            (if (<= (vector-ref starts mid) offset) (loop mid high) (loop low mid))))))
  (define column
    (for/sum ([i (in-range (vector-ref starts line) offset)])
      (if (> (char->integer (string-ref (source-file-text source) i)) #xffff) 2 1)))
  (values (+ line (if one-based? 1 0)) (+ column (if one-based? 1 0))))
;; The position at a one-based line and column, counted as source-location counts them.
(define (source-position source line column)
  (define starts (source-file-starts source))
  (define text (source-file-text source))
  (and (<= 1 line (vector-length starts))
       (let loop ([i (vector-ref starts (sub1 line))] [at 1])
         (cond [(= at column) (add1 i)]
               [(or (> at column) (>= i (string-length text))) #f]
               [else (loop (add1 i) (+ at (if (> (char->integer (string-ref text i)) #xffff) 2 1)))]))))
(define (choose-sites sites source line column #:phase [phase 'before] #:exact? [exact? #f])
  ;; A line with no stop takes the next line that has one. A column names one place.
  (define target
    (for/fold ([next (if column line +inf.0)])
              ([site (in-list sites)]
               #:when (and (not column) (memq phase (site-phases site)) (site-boundary-position site phase)))
      (let-values ([(l c) (source-location source (site-boundary-position site phase))])
        (if (>= l line) (min l next) next))))
  (define candidates
    (filter
     (lambda (site)
       (and (memq phase (site-phases site))
            (site-boundary-position site phase)
            (let-values ([(l c) (source-location source (site-boundary-position site phase))])
              (and (= l target) (or (not column) (if exact? (= c column) (>= c column))))))) sites))
  (if (null? candidates) '()
      (let* ([ordered (sort candidates
                            (lambda (a b)
                              (or (< (site-boundary-position a phase) (site-boundary-position b phase))
                                  (and (= (site-boundary-position a phase) (site-boundary-position b phase))
                                       (> (site-span a) (site-span b))))))]
             [first (car ordered)])
        ;; All expanded occurrences at the chosen range are breakpoint targets.
        (filter (lambda (s) (and (= (site-position s) (site-position first))
                                (= (site-span s) (site-span first)))) ordered))))
