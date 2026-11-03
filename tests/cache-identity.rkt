#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
(require rackunit racket/file racket/path racket/runtime-path)
(define-runtime-path debugger "../racketdap")
(module+ test
 (test-case "loaded code keeps its identity when the installation is replaced"
  (define directory (make-temporary-file "cache-identity-~a" 'directory))
  (dynamic-wind void
   (lambda ()
    (define root (build-path directory "racketdap"))
    (copy-directory/files debugger root)
    (define module `(file ,(path->string (build-path root "worker/debug-cache.rkt"))))
    (define namespace (make-base-namespace))
    (define get-root
      (parameterize ([current-namespace namespace]) (dynamic-require module 'cache-root)))
    (define key (get-root directory))
    ;; The old reader used this exact identity layout. It must never share a
    ;; directory with a reader whose replay entries have a different arity.
    (define legacy-key
      (parameterize ([current-namespace namespace])
       (parameterize ([current-namespace (module->namespace module)])
        (eval
         `(let* ([identity
                  (list (version) (system-type 'vm) (system-type 'target-machine)
                   (map path->bytes* (current-library-collection-paths))
                   (map collection-link-identity (current-library-collection-links))
                   (path->bytes* (simplify-path instrumenter-root))
                   (for/list ([file (in-list instrumenter-files)])
                    (call-with-input-file* (build-path instrumenter-root file) sha1)))]
                 [out (open-output-bytes)])
           (write identity out)
           (build-path ,directory (sha1 (open-input-bytes (get-output-bytes out)))))))))
    (check-not-equal? key legacy-key)
    (call-with-output-file (build-path root "instrumentation/instrument.rkt")
      (lambda (out) (newline out)) #:exists 'append)
    (check-equal? (get-root directory) key)
    (define new-root
      (parameterize ([current-namespace (make-base-namespace)])
        (dynamic-require module 'cache-root)))
    (check-not-equal? (new-root directory) key))
   (lambda () (delete-directory/files directory)))))
