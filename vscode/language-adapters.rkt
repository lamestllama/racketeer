#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require "runtime/racketdap/language-adapters.rkt"
         (only-in file/sha1 bytes->hex-string)
         racket-langserver/doclib/language-adapter
         racket-langserver/common/source-snapshot)
(provide current-language-adapter-observer current-language-adapter-roots)

;; Install in each process that embeds the bundled analyser, including workers
;; and fresh rename namespaces. The resolver runs in the expansion namespace.
(current-language-adapter-validator language-adapter-current?)
(current-language-adapter-bindings
 (lambda (adapter)
   (define bindings (hash-ref adapter 'bindings))
   (and (pair? bindings)
        (lambda (request)
          (or (call-language-provider (cadr bindings) request #:source 'adapter #:field 'bindings)
              (hasheq))))))
(current-language-adapter-declarations
 (lambda (adapter)
   (define reference (hash-ref (hash-ref adapter 'editor) 'declarations))
   (and (vector? reference)
        (lambda (request)
          (call-language-provider reference request #:source 'adapter #:field 'editor.declarations)))))
(current-language-adapter-calls
 (lambda (adapter)
   (define reference (car (hash-ref (hash-ref adapter 'editor) 'calls)))
   (and (vector? reference)
        (lambda (request)
          (call-language-provider reference request #:source 'adapter #:field 'editor.calls)))))
(current-language-adapter-completion
 (lambda (adapter)
   (define choice (car (hash-ref (hash-ref adapter 'editor) 'completion)))
   (and (pair? choice)
        (lambda (request)
          (with-handlers ([exn:fail? (lambda (_) #f)])
            (call-language-provider (cadr choice) request #:source 'adapter #:field 'editor.completion))))))
(current-language-adapter-resolver
 (lambda (source text pre roots)
   (and (syntax? pre)
        (parameterize ([current-language-adapter-file-observer
                        (lambda (file fingerprint)
                          (define observed (observe-source-snapshot! file))
                          (define entry (and (list? observed) (assoc file observed)))
                          (when (and entry (bytes? (cdr entry))
                                     (not (equal? fingerprint (bytes->hex-string (cdr entry)))))
                            (error 'language-adapter "dependency changed during snapshot: ~a" file)))]
                       [current-language-adapter-open-input-file open-source-snapshot-input-file])
          (resolve-language-adapter source #:text text #:pre pre #:declare-bindings? #t
            #:declare-editor? #t
            #:workspace (language-adapter-workspace source
                           (if (null? (current-language-adapter-roots)) roots
                               (current-language-adapter-roots))))))))
