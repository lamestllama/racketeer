#lang racket/base

(provide lsp-editor%)

(require racket/class
         racket/file
         "textbuffer-rope.rkt")

(define lsp-editor%
  (class object%
    (init [initial-buffer (rope-from-string "")])

    (define rope initial-buffer)
    (define unicode-lines (make-hash))

    (define/private (replace-range str start-pos end-pos)
      (set! rope (rope-replace rope start-pos end-pos str))
      (hash-clear! unicode-lines))

    (define/private (line-count)
      (add1 (rope-offset->line rope (rope-chars rope))))

    (define/private (line-start-pos/raw line)
      (cond
        [(zero? line) 0]
        [(< line (line-count))
         (add1 (rope-line-end-offset rope (sub1 line)))]
        [else
         (error 'line/char->pos "line out of range: ~a" line)]))

    ;; insert str at start
    (define/public (insert str start)
      (replace-range str start start))

    ;; replace text at (range start end) with str
    (define/public (replace str start end)
      (replace-range str start end))

    (define/public (replace-in-line str line ch-st ch-ed)
      (send this replace str
            (send this line/char->pos line ch-st)
            (send this line/char->pos line ch-ed)))

    (define/public (delete start end)
      (replace-range "" start end))

    ;; remove all content
    (define/public (erase)
      (set! rope (rope-from-string ""))
      (hash-clear! unicode-lines))

    (define/public (load-file path)
      (set! rope (rope-from-string (file->string path)))
      (hash-clear! unicode-lines))

    ;; return current content in editor as string
    (define/public (get-text [start 0] [end 'eof])
      (rope-get-text rope start (if (eq? end 'eof) (send this end-pos) end)))

    ;; return the number of characters in editor
    ;; also the end of file position
    (define/public (end-pos)
      (rope-chars rope))

    (define/public (line/char->pos line char)
      (+ char (line-start-pos/raw line)))

    (define/public (pos->line/char pos)
      (define line (rope-offset->line rope pos))
      (list line (- pos (send this line-start-pos line))))

    ;; Cache only astral-character offsets. ASCII/BMP lines need no per-position
    ;; storage, and repeated protocol queries do not rescan long source lines.
    (define/private (astral-offsets line)
      (hash-ref! unicode-lines line
                 (lambda ()
                   (list->vector
                    (for/list ([character (in-string (send this get-line line))]
                               [offset (in-naturals)]
                               #:when (> (char->integer character) #xffff))
                      offset)))))

    (define/private (before offsets column utf16?)
      (let loop ([low 0] [high (vector-length offsets)])
        (if (= low high)
            low
            (let* ([middle (quotient (+ low high) 2)]
                   [position (+ (vector-ref offsets middle) (if utf16? middle 0))])
              (if (< position column)
                  (loop (add1 middle) high)
                  (loop low middle))))))

    (define/public (lsp-position->pos line char)
      ;; LSP columns count UTF-16 code units; the rope and Racket syntax
      ;; positions count characters. Preserve the scalar editor API above.
      (define start (line-start-pos/raw line))
      (define end (send this line-end-pos line))
      (define offsets (astral-offsets line))
      (min end (+ start (- char (before offsets char #t)))))

    (define/public (pos->lsp-position pos)
      (define line (rope-offset->line rope pos))
      (define column (- pos (send this line-start-pos line)))
      (list line (+ column (before (astral-offsets line) column #f))))

    (define/public (line-start-pos line)
      (rope-line-start-offset rope line))

    (define/public (line-end-pos line)
      (rope-line-end-offset rope line))

    ;; pos at which line?
    (define/public (at-line pos)
      (rope-offset->line rope pos))

    (define/public (copy)
      (new lsp-editor% [initial-buffer rope]))

    (define/public (get-char pos)
      (rope-ref rope pos))

    (define/public (get-line line)
      (send this get-text (send this line-start-pos line) (send this line-end-pos line)))

    (super-new)))
