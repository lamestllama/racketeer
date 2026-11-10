#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/list syntax/kerncase)
(provide rename)

(define (scan request)
  (define exports '())
  (define (provide-part part phase space)
    (define (record local public)
      (define owner (hasheq 'identifier local 'phase phase 'space space))
      (set! exports (cons (hasheq 'name (syntax-e public) 'public public
                                  'interface owner 'owners (list owner)) exports)))
    (cond [(identifier? part) (record part part)]
          [else
           (define parts (syntax->list part))
           (case (syntax-e (car parts))
             [(rename) (record (cadr parts) (caddr parts))]
             [(protect) (for ([p (in-list (cdr parts))]) (provide-part p phase space))]
             [(for-meta for-space)
              (define meta? (eq? (syntax-e (car parts)) 'for-meta))
              (define shift (syntax-e (cadr parts)))
              (for ([p (in-list (cddr parts))])
                (provide-part p (if meta? (and phase shift (+ phase shift)) phase)
                              (if meta? space shift)))]
             [else (error 'rename "Cannot establish the public interface.")])]))
  (define (walk value phase)
    (cond [(syntax? value)
           (kernel-syntax-case/phase value phase
             [(quote . _) (void)]
             [(quote-syntax . _) (void)]
             [(#%provide p ...) (for ([p (in-list (syntax->list #'(p ...)))]) (provide-part p phase #f))]
             [(#%require . _) (void)]
             [(module name lang body ...) (walk #'(body ...) 0)]
             [(module* name lang body ...) (walk #'(body ...) (if (syntax-e #'lang) 0 phase))]
             [(begin-for-syntax body ...) (walk #'(body ...) (add1 phase))]
             [(define-syntaxes ids rhs) (walk #'rhs (add1 phase))]
             [_ (unless (identifier? value) (walk (syntax-e value) phase))])]
          [(pair? value) (walk (car value) phase) (walk (cdr value) phase)]))
  (walk (hash-ref request 'expanded) 0)
  (hasheq 'names '() 'computed? #f 'exports (reverse exports)))

(define (rename request level)
  (cond [(eq? (hash-ref request 'stage) 'scan) (scan request)]
        [else
         (define module
           (case level [(bsl) 'lang/htdp-beginner]
             [(bsl+) 'lang/htdp-beginner-abbr]
             [(isl) 'lang/htdp-intermediate]
             [(isl+) 'lang/htdp-intermediate-lambda]
             [(asl) 'lang/htdp-advanced]
             [else (error 'rename "Unknown teaching level: ~a" level)]))
         (dynamic-require module #f)
         (define-values (_ forms) (module->exports module))
         (define reserved (append* (map (lambda (g) (map car (cdr g))) forms)))
         (define new (hash-ref request 'new-name))
         (define valid?
           (or (not new)
               (and (not (memq (string->symbol new) reserved))
                    (with-handlers ([exn:fail? (lambda (_) #f)])
                      (parameterize ([read-accept-reader #f] [read-accept-lang #f]
                                     [read-accept-dot #f] [read-accept-quasiquote #f])
                        (define in (open-input-string new))
                        (port-count-lines! in)
                        (define id (read-syntax #f in))
                        (and (identifier? id) (= (syntax-position id) 1)
                             (= (syntax-span id) (string-length new)) (eof-object? (read in))))))))
         (define target (hash-ref request 'target))
         (define range (hash-ref target 'range))
         (define old (and range (substring (hash-ref request 'text) (car range) (cdr range))))
         (define (same? a b)
           (or (and (hash-ref a 'binding #f) (equal? (hash-ref a 'binding) (hash-ref b 'binding #f)))
               (free-identifier=? (hash-ref a 'identifier) (hash-ref b 'identifier) 0)))
         (define family
           (findf (lambda (f)
                    (for*/or ([a (in-list (hash-ref f 'members))]
                              [b (in-list (hash-ref target 'names))]) (same? a b)))
                  (hash-ref target 'families)))
         ;; A family connects generated procedures, not their separately written
         ;; components. Scoped identity and spelling cannot separate declarations
         ;; when two components in that family have the same written name.
         (define declarations
           (remove-duplicates
            (for/list ([name (in-list (hash-ref (hash-ref request 'facts (hasheq)) 'names '()))]
                       #:when (and (eq? (hash-ref name 'role) 'definition)
                                   (if family
                                       (ormap (lambda (m) (same? name m)) (hash-ref family 'members))
                                       (ormap (lambda (m) (same? name m)) (hash-ref target 'names))))
                       #:do [(define uri (hash-ref name 'uri (hash-ref request 'uri)))
                             (define text (hash-ref (hash-ref request 'sources) uri))
                             (define r (hash-ref name 'range))]
                       #:when (equal? old (substring text (car r) (cdr r))))
              (cons uri r))))
         (define ambiguous? (> (length declarations) 1))
         (hasheq 'valid? valid? 'complete? (not ambiguous?)
                 'reason (cond [ambiguous? "Cannot distinguish separately written components with the same scoped identity or spelling."]
                               [(not valid?) "Enter one non-reserved teaching identifier."]
                               [else #f]))]))
