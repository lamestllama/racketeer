// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Loads a changed Racket module from memory in a fresh module registry.
'use strict';
const path = require('node:path');
const { root } = require('./macro-common');
function racketOverride(file, source, body) {
  return `#lang racket/base
(require racket/path)
(define target (string->path ${JSON.stringify(path.join(root, file))}))
(define changed ${JSON.stringify(source)})
(define ns (make-base-namespace))
(define original-load (current-load/use-compiled))
(parameterize ([current-namespace ns]
               [current-load/use-compiled
                (lambda (file name)
                  (if (equal? (simplify-path file) target)
                      (parameterize ([read-accept-reader #t] [current-load-relative-directory (path-only target)]
                                     [current-module-declare-name (make-resolved-module-path target)])
                        (eval (read-syntax file (open-input-string changed)) ns))
                      (original-load file name)))])
  ${body})
`;
}
function workerOverride(file, source) {
  return racketOverride(file, source, `(define read-request (dynamic-require 'json 'read-json))
    (define run (dynamic-require '(file ${JSON.stringify(path.join(root, 'racketdap/tools/macro-steps/session.rkt'))}) 'run-worker))
    (run (read-request))`);
}
module.exports = { racketOverride, workerOverride };
