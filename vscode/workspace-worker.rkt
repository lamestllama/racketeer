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
    (dynamic-require (list 'submod (bytes->path (caddr settings)) 'worker) #f)))
