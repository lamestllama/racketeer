#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require "runtime/racketdap/language-adapters.rkt"
         (only-in file/sha1 bytes->hex-string)
         racket-langserver/doclib/language-adapter
         (prefix-in server: (only-in racket-langserver/common/source-snapshot observe-source-snapshot!))
         "runtime/racketdap/tools/source-snapshot.rkt")
(provide current-language-adapter-observer current-language-adapter-roots
         resolve-workspace-language-adapter language-adapter-bindings-provider
         language-adapter-current?)

;; Install in each process that embeds the bundled analyser, including workers
;; and fresh rename namespaces. The resolver runs in the expansion namespace.
(current-language-adapter-validator language-adapter-current?)
(define (language-adapter-bindings-provider adapter)
   (define bindings (hash-ref adapter 'bindings))
   (and (pair? bindings)
        (lambda (request)
          (or (call-language-provider (cadr bindings) request #:source 'adapter #:field 'bindings)
              (hasheq)))))
(current-language-adapter-bindings language-adapter-bindings-provider)
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
(current-language-adapter-rename
 (lambda (adapter)
   (define choice (hash-ref (hash-ref adapter 'editor) 'rename))
   (and (pair? choice)
        (lambda (request)
          (call-language-provider (cadr choice) request #:source 'adapter #:field 'editor.rename)))))
(define (resolve-workspace-language-adapter source text pre roots)
   (and (syntax? pre)
        (parameterize ([current-language-adapter-file-observer
                        (lambda (file fingerprint)
                          ;; Both analysis routes must retain descriptor dependencies.
                          (server:observe-source-snapshot! file)
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
                               (current-language-adapter-roots)))))))
(current-language-adapter-resolver resolve-workspace-language-adapter)
