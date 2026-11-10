;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Starts one analysis worker process. The server sends the library paths it uses
;; as the first thing on standard input, so the worker finds the same compiled
;; code and the same libraries, whatever those paths contain. This module needs
;; no compiled form, because it depends on no library to be found that way.
(module workspace-worker '#%kernel
  (let-values ([(settings) (read (current-input-port))])
    (current-library-collection-paths (map bytes->path (car settings)))
    (current-compiled-file-roots
      (map (lambda (root) (if (bytes? root) (bytes->path root) root)) (cadr settings)))
    ;; Reuse shared bytecode instead of compiling analysis on every worker start.
    (current-load/use-compiled
     ((dynamic-require 'compiler/cm 'make-compilation-manager-load/use-compiled-handler)))
    ;; Check Syntax's documentation lookup is unused by the indexer. Declare its
    ;; helper here, before loading analysis, without loading the documentation index.
    (let-values ([(previous) (current-module-declare-name)])
      (current-module-declare-name
       ((current-module-name-resolver) 'drracket/private/syncheck/xref #f #f #f))
      (eval (quote-syntax
             (module xref '#%kernel
               ;; Compiled Check Syntax code shares these dependencies with xref.
               (#%require scribble/manual-struct compiler/compilation-path)
               (#%provide get-index-entry-info flush-index-entry-cache)
               (define-values (get-index-entry-info) (lambda (binding-info) #f))
               (define-values (flush-index-entry-cache) (lambda () (void))))))
      (current-module-declare-name previous))
    (dynamic-require (list 'submod (bytes->path (caddr settings)) 'worker) #f)))
