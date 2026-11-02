#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Compiles the debugger once into the building folder the launcher made, then
;; renames it to the folder the launcher reads. The rename is what makes a folder
;; visible, so a reader sees all of a build or none of it. Nothing depends on this
;; finishing: until it does, debugger files load from source.

(require compiler/cm racket/file racket/list racket/path racket/runtime-path syntax/modcode
         "../launcher.rkt" "../worker/debug-cache.rkt")

(define-runtime-path debugger-root "..")
(define keep-folders 4)

(define (under? path root)
  (define parts (explode-path path))
  (define root-parts (explode-path root))
  (and (<= (length root-parts) (length parts))
       (equal? root-parts (take parts (length root-parts)))))

(define (debugger-sources root)
  (for/list ([file (in-directory root (lambda (dir) (not (equal? (file-name-from-path dir) (string->path "compiled")))))]
             #:when (equal? (path-get-extension file) #".rkt"))
    file))

;; Read each debugger source once. The manifest must certify precisely the bytes
;; handed to the compiler, even if an installation is replaced during the build.
(define (source-snapshot sources)
  (for/hash ([source (in-list sources)]) (values source (file->bytes source))))

(define (compile-all! building sources root snapshots)
  (define check (use-compiled-file-check))
  (define ordinary-load (current-load/use-compiled))
  (define ordinary-open (moddep-current-open-input-file))
  (define (library? file) (not (under? (simplify-path file) root)))
  ;; The building folder is the only root for the debugger's files, so a compiled
  ;; folder left in a checkout cannot pass for one. Libraries load as they always do.
  (parameterize ([current-namespace (make-base-empty-namespace)]
                 [current-compiled-file-roots (list building)]
                 [moddep-current-open-input-file
                  (lambda (file)
                    (define bytes (hash-ref snapshots (simplify-path (path->complete-path file)) #f))
                    (if bytes (open-input-bytes bytes file) (ordinary-open file)))]
                 [current-load/use-compiled
                  (lambda (file name)
                    (if (library? file)
                        (parameterize ([current-compiled-file-roots '(same)]) (ordinary-load file name))
                        (ordinary-load file name)))]
                 [manager-skip-file-handler
                  (lambda (file)
                    (and (library? file)
                         (ordinary-compiled-stamp file (use-compiled-file-paths) '(same) check)))])
    (define compile-file (make-caching-managed-compile-zo))
    ;; A file that needs a library this installation lacks, such as the GUI, or one
    ;; only its own command line supplies, stays on source, and fails if it would
    ;; have failed anyway.
    (for ([source (in-list sources)])
      (with-handlers ([exn:fail? void])
        (compile-file source)))))

(define (write-manifest! building sources root snapshots)
  (define compiled
    (for/list ([file (in-directory building)] #:when (equal? (path-get-extension file) #".zo"))
      (manifest-entry file (find-relative-path building file))))
  (write-to-file
   (list (for/list ([source (in-list sources)])
           (cons (path->string (find-relative-path root source))
                 (sha1-bytes (open-input-bytes (hash-ref snapshots source)))))
         compiled)
   (build-path building manifest-name)))

(define (set-aside! folder)
  (rename-file-or-directory folder (format "~a.stale-~a" folder (current-inexact-milliseconds))))

;; Keep the folders of a few recent Racket and extension versions. A session reading
;; one that goes only falls back to source for what it has yet to read.
(define (tidy! storage folder)
  (define now (current-seconds))
  (define (date-of path) (file-or-directory-modify-seconds path #f (lambda () 0)))
  (define (remove! path)
    (with-handlers ([exn:fail:filesystem? void]) (delete-directory/files path)))
  (define-values (temporary finished)
    (partition (lambda (path) (regexp-match? #rx"[.](stale-[0-9.]+|building)$" (path->bytes path)))
               (directory-list storage #:build? #t)))
  (for ([path (in-list temporary)]
        #:when (or (regexp-match? #rx"[.]stale-" (path->bytes path))
                   (> (- now (date-of path)) 3600)))
    (remove! path))
  (define others (sort (remove folder finished) > #:key date-of))
  (when (> (length others) (sub1 keep-folders))
    (for-each remove! (drop others (sub1 keep-folders)))))

(module+ main
  (define building (string->path (vector-ref (current-command-line-arguments) 0)))
  (define folder (string->path (vector-ref (current-command-line-arguments) 1)))
  (define marker-identity (file-or-directory-identity building))
  (define work #f)
  (define (clean-up!)
    (when work
      (with-handlers ([exn:fail:filesystem? void]) (delete-directory/files work)))
    ;; A launcher may have taken over an old marker. Never remove its successor.
    (when (and (directory-exists? building)
               (equal? marker-identity (file-or-directory-identity building)))
      (delete-directory/files building)))
  (with-handlers ([void (lambda (_)
                          (with-handlers ([void void]) (clean-up!))
                          (exit 0))])
    ;; A marker is also a lease and may be renamed after its time limit. Each
    ;; compiler writes a distinct child, so a resumed compiler cannot certify or
    ;; publish another compiler's files at the replacement marker's path.
    (set! work (make-temporary-file "work~a" 'directory building))
    (define root (simplify-path debugger-root))
    (define sources (debugger-sources root))
    (define snapshots (source-snapshot sources))
    (compile-all! work sources root snapshots)
    ;; Avoid publishing a known obsolete build. The recorded hashes still describe
    ;; the snapshot if a later replacement crosses this check.
    (unless (equal? snapshots (source-snapshot (debugger-sources root)))
      (error 'compile-debugger "debugger sources changed during compilation"))
    (write-manifest! work sources root snapshots)
    (unless (equal? marker-identity (file-or-directory-identity building))
      (error 'compile-debugger "another builder has taken over"))
    (when (directory-exists? folder) (set-aside! folder))
    (rename-file-or-directory work folder)
    (set! work #f)
    (clean-up!)
    (tidy! (path-only folder) folder)))
