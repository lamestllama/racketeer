#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/file racket/path racket/string racket/list "instrumentation/instrument.rkt")
(provide (struct-out source-file) capture-source source-location choose-sites same-file? make-within?)
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
(define (capture-source path id #:text [loaded-text #f])
  ;; Racket counted positions treat CRLF as one character.
  (define text (regexp-replace* #rx"\r\n" (or loaded-text (file->string path)) "\n"))
  (source-file path text id
               (list->vector
                (cons 0 (for/list ([c (in-string text)] [i (in-naturals)] #:when (char=? c #\newline))
                          (add1 i))))))
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
(define (choose-sites sites source line column #:phase [phase 'before] #:exact? [exact? #f])
  (define candidates
    (filter
     (lambda (site)
       (and (memq phase (site-phases site))
            (site-boundary-position site phase)
            (let-values ([(l c) (source-location source (site-boundary-position site phase))])
              (and (= l line) (or (not column) (if exact? (= c column) (>= c column))))))) sites))
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
