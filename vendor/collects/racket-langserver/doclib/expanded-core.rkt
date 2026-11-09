#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(provide core-form code-parts provide-parts)

;; The core form a fully expanded form is: what its head is bound to at this phase.
;; Its spelling alone would misread quoted data, a variable in a list of formals, and
;; a core form imported under another name.
(define (core-form value phase)
  (define parts (syntax->list value))
  (define head (and (pair? parts) (car parts)))
  (define binding (and (identifier? head) (identifier-binding head phase)))
  (and (list? binding)
       (eq? '#%core (resolved-module-path-name (module-path-index-resolve (car binding))))
       (cadr binding)))

;; What in a fully expanded form is code, each part with its phase. A submodule
;; that names no language shares the phase numbering of the module around it.
(define (code-parts value phase)
  (define parts (syntax->list value))
  (case (core-form value phase)
    [(quote quote-syntax) '()]
    [(module module*)
     (define inner (if (syntax-e (caddr parts)) 0 phase))
     (for/list ([part (in-list (cdddr parts))]) (cons part inner))]
    [(begin-for-syntax) (for/list ([part (in-list (cdr parts))]) (cons part (add1 phase)))]
    [(define-syntaxes) (list (cons (cadr parts) phase) (cons (caddr parts) (add1 phase)))]
    [else (list (cons (syntax-e value) phase))]))

;; Select binding identifiers in expanded provide specs, retaining their phases
;; and structural anchors. Exported spellings are data.
(define (provide-parts spec phase [anchor '()])
  (cond
    [(identifier? spec) (list (list spec phase anchor))]
    [else
     (define parts (syntax->list spec))
     (if (not (pair? parts)) '()
         (case (syntax-e (car parts))
           [(rename) (list (list (cadr parts) phase anchor))]
           [(for-meta protect for-space)
            (define kind (syntax-e (car parts)))
            (define shift (if (eq? kind 'for-meta) (syntax-e (cadr parts)) 0))
            (apply append
                   (for/list ([part (in-list (if (eq? kind 'protect) (cdr parts) (cddr parts)))]
                              [i (in-naturals)])
                     (provide-parts part (and phase shift (+ phase shift)) (cons i anchor))))]
           [else '()]))]))
