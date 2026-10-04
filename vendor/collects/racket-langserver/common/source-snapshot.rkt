#lang racket/base

(require "source-document.rkt"
         racket/match
         racket/path
         syntax/modcode)

(provide call-with-source-snapshot source-snapshot-text)

(define current-sources (make-parameter (hash)))
(define (source-snapshot-text path)
  (define full (simple-form-path path))
  (define text (hash-ref (current-sources) full #f))
  (when (and (not text) (hash-has-key? (current-sources) full))
    (error 'source-snapshot "conflicting buffers for ~a" full))
  text)

;; Loading is scoped to one analysis. Project dependencies are read from source
;; so compiled intermediates cannot retain an older macro expansion. Libraries
;; outside that scope keep their ordinary compiled loading policy.
(define (call-with-source-snapshot path sources proc
                                   #:source? [source? (lambda (_) #f)]
                                   #:on-load [on-load void])
  (define ordinary-resolve (current-module-name-resolver))
  (define (relative-import? module)
    (match module
      [(? path-string?) (relative-path? module)]
      [(list 'file (? path-string? file)) (relative-path? file)]
      [(list* 'submod (and parent (not (or "." ".."))) _) (relative-import? parent)]
      [_ #f]))
  (define (primary-module? relative-to)
    (define name (and relative-to (resolved-module-path-name relative-to)))
    (equal? path (if (pair? name) (car name) name)))
  (define resolve
    (case-lambda
      [(name namespace) (ordinary-resolve name namespace)]
      [(module relative-to stx load?)
       (when (and (source-document-unbased? path) (relative-import? module)
                  (or (primary-module? relative-to)
                      (and stx (equal? (syntax-source stx) path))))
         (raise-syntax-error #f
           "Relative imports need a save location or a single workspace folder. Save this document or open its workspace." stx))
       (ordinary-resolve module relative-to stx load?)]))
  (define ordinary-load (current-load/use-compiled))
  (define ordinary-open (moddep-current-open-input-file))
  (define (load-snapshot file expected)
    (define requested (simple-form-path file))
    (define legacy (path-replace-extension requested #".ss"))
    (define full
      (if (and expected (equal? (path-get-extension requested) #".rkt")
               (not (hash-has-key? sources requested)) (not (file-exists? requested))
               (or (hash-has-key? sources legacy) (file-exists? legacy)))
          legacy requested))
    (when expected (on-load full))
    (cond
      [(and expected (or (hash-has-key? sources full) (and (file-exists? full) (source? full))))
       ;; A #f-headed request permits independent compiled loading only. Let
       ;; the resolver request the enclosing source module instead.
       (unless (and (pair? expected) (not (car expected)))
         (parameterize ([current-load-relative-directory (path-only full)]
                        [current-module-declare-source full])
           (get-module-code full #:sub-path '() #:rkt-try-ss? #f
                            #:choose (lambda _ 'src) #:compile eval)))]
      [else (ordinary-load file expected)]))
  (parameterize ([current-namespace (make-base-namespace)]
                 [current-sources sources]
                 [current-module-name-resolver resolve]
                 [current-directory (path-only path)]
                 [current-load-relative-directory (path-only path)]
                 [current-load/use-compiled load-snapshot]
                 [moddep-current-open-input-file
                  (lambda (file)
                    (define full (simple-form-path file))
                    (cond
                      [(hash-has-key? sources full)
                       (define text (hash-ref sources full))
                       (unless text (error 'source-snapshot "conflicting buffers for ~a" full))
                       (open-input-string text full)]
                      [else (ordinary-open file)]))])
    (proc)))
