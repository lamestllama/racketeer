#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

;; Use the same amalgam instance as the language so that portal and
;; static-info identities agree.
(require (for-syntax racket/base racket/list racket/string)
         (only-in "rhombus.rkt" completion)
         (submod rhombus/private/amalgam name-root)
         (submod rhombus/private/amalgam parse)
         (only-in rhombus/static [|.| static-dot] #%dynamism))
(provide members completion)

(define-syntax (members stx)
  (define root (cadr (syntax->list stx)))
  (define terms (cdr (syntax->list root)))
  (define first (car terms))
  (define (portal id)
    (define value (syntax-local-value (in-name-root-space id) (lambda () #f)))
    (and (portal-syntax? value) (portal-syntax-content value)))
  (define (portal-names content)
    (define parts (syntax->list content))
    (case (syntax-e (car parts))
      [(nspace) (map (lambda (entry) (syntax-e (car (syntax->list entry)))) (cdddr parts))]
      [else
       (define ctx (caddr parts))
       (remove-duplicates
        (append (syntax-bound-symbols ctx)
                (syntax-bound-symbols (in-name-root-space ctx))))]))
  (define root-id
    (dotted-binding-id (for/list ([term (in-list terms)] #:when (identifier? term)) term)
                       'rhombus/namespace))
  (define content (and root-id (portal root-id)))
  (define (exported? content name)
    (portal-syntax->lookup content
      (lambda (_self get)
        (define id (datum->syntax first name))
        (or (get #f #f id values) (get #f #f id in-name-root-space)))))
  (define names
    (cond
      [content (filter (lambda (name) (exported? content name)) (portal-names content))]
      [else
       ;; Namespace exports provide the candidate vocabulary. A static dot
       ;; provider must then accept each candidate for this exact receiver.
       ;; The generic dynamic lookup is explicitly disabled.
       (define seen (make-hasheq))
       (define (candidates-from content)
         (cond
           [(hash-ref seen content #f) '()]
           [else
            (hash-set! seen content #t)
            (define names (portal-names content))
            (append names
                    (append-map
                     (lambda (name)
                       (define id (exported? content name))
                       (define nested (and id (portal id)))
                       (if nested (candidates-from nested) '())) names))]))
       (define candidates
         (remove-duplicates
          (append-map
           (lambda (name)
             (define content (portal (datum->syntax first name)))
             (if content (candidates-from content) '()))
           (syntax-bound-symbols (in-name-root-space first)))))
       (define receiver (rhombus-local-expand #`(rhombus-expression #,root)))
       (filter
        (lambda (name)
          (with-handlers ([exn:fail:syntax?
                           (lambda (e)
                             ;; A method in static mode requires an argument
                             ;; list. That diagnostic still confirms its name.
                             (and (regexp-match? #rx"method must be called" (exn-message e))
                                  (for/or ([s (in-list (exn:fail:syntax-exprs e))])
                                    (eq? (syntax-e s) name))))])
            (rhombus-local-expand
             #`(rhombus-expression
                (group (parsed #:rhombus/expr #,receiver)
                       (op static-dot) #,(datum->syntax first name))))
            #t)) candidates)]))
  (define labels
    (sort (filter (lambda (name) (regexp-match? #px"^(?:\\p{L}|_)(?:\\p{L}|\\p{M}|\\p{Nd}|_)*$" name))
                  (map symbol->string names)) string<?))
  ;; End the recovery expansion here, including when the known list is empty.
  ;; The enclosing provider consumes only immutable strings from this marker.
  (raise-syntax-error 'completion "member information"
                      (datum->syntax #f (list 'racketeer-members labels))))
