#lang racket/base
(require file/sha1 racket/list racket/path syntax/modcode syntax/modresolve
         racket-langserver/common/source-snapshot)
(provide module-dependencies)

;; A result describes one file's modules and direct import edges. It has no
;; editor, transport or persistent index state. Phase shifts belong to edges.
(define (module-dependencies file buffers roots)
  (define source (simple-form-path file))
  (define sources
    (for/hash ([buffer (in-list buffers)])
      (values (simple-form-path (hash-ref buffer 'path)) (hash-ref buffer 'text))))
  (define directories (map simple-form-path roots))
  (define (project? path)
    (for/or ([root (in-list directories)])
      (define relative (find-relative-path root path))
      (and (relative-path? relative) (not (member 'up (explode-path relative))))))
  (define loaded (make-hash))
  (define (stamp path) (and (file-exists? path) (call-with-input-file path sha1)))
  (define (record! path)
    (define full (simple-form-path path))
    (hash-ref! loaded (path->string full) (lambda () (if (hash-has-key? sources full) 'buffer (stamp full)))))
  (record! source)
  (define (reference resolved)
    (define submodules (if (pair? resolved) (map symbol->string (cddr resolved)) '()))
    (define base (if (pair? resolved) (cadr resolved) resolved))
    (hasheq 'path (if (path? base) (path->string (simple-form-path base)) 'null)
            'name (if (path? base) (path->string (file-name-from-path base)) (symbol->string base))
            'submodules submodules))
  (define modules '())
  (define count 0)
  (call-with-source-snapshot source sources
    (lambda ()
      ;; Always compile the selected source; project intermediates and open
      ;; buffers use the same source-snapshot loader as language analysis.
      (define code (get-module-code source #:choose (lambda _ 'src)))
      (define (visit code names)
        (set! count (add1 count))
        (when (or (> count 2000) (> (length names) 64)) (error 'dependencies "Module tree exceeds its limit."))
        (define children (append (module-compiled-submodules code #t) (module-compiled-submodules code #f)))
        (define imports
          (for*/list ([entry (in-list (module-compiled-imports code))] [mpi (in-list (cdr entry))])
            (define resolved (resolve-module-path-index mpi source))
            (define target (reference resolved))
            (when (string? (hash-ref target 'path)) (record! (hash-ref target 'path)))
            (hash-set target 'phase (if (eq? #f (car entry)) 'null (car entry)))))
        (when (> (length imports) 20000) (error 'dependencies "Import list exceeds its limit."))
        (set! modules (cons (hasheq 'submodules names 'imports imports
                                   'children (for/list ([child (in-list children)])
                                               (map symbol->string (cdr (module-compiled-name child))))) modules))
        (for ([child (in-list children)]) (visit child (map symbol->string (cdr (module-compiled-name child))))))
      (visit code '()))
    #:source? project? #:on-load record!)
  (hasheq 'version 1 'path (path->string source) 'modules (reverse modules)
          'files (sort (hash-keys loaded) string<?)
          'stamps (for/list ([(file hash) (in-hash loaded)] #:unless (eq? hash 'buffer))
                    (unless (equal? hash (stamp file)) (error 'dependencies "Source changed during analysis: ~a" file))
                    (hasheq 'path file 'hash (or hash 'null)))))
