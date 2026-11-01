#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/class racket/gui/base racket/file framework)

(define directory (vector-ref (current-command-line-arguments) 0))
(make-directory* directory)
(define editor (new text%))
(send editor insert "#lang racket/base\n(provide value)\n(define value (+ 20 22))\n")
(define comment (new comment-box:snip%))
(send (send comment get-editor) insert "(error \"comment must not execute\")\n")
(send editor insert comment)
(send editor insert "\n(void ")
(send editor insert (make-object image-snip% (make-bitmap 4 4)))
(send editor insert ")\n")
(void (send editor save-file (build-path directory "editable-program.wxme") 'standard))

;; A document can name different GUI and headless readers. The editor must
;; reject this original class even though the headless comment reader is known.
(define custom-class (new snip-class%))
(send custom-class set-classname "((lib \"reader.rkt\" \"racketeer-fixture\") (lib \"comment.rkt\" \"wxme\"))")
(send (get-the-snip-class-list) add custom-class)
(define custom (new comment-box:snip%))
(send custom set-snipclass custom-class)
(send (send custom get-editor) insert "comment")
(define mixed (new text%))
(send mixed insert custom)
(void (send mixed save-file (build-path directory "different-readers.wxme") 'standard))
(exit)
