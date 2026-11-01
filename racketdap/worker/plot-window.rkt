#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require racket/class racket/gui/base file/convertible)
(provide open-plot-window save-plot-image)

(define (save-plot-image plot path)
  (define bytes (convert plot 'png-bytes #f))
  (unless (bytes? bytes) (error 'plot "This plot does not provide a PNG image."))
  (call-with-output-file path #:exists 'truncate/replace
    (lambda (out) (write-bytes bytes out)))
  (void))

;; Each view owns its copied snip, eventspace and rendering resources. The parent
;; program custodian also closes every view when the session ends.
(define (open-plot-window value)
  (define custodian (make-custodian))
  (with-handlers ([(lambda (_) #t)
                   (lambda (failure) (custodian-shutdown-all custodian) (raise failure))])
    (parameterize ([current-custodian custodian])
      (parameterize ([current-eventspace (make-eventspace)])
        (define plot (send value copy))
        (define editor (new text%))
        (define canvas #f)
        (define closed? #f)
        (define (close)
          (unless closed?
            (set! closed? #t)
            (send frame show #f)
            (when canvas (send canvas set-editor #f))
            (send editor lock #f)
            (send editor erase)
            (set! plot #f)
            (custodian-shutdown-all custodian)))
        (define frame
          (new (class frame%
                 (super-new [label "Racket Interactive Plot"] [width 700] [height 550])
                 (define/augment (on-close) (close)))))
        (define bar (new horizontal-panel% [parent frame] [stretchable-height #f]))
        (new button% [parent bar] [label "Save PNG…"]
             [callback
              (lambda (_button _event)
                (with-handlers ([exn:fail? (lambda (failure)
                                             (message-box "Save Plot" (exn-message failure) frame '(ok stop)))])
                  (define path (put-file "Save Plot as PNG" frame #f "plot.png" "png" '()
                                         '(("PNG image" "*.png"))))
                  (when path (save-plot-image plot path))))])
        (new button% [parent bar] [label "Close"] [callback (lambda (_button _event) (close))])
        (new message% [parent bar] [label "Drag to zoom (2D) or rotate (3D)."])
        (send editor insert plot)
        (send editor hide-caret #t)
        (send editor lock #t)
        (set! canvas (new editor-canvas% [parent frame] [editor editor]))
        (send frame show #t)
        frame))))
