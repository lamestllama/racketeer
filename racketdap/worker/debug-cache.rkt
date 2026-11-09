#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Where instrumented compiled code lives, and how far it can be trusted. The
;; compilation manager decides whether a file is current; this module supplies
;; its root, its modes and its answers for files it should not build.

(require compiler/cm compiler/compilation-path file/sha1 racket/file racket/list racket/promise racket/runtime-path)
(provide cache-root default-cache-directory evict-cache! entry-path remove-entry! mark-entry-used!
         read-entry-bytes entry-records-hash? ordinary-compiled-stamp instrumenter-stamp cache-size-limit
         add-replay-log take-replay-log replay-source-hash replay-unit replay-events replay-adapter)

(define-runtime-path instrumenter-root "..")
;; Every file that decides generated code or how it is read back.
(define instrumenter-files
  '("instrumentation/instrument.rkt" "instrumentation/runtime.rkt"
    "worker/expand.rkt" "worker/load.rkt" "worker/debug-cache.rkt"))

;; Distinguish readers with incompatible replay records even when a running
;; extension is replaced at its existing path.
(define replay-format 3)
;; Keep the identity of this loaded implementation when its files are replaced.
(define instrumenter-hashes
  (for/list ([file (in-list instrumenter-files)])
    (call-with-input-file* (build-path instrumenter-root file) sha1)))

(define cache-size-limit (* 512 1024 1024))
(define (default-cache-directory)
  (build-path (find-system-path 'addon-dir) "racketeer" "debug-cache"))

;; Generated code names runtime.rkt by absolute path, so the location is part of
;; the key along with the files' contents. Dependencies resolve through the
;; library paths and links, which a .dep file records only by the file each one found.
(define (cache-root directory)
  (define identity
    (list replay-format (version) (system-type 'vm) (system-type 'target-machine)
          (map path->bytes* (current-library-collection-paths))
          (map collection-link-identity (current-library-collection-links))
          (path->bytes* (simplify-path instrumenter-root))
          instrumenter-hashes))
  (define key (let ([o (open-output-bytes)]) (write identity o) (sha1 (open-input-bytes (get-output-bytes o)))))
  (build-path directory key))
(define (path->bytes* p) (if (path? p) (path->bytes (simplify-path p)) p))
;; A link can send a collection elsewhere while the file it found before stays as it was,
;; so what a link says belongs in the key, not only where it is.
(define (collection-link-identity link)
  (cond
    [(path? link)
     (list (path->bytes* link) (and (file-exists? link) (call-with-input-file* link sha1)))]
    [(hash? link)
     (sort (for/list ([(name paths) (in-hash link)]) (cons name (map path->bytes* paths)))
           string<? #:key (lambda (entry) (format "~s" (car entry))))]
    [else link]))

(define (entry-path root mode source extension)
  (define-values (dir name)
    (get-compilation-dir+name source #:modes (list mode) #:roots (list root)))
  (build-path dir (path-add-extension name extension)))
(define (remove-entry! root mode source)
  (for ([extension '(#".zo" #".dep")])
    (with-handlers ([exn:fail:filesystem? void])
      (delete-file (entry-path root mode source extension)))))

;; The source hash in the manager's record, which it can take from a file saved
;; after the bytes it compiled were read.
(define (entry-records-hash? root mode source hash)
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (equal? hash (car (caddr (call-with-input-file* (entry-path root mode source #".dep") read))))))
(define (mark-entry-used! root mode source)
  (with-handlers ([exn:fail:filesystem? void])
    (file-or-directory-modify-seconds (entry-path root mode source #".dep") (current-seconds))))

;; The entry's bytes, or #f when they do not carry their own hash: Chez reads
;; machine code without checking it, so a damaged file must not reach the reader.
(define (read-entry-bytes root mode source)
  (define stored (file->bytes (entry-path root mode source #".zo")))
  (and (module-hashes-intact? (bytes-copy stored)) stored))
;; The manager's install-module-hashes! hashes each bundle with its hash field
;; zero; this walks the same layout, clearing each field to check it.
(define (module-hashes-intact? s [start 0] [len (bytes-length s)])
  (define vlen (bytes-ref s (+ start 2)))
  (define vmlen (bytes-ref s (+ start 3 vlen)))
  (define at (+ start 5 vlen vmlen))
  (case (integer->char (bytes-ref s (+ start 4 vlen vmlen)))
    [(#\B)
     (define recorded (subbytes s at (+ at 20)))
     (bytes-copy! s at (make-bytes 20 0))
     (equal? recorded (sha1-bytes s start (+ start len)))]
    [(#\D)
     (define (read-num rel-pos)
       (integer-bytes->integer s #t #f (+ start rel-pos) (+ start rel-pos 4)))
     (for/fold ([pos (+ 9 vlen vmlen)] [intact? #t] #:result intact?)
               ([i (in-range (read-num (+ 5 vlen vmlen)))])
       (define pos-pos (+ pos 4 (read-num pos)))
       (values (+ pos-pos 16)
               (and intact?
                    (module-hashes-intact? s (+ start (read-num pos-pos)) (read-num (+ pos-pos 4))))))]
    [else #f]))

;; The manager takes a file to be current when nothing it depends on looks newer,
;; and looks no further. Run with use-compiled-file-check 'exists, it reads every
;; file's date as zero. A dependency that is always newer sends each check on to
;; its comparison of source and dependency hashes, external files included.
(define always-newer +inf.0)
;; The manager sorts a file's dependencies by hash before combining them, so two
;; with the same hash combine in the order it happened to list them.
(define (instrumenter-stamp path) (cons always-newer (format "instrumenter:~a" path)))
;; What a file's dependents should record when the debugger loads it from its
;; ordinary compiled file, or #f if it has none the ordinary loader would use.
(define (ordinary-compiled-stamp source modes roots check)
  (define-values (dir name) (get-compilation-dir+name source #:modes modes #:roots roots))
  (define zo (build-path dir (path-add-extension name #".zo")))
  (define zo-date (file-or-directory-modify-seconds zo #f (lambda () #f)))
  (define source-date (file-or-directory-modify-seconds source #f (lambda () #f)))
  (and zo-date
       (or (not source-date) (eq? check 'exists) (>= zo-date source-date))
       (cons always-newer (delay (or (get-compiled-file-sha1 zo) "")))))

;; Least recently used files go first. Deleting an entry another session is about
;; to read only makes that session compile: every read tolerates a missing file.
(define (evict-cache! directory [limit cache-size-limit])
  (when (directory-exists? directory)
    (define now (current-seconds))
    (define files
      (for/list ([file (in-directory directory)] #:when (file-exists? file))
        (cons file (with-handlers ([exn:fail:filesystem? (lambda (_) 0)])
                     (file-or-directory-modify-seconds file)))))
    (define (size-of file) (with-handlers ([exn:fail:filesystem? (lambda (_) 0)]) (file-size file)))
    (define total (for/sum ([entry (in-list files)]) (size-of (car entry))))
    (when (> total limit)
      (define by-use
        (sort (filter (lambda (entry) (regexp-match? #rx"[.]dep$" (path->bytes (car entry)))) files)
              < #:key cdr))
      (for/fold ([remaining total]) ([entry (in-list by-use)] #:break (<= remaining limit))
        (define dep (car entry))
        (define zo (path-replace-extension dep #".zo"))
        (define freed (+ (size-of dep) (size-of zo)))
        (with-handlers ([exn:fail:filesystem? void]) (delete-file dep))
        (with-handlers ([exn:fail:filesystem? void]) (delete-file zo))
        (- remaining freed)))
    ;; An interrupted build leaves its temporary file behind.
    (for ([entry (in-list files)]
          #:when (and (regexp-match? #rx"[.]zo[0-9]*$|[.]dep[0-9]*$" (path->bytes (car entry)))
                      (not (regexp-match? #rx"[.](zo|dep)$" (path->bytes (car entry))))
                      (> (- now (cdr entry)) 3600)))
      (with-handlers ([exn:fail:filesystem? void]) (delete-file (car entry))))))

;; The record a file's expansion leaves is compiled into its own .zo as a
;; submodule, so the code and its sites arrive and leave in one atomic rename.
;; The record: the hash of the source bytes compiled, the unit its forms name, and
;; what happened during expansion, in order.
(define replay-module-name 'racketdap-replay)
(define (add-replay-log code source-hash unit events compile #:adapter [adapter #f])
  (define holder
    (compile
     (namespace-syntax-introduce
      (datum->syntax
       #f
       `(,(namespace-module-identifier) holder '#%kernel
         (module ,replay-module-name '#%kernel
           (#%provide log)
           (define-values (log) (quote ,(if adapter (vector source-hash unit events adapter) (vector source-hash unit events))))))))))
  ;; Taken from a holder, a submodule has the form a parent's directory accepts.
  (module-compiled-submodules
   code #t
   (cons (car (module-compiled-submodules holder #t))
         (module-compiled-submodules code #t))))
;; Reads the record out of compiled code and returns it with the code as it was
;; before the record went in, so the program's module never gains a submodule.
(define (take-replay-log code evaluate)
  (define-values (record others)
    (partition (lambda (sub) (eq? replay-module-name (last-name (module-compiled-name sub))))
               (module-compiled-submodules code #t)))
  (define name (gensym replay-module-name))
  (parameterize ([current-module-declare-name (make-resolved-module-path name)])
    (evaluate (module-compiled-name (car record) name)))
  (values (dynamic-require (make-resolved-module-path name) 'log)
          (module-compiled-submodules code #t others)))
(define (last-name name) (if (pair? name) (last name) name))
(define (replay-source-hash log) (vector-ref log 0))
(define (replay-unit log) (vector-ref log 1))
(define (replay-events log) (vector-ref log 2))
(define (replay-adapter log) (and (> (vector-length log) 3) (vector-ref log 3)))
