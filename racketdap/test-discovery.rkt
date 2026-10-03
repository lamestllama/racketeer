#lang racket/base

(require racket/list racket/port racket/runtime-path file/sha1)
(provide discover-tests test-source-hash wrap-discovered-tests)

(define (test-source-hash text) (sha1 (open-input-string text)))

;; Read only the standard Racket datum grammar. Never load a project's reader,
;; expand its macros, or instantiate its modules during editor discovery.
;; A false result leaves the file with the ordinary whole-module runner.
(define (discover-tests text)
  (let/ec unsupported
    (define (reject) (unsupported #f))
    (with-handlers ([exn:fail:read? (lambda (_) (reject))])
      (define in (open-input-string text))
      (port-count-lines! in)
      (define header (read-line in 'any))
      (unless (and (string? header)
                   (regexp-match? #px"^#lang[ \t]+racket(?:/base)?[ \t]*(?:;[^\r\n]*)?$" header))
        (reject))
      (define forms
        (parameterize ([read-accept-reader #f] [read-accept-lang #f]
                       [read-accept-compiled #f] [read-accept-graph #f])
          (port->list (lambda (in) (read-syntax #f in)) in)))
      (define (parts form) (or (syntax->list form) (reject)))
      (define (head form) (define xs (parts form)) (and (pair? xs) (syntax-e (car xs))))
      (define (flatten forms)
        (append-map (lambda (form) (if (eq? (head form) 'begin)
                                      (flatten (cdr (parts form))) (list form))) forms))
      (define roots (flatten forms))
      (define submodules
        (filter (lambda (form)
                  (define xs (parts form))
                  (and (memq (head form) '(module+ module module*))
                       (>= (length xs) 2) (eq? (syntax-e (cadr xs)) 'test))) roots))
      (define (setup? form)
        (memq (head form) '(require provide define define-values define-runtime-path
                           module module* module+)))
      (define body
        (cond
          [(null? submodules) roots]
          [(andmap (lambda (s) (eq? (head s) 'module+)) submodules)
           (unless (andmap setup? roots) (reject))
           (flatten (append-map (lambda (s) (cddr (parts s))) submodules))]
          [(= (length submodules) 1)
           (define xs (parts (car submodules)))
           (unless (>= (length xs) 4) (reject))
           (define language (syntax-e (caddr xs)))
           (unless (or (memq language '(racket racket/base))
                       (and (eq? (head (car submodules)) 'module*) (not language)))
             (reject))
           (when (not language) (unless (andmap setup? roots) (reject)))
           (flatten (cdddr xs))]
          [else (reject)]))
      (for/list ([form (in-list body)] #:unless (setup? form))
        (define xs (parts form))
        ;; A suite is one selectable invocation. Its own runner retains control
        ;; of nested tests and fixtures; discovery never constructs the suite.
        (define name
          (cond
            [(and (eq? (head form) 'test-case) (>= (length xs) 3)) (cadr xs)]
            [(and (eq? (head form) 'run-tests) (memv (length xs) '(2 3)))
             (define suite (parts (cadr xs)))
             (unless (and (>= (length suite) 2) (eq? (head (cadr xs)) 'test-suite))
               (reject))
             (cadr suite)]
            [else (reject)]))
        (unless (string? (syntax-e name)) (reject))
        (hasheq 'id (syntax-position form) 'name (syntax-e name)
                'position (syntax-position form) 'span (syntax-span form))))))

(define-runtime-path test-case-path "worker/test-case.rkt")

;; Introduced names have explicit bindings and fresh symbols. Project bindings
;; cannot capture them, including in independently loaded test submodules.
(define (wrap-discovered-tests form discovered-tests selected?)
  (define positions
    (for/hasheqv ([test (in-list discovered-tests)]) (values (hash-ref test 'id) #t)))
  (define (walk form)
    (cond
      [(and (syntax? form)
            (hash-has-key? positions (syntax-position form)))
       (define bindings (syntax-binding-set))
       (define (fresh id)
         (define name (gensym (syntax-e id)))
         (define binding (identifier-binding id))
         (set! bindings (syntax-binding-set-extend bindings name 0 (car binding)
                         #:source-symbol (cadr binding)))
         name)
       (define let-id (fresh #'let))
       (define require-id (fresh #'local-require))
       (define only-id (fresh #'only-in))
       (define file-id (fresh #'file))
       (define wrapper (gensym 'test-case))
       (syntax-binding-set->syntax bindings
         `(,let-id ()
            (,require-id (,only-id (,file-id ,(path->string test-case-path))
                                  [discovered-test-case ,wrapper]))
            (,wrapper ,(syntax-position form) ,selected? ,form)))]
      [(syntax? form) (datum->syntax form (walk (syntax-e form)) form form)]
      [(pair? form) (cons (walk (car form)) (walk (cdr form)))]
      [else form]))
  (walk form))

(module+ main
  (require json "source.rkt")
  (define text (port->string))
  (define source (capture-source #f 0 #:text text))
  (write-json
   (for/list ([test (in-list (or (discover-tests text) '()))])
     (define-values (line column) (source-location source (hash-ref test 'position) #f))
     (define-values (end-line end-column)
       (source-location source (+ (hash-ref test 'position) (hash-ref test 'span)) #f))
     (hash-set* test 'line line 'column column 'endLine end-line 'endColumn end-column))))
