#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require compiler/cm-accomplice compiler/compilation-path file/sha1 net/url-string racket/file racket/list racket/match racket/path racket/port
         racket/runtime-path syntax/modread syntax/modresolve)
(provide validate-language-profile make-provider-request call-language-provider
         resolve-language-adapter language-adapter-workspace
         current-language-adapter-roots current-language-adapter-observer
         current-language-adapter-file-observer current-language-adapter-open-input-file
         language-adapter-current?)

(define-runtime-path registry-file "language-adapters.rktd")
(define current-language-adapter-roots (make-parameter '()))
(define current-language-adapter-observer (make-parameter void))
(define current-language-adapter-file-observer (make-parameter void))
(define current-language-adapter-open-input-file (make-parameter open-input-file))
(define current-adapter-reads (make-parameter #f))
(define (file-fingerprint file)
  (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
    (and (file-exists? file) (call-with-input-file* file sha1))))
(define (observe-file! file [opened (hash)])
  (define reads (current-adapter-reads))
  (when (and reads (path? file))
    (define full (simple-form-path file))
    (hash-ref! reads full (lambda () (hash-ref opened full (lambda () (file-fingerprint full)))))))
(define (observe-module! module [opened (hash)])
  (define seen (make-hash))
  (define (walk name)
    (unless (hash-ref seen name #f)
      (hash-set! seen name #t)
      (define file (if (pair? name) (car name) name))
      (observe-file! file opened)
      (define identity (make-resolved-module-path name))
      ;; A module with no file, such as a primitive one, has no imports to record.
      (when (and (path? file) (module-declared? identity #f))
        (for* ([phase (in-list (module->imports identity))] [mpi (in-list (cdr phase))])
          (define resolved
            (resolve-module-path-index mpi (if (pair? name) `(submod ,@name) (and (path? name) name))))
          (walk (match resolved [(list 'submod file children ...) (cons file children)] [_ resolved]))))))
  (when (current-adapter-reads)
    (define resolved (resolve-module-path module #f))
    (walk (match resolved [(list 'submod file children ...) (cons file children)] [_ resolved]))))
(define (language-adapter-current? adapter)
  (define fingerprint (and adapter (hash-ref adapter 'fingerprint #f)))
  (or (not fingerprint)
      (for/and ([entry (in-list (hash-ref fingerprint 'files))])
        (equal? (cdr entry) (file-fingerprint (car entry))))))

(define (problem source field message . arguments)
  (error 'language-adapter "~a: ~a: ~a" source field (apply format message arguments)))
(define (at-field source field proc)
  (with-handlers
      ([exn:fail:out-of-memory?
        (lambda (e)
          (raise (exn:fail:out-of-memory (format "~a: ~a: ~a" source field (exn-message e))
                                         (exn-continuation-marks e))))]
       [(lambda (raised) (not (exn:break? raised)))
        (lambda (raised)
          (problem source field "~a" (if (exn? raised) (exn-message raised) (format "~e" raised))))])
    (proc)))

;; Copy literal data to an immutable, serialisable tree. Cyclic and executable
;; values cannot cross a provider boundary or live in a descriptor.
(define (literal value source field)
  (define active (make-hasheq))
  (define (walk v)
    (when (hash-ref active v #f) (problem source field "cyclic data"))
    (hash-set! active v #t)
    (define result
      (cond
        [(or (null? v) (boolean? v) (number? v) (char? v) (symbol? v) (keyword? v)
             (path? v) (regexp? v) (byte-regexp? v)) v]
        [(string? v) (string->immutable-string v)]
        [(bytes? v) (bytes->immutable-bytes v)]
        [(pair? v) (cons (walk (car v)) (walk (cdr v)))]
        [(vector? v) (vector->immutable-vector (list->vector (map walk (vector->list v))))]
        [(box? v) (box-immutable (walk (unbox v)))]
        [(hash? v) (for/fold ([result (hash-copy-clear v #:kind 'immutable)]) ([(k val) (in-hash v)])
                     (hash-set result (walk k) (walk val)))]
        [else (problem source field "expected literal data, received ~e" v)]))
    (hash-remove! active v)
    result)
  (walk value))

(define (relative-module module base)
  (match module
    [(? string?) `(file ,(path->string (simplify-path (path->complete-path module base))))]
    [(? path?) (simplify-path (path->complete-path module base))]
    [(list 'file (? path-string? file)) `(file ,(path->string (simplify-path (path->complete-path file base))))]
    [(list* 'submod parent children)
     (if (member parent '("." "..")) module `(submod ,(relative-module parent base) ,@children))]
    [_ module]))
(define (provider-ref value source field base)
  (match value
    [(vector (? module-path? module) (? symbol? export) data)
     (vector-immutable (relative-module module base) export (literal data source field))]
    [_ (problem source field "expected #(module-path export-symbol data), received ~e" value)]))

(define defaults
  (hasheq 'version 1 'match '() 'bootstrap 'auto 'source 'reader 'bindings 'expanded
          'debugger (hasheq 'expressions '(runtime-interaction identity)
                            'values '(runtime-print preview-fallback) 'steps 'expanded)
          'editor (hasheq 'body-mode 'policy 'expand? 'policy 'require-header? 'policy
                          'source-details 'auto 'declarations 'generic
                          'calls '(generic (triggers " " ")" "]"))
                          'completion '(expanded (triggers "(")) 'rename 'expanded-graph
                          'inlay-hints 'policy 'formatting 'policy)
          'macro-stepper (hasheq 'context 'auto 'hide-modules '() 'terms 'syntax)))

(define (validate-language-profile datum #:source [source 'profile]
                                   #:base [base (current-directory)] #:selection [selection #f])
  (define (ref v field) (provider-ref v source field base))
  (define (one args field)
    (unless (= (length args) 1) (problem source field "expected one value"))
    (car args))
  (define (choice v choices field)
    (unless (memq v choices) (problem source field "expected one of ~s, received ~e" choices v)) v)
  (define (extension v plain extended field)
    (match v
      [(== plain) v]
      [(list (== extended) p) (list extended (ref p field))]
      [_ (problem source field "expected ~s or (~s provider)" plain extended)]))
  (define (matches clauses)
    (for/list ([clause (in-list clauses)])
      (match clause
        [(list (and kind (or 'language 'reader)) (? module-path? module))
         (list kind (relative-module module base))]
        [(list 'variants (? module-path? modules) ...)
         (cons 'variants (map (lambda (m) (relative-module m base)) modules))]
        [_ (problem source 'match "invalid identity clause ~e" clause)])))
  (define (triggers args plain extended field)
    (unless (<= 1 (length args) 2) (problem source field "expected a value and optional triggers"))
    (define value (if extended (extension (car args) plain extended field)
                      (if (eq? (car args) plain) plain (ref (car args) field))))
    (define trigger
      (if (= (length args) 1)
          (cadr (hash-ref (hash-ref defaults 'editor) (if extended 'completion 'calls)))
          (match (cadr args)
            [(list 'triggers (? string? strings) ...) (cons 'triggers strings)]
            [_ (problem source field "expected (triggers string ...)")])))
    (list value trigger))
  (define (section fields initial prefix)
    (define seen (make-hasheq))
    (for/fold ([result initial]) ([entry (in-list fields)])
      (unless (and (list? entry) (pair? entry) (symbol? (car entry)))
        (problem source (or prefix 'profile) "malformed field ~e" entry))
      (define key (car entry))
      (define field (if prefix (string->symbol (format "~a.~a" prefix key)) key))
      (unless (hash-has-key? initial key) (problem source field "unknown field"))
      (when (hash-ref seen key #f) (problem source field "duplicate field"))
      (hash-set! seen key #t)
      (define args (cdr entry))
      (define value
        (case field
          [(debugger editor macro-stepper) (section args (hash-ref defaults key) key)]
          [(match) (matches args)]
          [(editor.calls) (triggers args 'generic #f field)]
          [(editor.completion) (triggers args 'expanded 'expanded+ field)]
          [else
           (define v (one args field))
           (case field
             [(version) (unless (eqv? v 1) (problem source field "unsupported version ~e" v)) 1]
             [(bootstrap) (extension v 'auto 'auto field)]
             [(source) (extension v 'reader 'reader+ field)]
             [(bindings debugger.steps) (extension v 'expanded 'expanded+ field)]
             [(debugger.expressions)
              (match v
                [(list 'runtime-interaction 'identity) v]
                [(list 'runtime-interaction p) (list 'runtime-interaction (ref p field))]
                [_ (problem source field "expected (runtime-interaction identity-or-provider)")])]
             [(debugger.values)
              (match v
                [(list 'runtime-print 'preview-fallback) v]
                [(list p 'preview-fallback) (list (ref p field) 'preview-fallback)]
                [_ (problem source field "expected (printer preview-fallback)")])]
             [(editor.body-mode) (choice v '(sexp non-sexp unknown) field)]
             [(editor.expand? editor.require-header?)
              (unless (boolean? v) (problem source field "expected Boolean")) v]
             [(editor.source-details) (choice v '(auto sexp shrubbery none) field)]
             [(editor.declarations) (if (eq? v 'generic) v (ref v field))]
             [(editor.rename) (extension v 'expanded-graph 'expanded-graph field)]
             [(editor.inlay-hints)
              (cond [(eq? v 'policy) v]
                    [(list? v) (map (lambda (p) (ref p field)) v)]
                    [else (problem source field "expected policy or a provider list")])]
             [(editor.formatting) (choice v '(policy off) field)]
             [(macro-stepper.context) (choice v '(auto module) field)]
             [(macro-stepper.terms) (if (eq? v 'syntax) v (ref v field))]
             [(macro-stepper.hide-modules)
              (unless (list? v) (problem source field "expected a selector list"))
              (for/list ([selector (in-list v)])
                (match selector
                  [(list 'module (? module-path? m)) (list 'module (relative-module m base))]
                  [(list 'collection (? symbol? c)) (list 'collection c)]
                  [_ (problem source field "invalid selector ~e" selector)]))])]))
      (hash-set result key value)))
  (unless (and (list? datum) (pair? datum) (eq? (car datum) 'profile))
    (problem source 'profile "expected (profile field ...)"))
  ;; Validate the entire descriptor before any optional provider can be called.
  (define result (section (cdr datum) defaults #f))
  (if (and selection (not (assq 'match (cdr datum))))
      (hash-set result 'match (list selection)) result))

(define (make-provider-request operation #:uri [uri #f] #:text [text #f]
                               #:reader [reader #f] #:language [language #f]
                               #:submodules [submodules '()] #:pre [pre #f] #:expanded [expanded #f]
                               #:phase [phase #f] #:space [space #f] #:position [position #f]
                               #:facts [facts (hasheq 'names '() 'families '() 'runtime '() 'sites '()
                                                       'declarations '() 'snapshot #f)]
                               #:cancelled? [cancelled? (lambda () #f)] #:hooks [hooks (hasheq)]
                               #:selection [selection #f])
  (hasheq 'operation operation 'uri uri 'text text 'reader reader 'language language
          'submodules submodules 'pre pre 'expanded expanded 'phase phase 'space space
          'position position 'facts facts 'cancelled? cancelled? 'hooks hooks 'selection selection))

(define (call-language-provider reference request #:source [source 'provider] #:field [field 'profile]
                                #:base [base (current-directory)])
  (at-field source field
    (lambda ()
      (define ref (provider-ref reference source field base))
      ;; Provider output belongs to diagnostics, never a protocol's stdout.
      ;; Reload the provider source while its dependencies use the compile cache.
      (define proc
        (parameterize ([current-output-port (current-error-port)]
                       [current-load/use-compiled
                        (let ([load (current-load/use-compiled)]
                              [paths (use-compiled-file-paths)])
                          (lambda (file expected)
                            (parameterize ([use-compiled-file-paths
                                            (if (equal? file (resolve-module-path (vector-ref ref 0) #f)) '() paths)])
                              (load file expected))))])
          (dynamic-require (vector-ref ref 0) (vector-ref ref 1))))
      (unless (and (procedure? proc) (procedure-arity-includes? proc 2))
        (problem source field "export must accept (request data)"))
      ;; Recovery can load language dependencies in a fresh namespace. Restrict
      ;; source loading to the provider load, preserving the caller's loader
      ;; and compilation cache while the provider runs.
      (parameterize ([current-output-port (current-error-port)])
        (let ([answer (proc request (vector-ref ref 2))]) answer)))))

(define (read-data path)
  (observe-file! path)
  (at-field path 'profile
    (lambda ()
      (call-with-default-reading-parameterization
        (lambda ()
          (parameterize ([read-accept-reader #f] [read-accept-lang #f] [read-accept-compiled #f])
            (define in ((current-language-adapter-open-input-file) path))
            (dynamic-wind void
              (lambda ()
                (define datum (read in))
                (unless (eof-object? (read in)) (problem path 'profile "expected exactly one datum"))
                datum)
              (lambda () (close-input-port in)))))))))

(define (language-adapter-workspace source [roots (current-language-adapter-roots)])
  (and (path? source)
       (for/fold ([owner #f]) ([root (in-list roots)])
         (define directory (path->directory-path (simplify-path (path->complete-path root))))
         (define file (simplify-path (path->complete-path source)))
         (if (and (<= (length (explode-path directory)) (length (explode-path file)))
                  (equal? (explode-path directory)
                          (take (explode-path file) (length (explode-path directory))))
                  (or (not owner) (> (length (explode-path directory)) (length (explode-path owner)))))
             directory owner))))

(define (resolve-language-adapter source #:text [captured-text #f] #:pre [given-pre #f]
                                  #:saved-identity [saved-identity #f]
                                  #:language [given-language #f] #:legacy-info [given-info #f]
                                  #:submodules [submodules '()]
                                  #:workspace [workspace (language-adapter-workspace source)]
                                  #:cwd [cwd #f] #:explicit [explicit #f]
                                  #:registry [registry #f]
                                  #:declare-bindings? [declare-bindings? #f]
                                  #:declare-editor? [declare-editor? #f])
  (define base
    (if (path? source) (or (path-only source) (current-directory))
        (or (current-load-relative-directory) (current-directory))))
  (define reads (make-hash))
  (define opened (make-hash))
  (define externals (make-log-receiver (current-logger) 'info 'cm-accomplice))
  (define parent (current-security-guard))
  ;; Retain only registered external reads, with their contents at open,
  ;; rather than labelling an earlier read with a later disk snapshot.
  (define guard
    (make-security-guard
     parent
     (lambda (_who file modes)
       (when (and file (memq 'read modes))
         (parameterize ([current-security-guard parent])
           (define full (simple-form-path file))
           (hash-ref! opened full (lambda () (file-fingerprint full))))))
     (lambda _ (void))))
  (define load (current-load/use-compiled))
  (define reader-guard (current-reader-guard))
  (parameterize ([current-load-relative-directory base]
                 [current-adapter-reads reads]
                 [current-security-guard guard]
                 [current-load/use-compiled
                  (lambda (file expected)
                    (when expected (observe-file! file opened))
                    ;; An implementation's own header is not a source wrapper.
                    (parameterize ([current-reader-guard reader-guard])
                      (load file expected)))]
                 [current-output-port (current-error-port)])
    (define bytes (and (not captured-text) (path? source) (file->bytes source)))
    (define compiled? (and bytes (>= (bytes-length bytes) 2) (bytes=? (subbytes bytes 0 2) #"#~")))
    (define text (or captured-text (and bytes (not compiled?) (bytes->string/utf-8 bytes #\uFFFD))))
    (define readers '())
    (define (resolve-identity module [children '()])
      (with-handlers ([exn:fail? (lambda (_) #f)])
        (resolve-module-path (relative-module module base)
                             (and (path? source)
                                  (if (null? children) source `(submod ,source ,@children))))))
    (define guard (current-reader-guard))
    (define (record-reader module)
      (define guarded (guard module))
      (observe-module! guarded opened)
      (set! readers
            (append readers (list (resolve-identity guarded))))
      guarded)
    (define (reader-info in)
      ;; read-language stops after #r when a leading #reader is found. Read
      ;; its module datum normally, leaving custom payloads to get-info.
      (define position (file-position in))
      (define encoded (string->bytes/utf-8 text))
      (and (>= position 2)
           (bytes=? (subbytes encoded (- position 2) position) #"#r")
           (regexp-try-match #rx"^eader" in)
           (let* ([module
                   (call-with-default-reading-parameterization
                     (lambda ()
                       (parameterize ([read-accept-reader #f] [read-accept-lang #f]
                                      [read-accept-compiled #f])
                         (read in))))]
                  [guarded (record-reader module)]
                  [get-info (dynamic-require guarded 'get-info (lambda () #f))])
             (observe-module! guarded opened)
             (and get-info
                  (let ([info (get-info in guarded #f #f #f)])
                    (unless (and (procedure? info) (procedure-arity-includes? info 2))
                      (problem source 'profile "get-info must return a two-argument procedure"))
                    info)))))
    (define info
      (and (not given-language) text
           (parameterize ([current-reader-guard record-reader])
             (define in (open-input-string text source))
             (port-count-lines! in)
             (at-field source 'profile
               (lambda () (read-language in (lambda () (reader-info in))))))))
    (set! readers (filter (lambda (reader) (and reader (module-declared? reader #f))) readers))
    (for ([reader (in-list readers)]) (observe-module! reader opened))
    (define outer-pre
      (or given-pre
          (and (not given-language) (or (not info) (pair? submodules))
               (let ([in (if compiled? (open-input-bytes bytes source)
                             (open-input-string (or text "") source))])
                 (port-count-lines! in)
                 (with-module-reading-parameterization
                   (lambda () (parameterize ([read-accept-compiled #t]) (read-syntax source in))))))))
    (define inherited-language #f)
    (define selected-submodules '())
    (define pre
      (let select ([form outer-pre] [chain submodules] [owner '()])
        (when (and (pair? submodules) (syntax? form))
          (match (syntax->datum form)
            [(list* (or 'module 'module*) _ (? module-path? lang) _)
             (set! inherited-language (resolve-identity lang owner))]
            [_ (void)]))
        (cond
          [(null? chain) (set! selected-submodules owner) form]
          [(and (syntax? form) (compiled-module-expression? (syntax-e form)))
           (set! selected-submodules submodules) form]
          [(syntax? form)
           (define child
             (let find ([forms (if (eq? (syntax-e (car (syntax->list form))) 'module+)
                                  (cddr (syntax->list form))
                                  (cdddr (or (syntax->list form) '(#f #f #f))))])
               (for/or ([body (in-list forms)])
                 (define parts (and (syntax? body) (syntax->list body)))
                 (and (pair? parts)
                      (case (syntax-e (car parts))
                        [(module module* module+)
                         (and (pair? (cdr parts)) (eq? (syntax-e (cadr parts)) (car chain)) body)]
                        [(begin #%module-begin #%plain-module-begin) (find (cdr parts))]
                        [else #f])))))
           ;; A declaration absent from the written body inherits its owner's
           ;; descriptor. Discovery never expands forms to look for children.
           (if child
               (select child (cdr chain) (append owner (list (car chain))))
               (begin (set! selected-submodules owner) form))]
          [else #f])))
    (define language-value
      (or given-language (and (null? selected-submodules) info (info 'module-language #f))
          (and (syntax? pre)
               (match (syntax->datum pre)
                 [(list* (or 'module 'module*) _ lang _) (and (module-path? lang) lang)] [_ #f]))
          (and (syntax? pre)
               (match (syntax->datum pre)
                 [(list* 'module* _ #f _) inherited-language]
                 [(list* 'module+ _ _) inherited-language]
                 [_ #f]))))
    (define language (if (syntax? language-value) (syntax->datum language-value) language-value))
    (define language-id
      (or (and language (resolve-identity language selected-submodules))
          (and saved-identity (hash-ref saved-identity 'language #f))))
    (define legacy
      (or (and (equal? submodules selected-submodules) given-info)
          (and (syntax? pre) (syntax-property pre 'module-language))
          (and (syntax? pre) (compiled-module-expression? (syntax-e pre))
               (module-compiled-language-info (syntax-e pre)))))
    (define selection (cond [language-id (list 'language language-id)]
                            [(pair? readers) (list 'reader (car readers))] [else #f]))
    (define request
      (make-provider-request 'profile #:uri (if (path? source) (url->string (path->url source)) source)
                             #:text text #:reader (and (pair? readers) readers) #:language language-id
                             #:submodules selected-submodules
                             #:pre (and (not compiled?) (syntax? pre)
                                        (not (compiled-module-expression? (syntax-e pre))) pre)
                             #:selection selection))
    (define (descriptor datum origin supplying)
      (define file (match origin [(list* 'submod (? path? file) _) file] [_ origin]))
      (define directory (if (path? file) (or (path-only file) base) base))
      (define (validate answer)
        (validate-language-profile answer #:source origin #:base directory #:selection supplying))
      (if (vector? datum)
          (let ([answer (call-language-provider datum request #:source origin #:base directory)])
            (observe-module! (relative-module (vector-ref datum 0) directory) opened)
            (and answer (validate answer)))
          (validate datum)))
    (define (matches? descriptor)
      (for/or ([clause (in-list (hash-ref descriptor 'match))])
        (define (same? module identity) (equal? (resolve-identity module) identity))
        (match clause
          [(list 'language m) (and language-id (same? m language-id))]
          [(list 'reader m) (for/or ([reader (in-list readers)]) (same? m reader))]
          [(list 'variants modules ...) (and language-id (ormap (lambda (m) (same? m language-id)) modules))])))
    (define (entries data origin)
      (unless (list? data) (problem origin 'profile "expected a list of profiles"))
      (define matching
        (for/list ([entry (in-list data)]
                   #:do [(define d (descriptor entry origin #f))]
                   #:when d
                   #:do [(when (null? (hash-ref d 'match)) (problem origin 'match "explicit match required"))]
                   #:when (matches? d)) d))
      (when (> (length matching) 1) (problem origin 'match "duplicate matching entries"))
      (and (pair? matching) (car matching)))
    (define project-file (and workspace (build-path workspace ".racketeer" "language-adapters.rktd")))
    (define chosen
      (or (and explicit
               (let ([file (simplify-path (path->complete-path explicit (or cwd workspace (current-directory))))])
                 (descriptor (read-data file) file #f)))
          (and project-file
               (begin
                 (observe-file! project-file)
                 (and (file-exists? project-file) (entries (read-data project-file) project-file))))
          (and (null? selected-submodules) info
               (let ([answer (at-field source 'profile (lambda () (info 'racketeer:language-profile #f)))])
                 ;; at-exp explicitly delegates this key. Other readers own
                 ;; their answers; an arbitrary wrapper is not presumed transparent.
                 (define owner
                   (let delegate ([chain readers])
                     (cond
                       [(null? chain) #f]
                       [(and (pair? (cdr chain))
                             (equal? (car chain) (resolve-module-path 'at-exp/lang/reader #f)))
                        (delegate (cdr chain))]
                       [else (car chain)])))
                 (and answer (descriptor answer (or owner source)
                                         (and owner (list 'reader owner))))))
          (and legacy
               (at-field source 'profile
                 (lambda ()
                   (define module (relative-module (vector-ref legacy 0) base))
                   (observe-module! module opened)
                   (define factory (dynamic-require module (vector-ref legacy 1)))
                   (observe-module! module opened)
                   (define get-info (factory (vector-ref legacy 2)))
                   (observe-module! module opened)
                   (define answer (get-info 'racketeer:language-profile #f))
                   (observe-module! module opened)
                   (and answer (descriptor answer (resolve-module-path module #f) selection)))))
          (entries (or registry (read-data registry-file)) registry-file)))
    (define result
      (if (not chosen) (validate-language-profile '(profile))
          (begin
            (when (or declare-bindings? declare-editor?)
              (define editor (hash-ref chosen 'editor))
              (for ([field '(bindings editor.declarations editor.calls)]
                    [reference (list (let ([value (hash-ref chosen 'bindings)])
                                       (and (pair? value) (cadr value)))
                                     (hash-ref editor 'declarations)
                                     (car (hash-ref editor 'calls)))])
                (when (and (vector? reference)
                           (if (eq? field 'bindings) declare-bindings? declare-editor?))
                  (at-field source field
                    (lambda () (dynamic-require (vector-ref reference 0) (void)))))))
            (let providers ([value chosen])
              (cond
                [(hash? value) (for-each providers (hash-values value))]
                [(pair? value) (providers (car value)) (providers (cdr value))]
                [(and (vector? value) (= (vector-length value) 3))
                 (define module (resolve-identity (vector-ref value 0)))
                 (when module (observe-module! module opened))]))
            (for ([reader (in-list readers)]) (observe-module! reader opened))
            (when language-id (observe-module! language-id opened))
            (for ([(file fingerprint) (in-hash opened)]
                  #:when (regexp-match? #rx#"[.]zo$" (path->bytes file))
                  ;; Native reading sometimes opens these two bootstrap modules'
                  ;; bytecode after their sources have already been observed.
                  ;; Their source hashes remain dependencies in either case.
                  #:unless (for/or ([module '(racket/base racket/private/base)])
                             (define source (resolve-module-path module #f))
                             (and (hash-ref reads source #f)
                                  (equal? file (get-compilation-bytecode-file
                                                source #:roots '(same) #:modes '("compiled"))))))
              (hash-ref! reads file (lambda () fingerprint)))
            (let drain ()
              (define event (sync/timeout 0 externals))
              (when event
                (define dependency (vector-ref event 2))
                (when (prefab-struct-key dependency)
                  (define file (vector-ref (struct->vector dependency) 1))
                  (when (path? file)
                    (define full (simple-form-path file))
                    (hash-ref! reads full (lambda () (hash-ref opened full 'changing)))))
                (drain)))
            (let ([files (sort (hash->list reads) path<? #:key car)])
              (for ([entry (in-list files)])
                ((current-language-adapter-file-observer) (car entry) (cdr entry))
                (when (cdr entry) (register-external-file (car entry))))
              (hash-set chosen 'fingerprint
                        (hasheq 'schema 1 'profile chosen 'readers readers
                                'language language-id 'submodules selected-submodules
                                'files files))))))
    (unless (language-adapter-current? result)
      (problem source 'profile "language adapter changed during selection"))
    ((current-language-adapter-observer) source result)
    result))
