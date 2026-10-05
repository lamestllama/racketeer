#lang racket/base

(define-logger network)
(define-logger storage)

(define (sample-logs)
  (log-network-debug "DNS lookup started λ")
  (log-network-info "Connection opened")
  (log-network-warning "Retrying request")
  (log-storage-info "Cache opened")
  (log-storage-error "Example cache write failure"))

(sample-logs)
