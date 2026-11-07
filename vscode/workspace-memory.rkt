#lang racket/base
;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT

(require racket/file racket/list racket/path racket/string)
(provide available-memory-bytes worker-memory-bytes)

(define (file-number path)
  (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
    (define n (string->number (string-trim (file->string path))))
    (and (exact-nonnegative-integer? n) n)))

;; Check each ancestor: a child can have no explicit limit while its parent does.
(define (group-remaining root member limit-name used-name)
  (define boundary (path->directory-path (simple-form-path root)))
  (define directory
    (path->directory-path (simplify-path (build-path boundary (string->path (string-append "." member))))))
  (define relative (find-relative-path boundary directory))
  (and (relative-path? relative) (not (memq 'up (explode-path relative)))
       (let walk ([directory directory])
         (define limit (file-number (build-path directory limit-name)))
         (define used (file-number (build-path directory used-name)))
         (define here (and limit used (max 0 (- limit used))))
         (define above
           (and (not (equal? directory boundary))
                (walk (path->directory-path (simplify-path (build-path directory 'up))))))
         (cond [(and here above) (min here above)] [else (or here above)]))))

;; Unknown platforms or unreadable counters retain the processor-based fallback.
;; Optional paths let tests exercise both cgroup layouts without changing the host.
(define (available-memory-bytes [meminfo "/proc/meminfo"]
                                [membership "/proc/self/cgroup"]
                                [mount "/sys/fs/cgroup"])
  (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
    (define match (regexp-match #px"(?m:^MemAvailable:[ \t]+([0-9]+)[ \t]+kB)" (file->string meminfo)))
    (define host (and match (* 1024 (string->number (cadr match)))))
    (define groups
      (with-handlers ([exn:fail:filesystem? (lambda (_) '())])
        (for/list ([line (in-list (file->lines membership))]
                   #:do [(define fields (string-split line ":" #:trim? #f))]
                   #:when (= (length fields) 3))
          (define controllers (string-split (cadr fields) ","))
          (cond
            [(equal? (car fields) "0")
             (group-remaining (simple-form-path mount) (caddr fields) "memory.max" "memory.current")]
            [(member "memory" controllers)
             (group-remaining (simple-form-path (build-path mount "memory")) (caddr fields)
                              "memory.limit_in_bytes" "memory.usage_in_bytes")]
            [else #f]))))
    (define known (filter exact-nonnegative-integer? (cons host groups)))
    (and (pair? known) (apply min known))))

;; Resident memory also includes compiled code and pages retained by the runtime.
;; Elsewhere, managed memory still bounds the state retained between requests.
(define (worker-memory-bytes)
  (or (with-handlers ([exn:fail:filesystem? (lambda (_) #f)])
        (define match (regexp-match #px"(?m:^VmRSS:[ \t]+([0-9]+)[ \t]+kB)" (file->string "/proc/self/status")))
        (and match (* 1024 (string->number (cadr match)))))
      (current-memory-use)))
