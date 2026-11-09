#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list
         racket/string
         racket/path
         racket/runtime-path
         syntax/modread
         racket-langserver/common/path-util
         racket-langserver/doclib/textbuffer/text-port)

(provide declarations calls completion)

;; Reader groups have no locations of their own. Concrete shrubbery tokens,
;; including delimiter tags, supply the extent of their enclosing declaration.
(define (shrub-parts stx)
  (or (and (syntax? stx) (syntax->list stx)) '()))
(define (shrub-tag stx)
  (define parts (shrub-parts stx))
  (and (pair? parts) (syntax-e (car parts))))
(define (shrub-children stx) (cdr (shrub-parts stx)))
(define (shrub-op? stx op)
  (and (eq? (shrub-tag stx) 'op)
       (equal? (syntax-e (cadr (shrub-parts stx))) op)))
(define (shrub-ranges pre text)
  (define ranges (make-hasheq))
  (define src (and pre (syntax-source pre)))
  (define (range s)
    (and (syntax? s)
         (hash-ref! ranges s
           (lambda ()
             (define position (syntax-position s))
             (define span (syntax-span s))
             (define own
               (and (syntax-original? s) (equal? src (syntax-source s))
                    position span (positive? span)
                    (<= (+ (sub1 position) span) (string-length text))
                    (cons (sub1 position) (+ (sub1 position) span))))
             (for/fold ([r own]) ([child (in-list (shrub-parts s))])
               (define cr (range child))
               (cond [(not r) cr] [(not cr) r]
                     [else (cons (min (car r) (car cr)) (max (cdr r) (cdr cr)))]))))))
  range)

(define (declarations request _data)
  (define text (hash-ref request 'text))
  (define pre (hash-ref request 'pre))
  (define facts (hash-ref request 'facts))
  (define cancelled? (hash-ref request 'cancelled?))
  (define range (shrub-ranges pre text))
  (define confirmed (make-hash))
  (define owners (make-hasheq))
  (define groups '())
  (define (index-groups s)
    (unless (eq? (shrub-tag s) 'quotes)
      (when (and (eq? (shrub-tag s) 'group) (range s))
        (set! groups (cons s groups)))
      (for-each index-groups (shrub-parts s))))
  (when pre (index-groups pre))
  (define pending
    (sort groups (lambda (a b)
                   (define ar (range a))
                   (define br (range b))
                   (or (< (car ar) (car br))
                       (and (= (car ar) (car br)) (> (cdr ar) (cdr br)))))))
  (define stack '())
  (for ([binding (in-list (sort (hash-ref facts 'bindings '()) <
                                #:key (lambda (b) (car (hash-ref b 'range)))))])
    (define selection (hash-ref binding 'range))
    (hash-set! confirmed selection #t)
    (let loop ()
      (when (and (pair? pending) (<= (car (range (car pending))) (car selection)))
        (set! stack (cons (car pending) stack))
        (set! pending (cdr pending))
        (loop)))
    (let loop ()
      (when (and (pair? stack) (< (cdr (range (car stack))) (cdr selection)))
        (set! stack (cdr stack))
        (loop)))
    (when (and (pair? stack) (hash-ref binding 'declaration? #f))
      (hash-update! owners (car stack) (lambda (bs) (cons binding bs)) '())))
  (define (binder terms)
    (cond [(null? terms) #f]
          [(eq? (syntax-e (car terms)) 'mutable) (binder (cdr terms))]
          [(keyword? (syntax-e (car terms)))
           (define block (findf (lambda (s) (eq? (shrub-tag s) 'block)) (cdr terms)))
           (if block (binder (shrub-children (car (shrub-children block)))) (car terms))]
          [(identifier? (car terms)) (car terms)]
          [else #f]))
  (define (written s)
    (define r (range s))
    (if r (string->immutable-string (substring text (car r) (cdr r))) ""))
  (define (annotation parts)
    (define tail (memf (lambda (s) (or (shrub-op? s '::) (shrub-op? s ':~))) parts))
    (if tail
        (let* ([terms (takef (cdr tail) (lambda (s) (not (or (shrub-op? s '=) (eq? (shrub-tag s) 'block)))))]
               [rs (filter-map range terms)])
          (if (null? rs) '() (list (string->immutable-string (substring text (caar rs) (cdar (reverse rs)))))))
        '()))
  (define (record name kind group children [parameters #f] [header '()] [name-start #f])
    (define nr (range name))
    (define selection (and nr (if (keyword? (syntax-e name)) (cons (add1 (car nr)) (cdr nr)) nr)))
    (define extent (range group))
    (define annotations (annotation header))
    (define start (or name-start (and selection (car selection))))
    (define parameter-groups
      (if (not parameters) '()
          (if (eq? kind 'operator)
              (append-map (lambda (g) (filter (lambda (s) (not (eq? (shrub-tag s) 'op)))
                                              (shrub-children g)))
                          (shrub-children parameters))
              (shrub-children parameters))))
    (define signatures
      (if parameters
          (list (hasheq 'label
                        (string->immutable-string
                         (substring text (if (eq? kind 'operator) (car (range parameters)) start)
                                    (cdr (range (last header)))))
                        'parameters (map (lambda (g)
                                           (define terms (if (eq? (shrub-tag g) 'group) (shrub-children g) (list g)))
                                           (define first (and (pair? terms) (car terms)))
                                           (hasheq 'label (written g)
                                                   'keyword (and first (keyword? (syntax-e first)) (syntax-e first))
                                                   'rest? (and first (shrub-op? first '&)))) parameter-groups))) '()))
    (and selection extent
         (hasheq 'name (string->immutable-string (substring text start (cdr selection))) 'kind kind 'selection selection 'range extent
                 'certainty (if (hash-ref confirmed selection #f)
                                'confirmed 'predicted)
                 'children children 'signatures signatures 'annotations annotations)))
  (define (group-declarations group)
    (define parts (dropf (shrub-children group)
                         (lambda (s) (memq (syntax-e s) '(private protected public final abstract override replace)))))
    (define head (and (pair? parts) (syntax-e (car parts))))
    (define parameters (findf (lambda (s) (eq? (shrub-tag s) 'parens)) parts))
    (define kind
      (case head
        [(def) (if (and (findf (lambda (s) (eq? (syntax-e s) 'fun)) parts) parameters) 'function 'variable)]
        [(fun) 'function] [(class) 'class] [(field) 'field] [(method) 'method]
        [(namespace) 'namespace] [(operator) 'operator] [(macro) 'macro]
        [else (and (>= (length parts) 3) (shrub-op? (cadr parts) '|.|)
                   (eq? (syntax-e (caddr parts)) 'macro) 'macro)]))
    (define name
      (cond
        [(eq? kind 'operator)
         (and parameters
              (for*/first ([g (in-list (shrub-children parameters))]
                           [term (in-list (shrub-children g))]
                           #:when (eq? (shrub-tag term) 'op))
                (cadr (shrub-parts term))))]
        [(eq? kind 'macro)
         (define quotes (findf (lambda (s) (eq? (shrub-tag s) 'quotes)) parts))
         (and quotes
              (for/or ([g (in-list (shrub-children quotes))])
                (let loop ([terms (shrub-children g)])
                  (cond [(null? terms) #f]
                        [(shrub-op? (car terms) '$) (and (pair? (cdr terms)) (loop (cddr terms)))]
                        [(identifier? (car terms)) (car terms)]
                        [(eq? (shrub-tag (car terms)) 'op) (cadr (shrub-parts (car terms)))]
                        [else (loop (cdr terms))]))))]
        [(and kind (pair? (cdr parts)) (binder (cdr parts)))
         (define first (binder (cdr parts)))
         (let loop ([terms (cdr (memq first parts))] [name first])
           (if (and (>= (length terms) 2) (shrub-op? (car terms) '|.|) (identifier? (cadr terms)))
               (loop (cddr terms) (cadr terms)) name))]
        [else #f]))
    (define initialiser (and (eq? head 'def) (memf (lambda (s) (shrub-op? s '=)) parts)))
    (define children
      (append-map walk
                  (if initialiser
                      (filter (lambda (s) (not (and (eq? kind 'function) (eq? s parameters))))
                              (cdr initialiser))
                      (filter (lambda (s) (eq? (shrub-tag s) 'block)) parts))))
    (define header (takef parts (lambda (s) (not (eq? (shrub-tag s) 'block)))))
    (define fields
      (if (and (eq? kind 'class) parameters)
          (filter-map
           (lambda (g)
             (define terms (shrub-children g))
             (define name (binder terms))
             (and name (record name 'field g '() #f terms)))
           (shrub-children parameters)) '()))
    (define known
      (and name (record name kind group (append fields children)
                        (and (memq kind '(function class method operator)) parameters) header
                        (and (not (memq kind '(operator macro)))
                             (let ([first (binder (cdr parts))])
                               (and first (not (keyword? (syntax-e first))) (car (range first))))))))
    (define alternatives (findf (lambda (s) (eq? (shrub-tag s) 'alts)) parts))
    (cond
      [known (list known)]
      [(and alternatives (memq kind '(function method operator)))
       (define clauses
         (append-map
          (lambda (block)
            (append-map
             (lambda (clause)
               (group-declarations
                (datum->syntax clause (cons (car (shrub-parts clause))
                                            (cons (car parts) (shrub-children clause))))))
             (shrub-children block)))
          (shrub-children alternatives)))
       (for/list ([same-name (in-list (group-by (lambda (d) (hash-ref d 'name)) clauses))])
         (hash-set* (car same-name) 'range (range group)
                    'signatures (append-map (lambda (d) (hash-ref d 'signatures)) same-name)
                    'annotations (remove-duplicates (append-map (lambda (d) (hash-ref d 'annotations)) same-name))
                    'children (append-map (lambda (d) (hash-ref d 'children)) same-name)))]
      [else
       ;; Binding metadata supplies names introduced by user-defined forms.
       ;; The smallest reader group containing the binder owns its extent.
       (define extent (range group))
       (define nested
         (append-map walk
                     (filter (lambda (s)
                               (and (not (eq? (shrub-tag s) 'block))
                                    (not (and initialiser (memq s (cdr initialiser))))
                                    (not (and (memq kind '(function method operator)) (eq? s parameters))))) parts)))
       (define additional (reverse (hash-ref owners group '())))
       (append
        (for/list ([same-range (in-list (group-by (lambda (b) (hash-ref b 'range)) additional))])
          (define selection (hash-ref (car same-range) 'range))
          (define kinds (remove-duplicates (map (lambda (b) (hash-ref b 'kind 'variable)) same-range)))
          (hasheq 'name (string->immutable-string (substring text (car selection) (cdr selection)))
                  'kind (if (= (length kinds) 1) (car kinds) 'variable) 'selection selection
                  'range extent 'children '() 'annotations '() 'signatures '() 'certainty 'confirmed))
        children nested)]))
  (define (walk s)
    (cond [(cancelled?) '()]
          [(eq? (shrub-tag s) 'quotes) '()]
          [(eq? (shrub-tag s) 'group) (group-declarations s)]
          [else (append-map walk (shrub-parts s))]))
  (if pre (walk pre) '()))

(define (calls request _data)
  (define pre (hash-ref request 'pre #f))
  (define text (hash-ref request 'text))
  (define pos (hash-ref request 'position #f))
  (define facts (hash-ref request 'facts))
  (cond
    [pre
     (define range (shrub-ranges pre text))
     (define found '())
     (define (walk s)
       (unless (or ((hash-ref request 'cancelled?)) (eq? (shrub-tag s) 'quotes))
         (when (eq? (shrub-tag s) 'group)
           (define terms (shrub-children s))
           (for ([callee (in-list terms)] [term (in-list (if (pair? terms) (cdr terms) '()))]
                 [i (in-naturals)]
                 #:when (and (eq? (shrub-tag term) 'parens) (identifier? callee)))
             (define cr (range callee))
             (define r (range term))
             (when (and cr r)
               (define start
                 (let loop ([index i])
                   (if (and (>= index 2) (shrub-op? (list-ref terms (sub1 index)) '|.|)
                            (identifier? (list-ref terms (- index 2))))
                       (loop (- index 2)) (car (range (list-ref terms index))))))
               (set! found
                     (cons (hasheq 'range r 'callee cr 'full-callee (cons start (cdr cr))
                                   'arguments
                                   (for/list ([arg (in-list (shrub-children term))])
                                     (define ts (shrub-children arg))
                                     (hasheq 'range (range arg)
                                             'keyword (and (pair? ts) (keyword? (syntax-e (car ts)))
                                                           (syntax-e (car ts)))))) found)))))
         (for-each walk (shrub-parts s))))
     (walk pre)
     (reverse found)]
    [else
     ;; Select syntax before asking the binding graph about its callee.
     (define call
       (for/fold ([best #f]) ([call (in-list (hash-ref facts 'calls '()))])
         (define r (hash-ref call 'range))
         (if (and (< (car r) pos (cdr r))
                  (or (not best) (<= (- (cdr r) (car r))
                                    (- (cdr (hash-ref best 'range)) (car (hash-ref best 'range)))))) call best)))
     (define cr (and call (hash-ref call 'callee)))
     (define declaration
       (and cr ((hash-ref (hash-ref request 'hooks) 'declaration-at) (car cr))))
     (and declaration (not (equal? cr (hash-ref declaration 'selection)))
          (let ()
            (define args (hash-ref call 'arguments))
            (define argument (count (lambda (a) (< (cdr (hash-ref a 'range)) pos)) args))
            (define active
              (if (zero? argument) 0
                  (if (string-contains? (substring text (cdr (hash-ref (list-ref args (sub1 argument)) 'range)) pos) ",")
                      argument (sub1 argument))))
            (define keyword (and (< active (length args)) (hash-ref (list-ref args active) 'keyword)))
            (define keywords (filter-map (lambda (a) (hash-ref a 'keyword)) args))
            (define positional-count (- (length args) (length keywords)))
            (define signatures (hash-ref declaration 'signatures '()))
            (define active-signature
              (or (for/first ([signature (in-list signatures)] [index (in-naturals)]
                              #:when
                              (let* ([ps (hash-ref signature 'parameters)]
                                     [ks (filter-map (lambda (p) (hash-ref p 'keyword #f)) ps)]
                                     [rest? (ormap (lambda (p) (hash-ref p 'rest? #f)) ps)]
                                     [n (- (length ps) (length ks) (if rest? 1 0))])
                                (and (andmap (lambda (k) (memq k ks)) keywords)
                                     (andmap (lambda (k) (memq k keywords)) ks)
                                     (if rest? (>= positional-count n) (= positional-count n))))) index) 0))
            (define parameters (if (null? signatures) '() (hash-ref (list-ref signatures active-signature) 'parameters)))
            (define parameter
              (if keyword
                  (for/first ([p (in-list parameters)] [i (in-naturals)]
                              #:when (eq? keyword (hash-ref p 'keyword #f))) i)
                  (let* ([indices (for/list ([p (in-list parameters)] [i (in-naturals)]
                                             #:unless (hash-ref p 'keyword #f)) i)]
                         [before (count (lambda (a) (not (hash-ref a 'keyword))) (take args active))]
                         [rest (for/first ([p (in-list parameters)] [i (in-naturals)]
                                           #:when (hash-ref p 'rest? #f)) i)])
                    (if (< before (length indices)) (list-ref indices before) rest))))
            (hasheq 'callee (hash-ref call 'full-callee) 'argument active 'signatures signatures
                    'active-signature active-signature 'active-parameter (or parameter active))))]))


(define-runtime-path completion-module "rhombus-completion.rkt")

;; Recovery runs for the requested access while analysis owns the document.
;; Queries select from the accepted immutable member facts for that revision.
(define (completion request _data)
  (define text (hash-ref request 'text))
  (define pos (hash-ref request 'position #f))
  (define cancelled? (hash-ref request 'cancelled? (lambda () (lambda () #f))))
  (define facts (hash-ref request 'facts (hasheq)))
  (define uri (hash-ref request 'uri))
  (define file (with-handlers ([exn:fail? (lambda (_) #f)]) (uri->path uri)))
  (define directory (and file (path-only file)))
  (define (recover start root-end dot member-start end)
    (define recovered
      (string-append (substring text 0 dot)
                     (list->string (for/list ([c (in-string text dot end)])
                                     (if (memv c '(#\newline #\return)) c #\space)))
                     (substring text end)))
    (define names
      (with-handlers ([exn:fail:syntax?
                       (lambda (e)
                         (or (for/or ([s (in-list (exn:fail:syntax-exprs e))])
                               (define d (syntax->datum s))
                               (and (list? d) (= (length d) 2) (eq? (car d) 'racketeer-members)
                                    (cadr d))) '()))])
        (parameterize ([current-namespace (make-base-namespace)]
                       [current-directory (if (and directory (directory-exists? directory)) directory (current-directory))]
                       [current-load-relative-directory directory]
                       [current-output-port (current-error-port)])
          (define head
            (syntax-binding-set->syntax
             (syntax-binding-set-extend (syntax-binding-set) 'members 0
                                       (module-path-index-join `(file ,(path->string completion-module)) #f))
             'members))
          (define pre
            (with-module-reading-parameterization
              (lambda () (read-syntax (or file uri) (open-input-text recovered)))))
          (define range (shrub-ranges pre recovered))
          (define (walk s)
            (define parts (shrub-parts s))
            (cond
              [(eq? (shrub-tag s) 'multi)
               (datum->syntax s
                 (cons (car parts)
                       (cons (datum->syntax #f
                               (list 'group
                                     (list 'parsed '#:rhombus/decl
                                           #`(#%require (file #,(path->string completion-module))))))
                             (map walk (cdr parts)))) s s)]
              [(and (eq? (shrub-tag s) 'group)
                    (for/or ([term (in-list (cdr parts))])
                      (define r (range term))
                      (and r (= (car r) start))))
               (define before (takef (cdr parts) (lambda (term)
                                                  (define r (range term))
                                                  (and r (< (car r) start)))))
               (define tail (drop (cdr parts) (length before)))
               (define-values (receiver after)
                 (splitf-at tail (lambda (term)
                                  (define r (range term))
                                  (and r (< (car r) dot)))))
               (datum->syntax s
                 (append (list (car parts)) before
                         (list (datum->syntax #f
                                 (list 'parsed '#:rhombus/expr
                                       #`(#,head #,(datum->syntax s (cons (car parts) receiver))))))
                         (map walk after)) s s)]
              [(null? parts) s]
              [else (datum->syntax s (map walk parts) s s)]))
          (expand (walk pre))
          '())))
    (hasheq 'items (for/list ([name (in-list names)]) (hasheq 'label name))
            'root-range (cons start root-end) 'range (cons member-start end)
            'incomplete? #f))
  (define (analyse)
    (define pre
      (or (hash-ref request 'pre #f)
          (with-module-reading-parameterization
            (lambda () (read-syntax (or file uri) (open-input-text text))))))
    (define range (shrub-ranges pre text))
    (define found '())
    (define (walk s)
      (unless (or (cancelled?) (eq? (shrub-tag s) 'quotes))
        (when (eq? (shrub-tag s) 'group)
          (define terms (shrub-children s))
          (for ([term (in-list terms)] [i (in-naturals)]
                #:when (and (positive? i) (shrub-op? term '|.|)
                            (identifier? (list-ref terms (sub1 i)))))
            (define dot (car (range term)))
            (define root-end (cdr (range (list-ref terms (sub1 i)))))
            (define start
              (let loop ([j (sub1 i)])
                (if (and (>= j 2) (shrub-op? (list-ref terms (sub1 j)) '|.|)
                         (identifier? (list-ref terms (- j 2))))
                    (loop (- j 2)) (car (range (list-ref terms j))))))
            (define member
              (and (< (add1 i) (length terms)) (identifier? (list-ref terms (add1 i)))
                   (range (list-ref terms (add1 i)))))
            (define member-start (if member (car member) (cdr (range term))))
            (define end
              (if member (cdr member)
                  (let loop ([end member-start])
                    (if (and (< end (string-length text)) (char-whitespace? (string-ref text end)))
                        (loop (add1 end)) end))))
            (when (and (not (cancelled?)) (<= member-start pos end))
              (set! found (cons (recover start root-end dot member-start end) found)))))
        (for-each walk (shrub-parts s))))
    (walk pre)
    (reverse found))
  (and (not (cancelled?))
       (let ([entries (hash-ref facts 'completion (lambda () (if pos (analyse) '())))])
         (if (not pos) entries
             (for/or ([entry (in-list entries)])
               (define r (hash-ref entry 'range))
               (and (<= (car r) pos (cdr r))
                    (let* ([gap? (for/and ([c (in-string text (car r) (cdr r))]) (char-whitespace? c))]
                           [prefix (if gap? "" (substring text (car r) pos))])
                      (hash-set* entry 'prefix prefix 'range (if gap? (cons pos pos) r)
                                 'items (filter (lambda (item) (string-prefix? (hash-ref item 'label) prefix))
                                                (hash-ref entry 'items))))))))))
