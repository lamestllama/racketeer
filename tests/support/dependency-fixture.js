'use strict';
const fs = require('node:fs'), path = require('node:path');
function dependencyFixture(root) {
  const files = {
    'main λ😀.rkt': `#lang racket/base
(require "runtime.rkt" "bridge.rkt" (for-syntax "compile.rkt") (for-meta 2 "compile.rkt") (for-label racket/list))
(selected)
(module inner racket/base (provide value) (define value 7))
(module+ test (require (submod ".." inner)) (displayln value))
(call-with-output-file "executed" (lambda (out) (display "main" out)))
`,
    'runtime.rkt': '#lang racket/base\n(provide runtime)\n(define runtime 1)\n(call-with-output-file "executed" (lambda (out) (display "runtime" out)))\n',
    'compile.rkt': '#lang racket/base\n(provide compile-value)\n(define compile-value 2)\n',
    'selector.rkt': '#lang racket/base\n(provide target)\n(define target "old.rkt")\n',
    'bridge.rkt': '#lang racket/base\n(require (for-syntax racket/base "selector.rkt"))\n(provide selected)\n(define-syntax (selected stx) (datum->syntax stx `(require ,target)))\n',
    'old.rkt': '#lang racket/base\n(provide old)\n(define old 1)\n',
    'new.rkt': '#lang racket/base\n(provide new)\n(define new 2)\n'
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return { file: path.join(root, 'main λ😀.rkt'), selector: path.join(root, 'selector.rkt'),
    replacement: files['selector.rkt'].replace('old.rkt', 'new.rkt'), files };
}
module.exports = { dependencyFixture };
