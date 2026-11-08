#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require rackunit racket/file racket/list racket/runtime-path json)

(define-runtime-path attach "../racketdap/worker/attach.rkt")
(define-runtime-path packages "../racketdap/packages.rkt")
(define-runtime-path source "../racketdap/wxme-source.rkt")
(define-runtime-path decoder "../racketdap/wxme-decode.rkt")
(define-runtime-path fixtures "fixtures/wxme-debug")

(define (declared? namespace path)
  (parameterize ([current-namespace namespace])
    (module-declared? path #f)))

(module+ test
  (test-case "an embedded attach host loads in a different module registry without sockets"
    (parameterize ([current-namespace (make-base-namespace)])
      (check-equal? (dynamic-require attach 'attach-api-version) 1)
      (define attachment ((dynamic-require attach 'start-attach)))
      (check-not-false (sync/timeout 0 ((dynamic-require attach 'attachment-ended-evt) attachment)))
      ((dynamic-require attach 'close-attachment!) attachment)))

  (test-case "deferred package imports belong to their defining registry on first use"
    (define owner (make-base-namespace))
    (define caller (make-base-namespace))
    (define-values (roots inventory)
      (parameterize ([current-namespace owner])
        (values (dynamic-require packages 'package-source-roots)
                (dynamic-require packages 'installed-packages))))
    (check-false (declared? owner 'pkg/lib))
    (parameterize ([current-namespace caller])
      ;; The first call exercises the keyword argument to pkg-directory; the
      ;; inventory exercises every other deferred export, including its structs.
      (define directories (roots '("rackunit-lib")))
      (define entry (findf (lambda (pkg) (equal? (hash-ref pkg 'name) "rackunit-lib")) (inventory)))
      (check-not-false entry)
      (check-equal? (map path->string directories) (list (hash-ref entry 'directory)))
      (check-eq? (current-namespace) caller))
    (check-true (declared? owner 'pkg/lib))
    (check-false (declared? caller 'pkg/lib)))

  (test-case "deferred structured source decoding belongs to its defining registry on first use"
    (define owner (make-base-namespace))
    (define caller (make-base-namespace))
    (define text (parameterize ([current-namespace owner]) (dynamic-require source 'source-text)))
    (check-false (declared? owner decoder))
    (define bytes (file->bytes (build-path fixtures "objects.wxme")))
    (define expected (hash-ref (call-with-input-file (build-path fixtures "expected.json") read-json) 'objects))
    (parameterize ([current-namespace caller])
      (check-equal? (text bytes) expected)
      (check-equal? (text (subbytes bytes (bytes-length #"#reader(lib\"read.ss\"\"wxme\")"))) expected)
      (check-eq? (current-namespace) caller))
    (check-true (declared? owner decoder))
    (check-false (declared? caller decoder))))
