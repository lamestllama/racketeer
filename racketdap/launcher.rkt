;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Starts a debugger file from code compiled once into the extension's storage:
;;
;;   racket launcher.rkt STORAGE TARGET ARGUMENT ...
;;
;; An installed extension holds no compiled files, and Racket otherwise compiles
;; each file it starts in memory and discards the result. The compiled folder is
;; a root only while debugger files load, so a program and its children see the
;; settings they would see anyway. Whatever is wrong with the
;; folder, the files load from source as they would without it.
;;
;; This file always compiles in memory, so it is written in the kernel language:
;; that costs a few milliseconds where racket/base would cost tens, in every
;; process the debugger starts.
(module launcher '#%kernel
  (#%require '#%paramz '#%boot racket/private/executable-path)
  (#%provide debugger-command compiled-debugger-roots compiled-debugger-check
             start-debugger-build! manifest-name manifest-entry)

  (define-values (manifest-name) "manifest.rktd")
  ;; A builder that stopped without finishing cannot still be running after this.
  (define-values (abandoned-seconds) 600)

  (define-values (launcher-path) (variable-reference->module-source (#%variable-reference)))
  (define-values (debugger-root)
    (let-values ([(base name dir?) (split-path launcher-path)]) base))

  (define-values (storage) #f)
  (define-values (folder) #f)
  (define-values (root) #f)
  (define-values (build-wanted?) #f)

  ;; The result of (body), or of (fail) when it fails. A break passes through.
  (define-values (attempt)
    (lambda (body fail)
      (let-values ([(tag) (make-continuation-prompt-tag 'attempt)])
        (call-with-continuation-prompt
         (lambda ()
           (with-continuation-mark exception-handler-key
             (lambda (raised)
               (if (exn:fail? raised)
                   (abort-current-continuation tag fail)
                   raised))
             (body)))
         tag
         (lambda (fail) (fail))))))

  (define-values (file-sha1)
    (lambda (path)
      (let-values ([(in) (open-input-file path)])
        (begin0 (sha1-bytes in) (close-input-port in)))))

  ;; A file's path relative to its folder and the hash of its contents.
  (define-values (manifest-entry)
    (lambda (path relative) (cons (path->string relative) (file-sha1 path))))

  (define-values (hex)
    (lambda (bytes)
      (apply string-append
             (map (lambda (byte)
                    (string-append (if (< byte 16) "0" "") (number->string byte 16)))
                  (bytes->list bytes)))))

  (define-values (link-identity)
    (lambda (link)
      (if (path? link)
          (cons (path->bytes link) (if (file-exists? link) (file-sha1 link) #f))
          link)))

  ;; The Racket these files compile against: its version and VM, where it looks
  ;; for libraries and what its links say. A command-line -S adds libraries for one
  ;; tool's own use, so it is not read here. The manifest covers the sources.
  (define-values (folder-name)
    (lambda ()
      (let-values ([(out) (open-output-bytes)])
        (write (list (version) (system-type 'vm) (path->bytes (system-library-subpath #f))
                     (map path->bytes (find-library-collection-paths))
                     (map link-identity (current-library-collection-links))
                     (path->bytes debugger-root))
               out)
        (hex (sha1-bytes (get-output-bytes out))))))

  ;; Chez reads machine code without checking it, so every compiled file is compared
  ;; with its recorded hash before any of them can load. The sources are compared too:
  ;; reinstalling a build can change them under the same path and version.
  (define-values (intact?)
    (lambda (folder)
      (attempt
       (lambda ()
         (let-values ([(in) (open-input-file (build-path folder manifest-name))])
           (let-values ([(manifest) (begin0 (read in) (close-input-port in))])
             (let-values ([(all-match?)
                           (lambda (base entries)
                             (andmap (lambda (entry)
                                       (equal? (cdr entry) (file-sha1 (build-path base (car entry)))))
                                     entries))])
               (if (all-match? debugger-root (car manifest))
                   (all-match? folder (cadr manifest))
                   #f)))))
       (lambda () #f))))

  ;; What a debugger file loads under, given what a program's files load under. A
  ;; file not in the folder compiles in memory, as it would without the folder, and
  ;; needs the ordinary roots to find its libraries. Contents are already checked, so
  ;; a file's date is not compared with the compiled file's: unpacking a package
  ;; again can make a source look newer.
  (define-values (compiled-debugger-roots) (lambda (roots) (if root (cons root roots) roots)))
  (define-values (compiled-debugger-check) (lambda (check) (if root 'exists check)))

  ;; Run a thunk with debugger files reading from the compiled folder, if there is one.
  (define-values (with-compiled-debugger)
    (lambda (body)
      (if root
          (with-continuation-mark parameterization-key
            (extend-parameterization
             (continuation-mark-set-first #f parameterization-key)
             current-compiled-file-roots (compiled-debugger-roots (current-compiled-file-roots))
             use-compiled-file-check (compiled-debugger-check #f))
            (body))
          (body))))

  ;; A module's imports name it relative to itself; this names them absolutely.
  (define-values (from-module)
    (lambda (mpi self)
      (let-values ([(name base) (module-path-index-split mpi)])
        (if name
            (module-path-index-join name (if base (from-module base self) #f))
            self))))

  (define-values (in-debugger?)
    (lambda (name)
      (let-values ([(file) (if (pair? name) (car name) name)])
        (if (path? file)
            (let-values ([(root-parts) (explode-path debugger-root)]
                         [(parts) (explode-path file)])
              (letrec-values ([(prefix?)
                               (lambda (a b)
                                 (if (null? a)
                                     #t
                                     (if (null? b)
                                         #f
                                         (if (equal? (car a) (car b))
                                             (prefix? (cdr a) (cdr b))
                                             #f))))])
                (prefix? root-parts parts)))
            #f))))

  ;; Requiring a module declares its imports only when it runs, and running is not
  ;; for the folder's parameters to see. So this declares the debugger's own modules
  ;; first, leaving each library to load in the ordinary way when it is needed. An
  ;; index remembers its first resolution, so the name comes from a copy of it.
  (define-values (declare-debugger-modules)
    (lambda (target)
      (let-values ([(seen) (make-hash)])
        (letrec-values
            ([(declare)
              (lambda (mpi)
                (let-values ([(path base) (module-path-index-split mpi)])
                  (let-values ([(name)
                                (resolved-module-path-name
                                 (module-path-index-resolve (module-path-index-join path base)))])
                    (if (if (in-debugger? name) (not (hash-ref seen name #f)) #f)
                        (begin
                          (hash-set! seen name #t)
                          (for-each
                           (lambda (phase+imports)
                             (for-each (lambda (import) (declare (from-module import mpi)))
                                       (cdr phase+imports)))
                           (module->imports (module-path-index-resolve mpi #t))))
                        (void)))))])
          (declare (module-path-index-join target #f))))))

  ;; The arguments that start a debugger file in another Racket process. A program
  ;; started this way still reads the worker as its run file.
  (define-values (debugger-command)
    (lambda (target)
      (let-values ([(file) (if (path? target) (path->string target) target)])
        (if storage
            (list "-t" (path->string launcher-path) "-N" file "--" storage file)
            (list file)))))

  (define-values (make-parents)
    (lambda (directory)
      (if (directory-exists? directory)
          (void)
          (let-values ([(base name dir?) (split-path directory)])
            (if (path? base) (make-parents base) (void))
            (attempt (lambda () (make-directory directory))
                     (lambda ()
                       (if (directory-exists? directory)
                           (void)
                           (error 'launcher "cannot make ~a" directory))))))))

  ;; Compile in another process when a launch found nothing to load. The building
  ;; folder is the lock: the process that makes it builds, and a storage folder that
  ;; refuses it ends the attempt here, without starting anything.
  (define-values (start-debugger-build!)
    (lambda ()
      (if build-wanted?
          (begin
            (set! build-wanted? #f)
            (attempt
             (lambda ()
               (let-values ([(building) (string-append (path->string folder) ".building")]
                            [(builder) (build-path debugger-root "tools" "compile-debugger.rkt")])
                 (make-parents storage)
                 (if (if (directory-exists? building)
                         (> (- (current-seconds) (file-or-directory-modify-seconds building))
                            abandoned-seconds)
                         #f)
                     (rename-file-or-directory
                      building
                      (format "~a.stale-~a" folder (current-inexact-milliseconds)))
                     (void))
                 (make-directory building)
                 (let-values ([(process out in err)
                               (with-continuation-mark parameterization-key
                                 (extend-parameterization
                                  (continuation-mark-set-first #f parameterization-key)
                                  current-subprocess-keep-file-descriptors
                                  (if (eq? (system-type 'os) 'windows) 'inherited '()))
                                 (subprocess #f #f #f
                                             (find-executable-path (find-system-path 'exec-file))
                                             builder building (path->string folder)))])
                   (close-input-port out)
                   (close-output-port in)
                   (close-input-port err))))
             void))
          (void))))

  (define-values (launch!)
    (lambda ()
      (let-values ([(arguments) (vector->list (current-command-line-arguments))])
        (let-values ([(target) (simplify-path (path->complete-path (cadr arguments)))]
                     [(place) (path->complete-path (car arguments))])
          (set! storage (path->string place))
          (attempt (lambda ()
                     (set! folder (build-path place (folder-name)))
                     (if (intact? folder) (set! root folder) (set! build-wanted? #t)))
                   void)
          (let-values ([(config) (list 'submod target 'configure-runtime)]
                       [(main) (list 'submod target 'main)])
            (let-values ([(declared)
                          (lambda () (values (module-declared? config #t) (module-declared? main #t)))])
              (let-values ([(configure? main?)
                            (attempt
                             (lambda ()
                               (with-compiled-debugger
                                (lambda ()
                                  (if root (declare-debugger-modules target) (void))
                                  (declared))))
                             ;; The files were intact, but this Racket could not use them.
                             (lambda ()
                               (set! root #f)
                               (set! build-wanted? #t)
                               (declared)))])
                (current-command-line-arguments (list->vector (cddr arguments)))
                (if configure? (dynamic-require config #f) (void))
                (dynamic-require target #f)
                (if main? (dynamic-require main #f) (void)))))))))

  (module* main #f
    (launch!)))
