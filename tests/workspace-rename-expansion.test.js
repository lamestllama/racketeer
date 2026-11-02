// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { uri, edited, project } = require('./workspace-index-project');

// Renames `square` from definition.rkt, then checks one consumer's edited text.
async function renamed(t, consumer) {
  const p = await project(t);
  p.write('consumer.rkt', consumer);
  await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  return edited(consumer, changes[uri(p.filename('consumer.rkt'))] || []);
}
const wholeWord = text => text.replace(/\bsquare\b/g, 'squared');

test('quoted data shaped like a core form leaves a rename whole', { timeout: 120000 }, async t => {
  const consumer = `#lang racket/base
(require "definition.rkt")
(define modules '(module module*))
(define short '(module))
(define phases '(begin-for-syntax define-syntaxes))
(define defined '(define-syntaxes))
(define nested '(a (module b) (define-syntaxes)))
(square 3)
`;
  assert.equal(await renamed(t, consumer), wholeWord(consumer));
});

test('variables named after core forms are variables', { timeout: 120000 }, async t => {
  const consumer = `#lang racket/base
(require "definition.rkt")
(define (one module) (square module))
(define (many module* a b c d) (square a))
(define (syntaxes define-syntaxes x) (square x))
(define (phase begin-for-syntax) (square begin-for-syntax))
(define (quoting quote x) (square x))
(define (template quote-syntax) (square quote-syntax))
(define (provided #%provide) (square #%provide))
(define (required #%require) (square #%require))
(let ([module 1]) (square module))
(let-values ([(module module*) (values 1 2)]) (square module))
(case-lambda [(module) (square module)] [(module x) (square x)])
`;
  assert.equal(await renamed(t, consumer), wholeWord(consumer));
});

test('a core form under another name is still that form', { timeout: 120000 }, async t => {
  const consumer = `#lang racket/base
(require (rename-in racket/base [quote q] [begin-for-syntax phase-up] [module mod])
         "definition.rkt"
         (for-syntax racket/base (only-in "definition.rkt" square)))
(define kept (q square))
(phase-up (define used (square 3)))
(mod inner racket/base
  (require "definition.rkt")
  (square 4))
`;
  assert.equal(await renamed(t, consumer), consumer
    .replace('(phase-up (define used (square 3)))', '(phase-up (define used (squared 3)))')
    .replace('(only-in "definition.rkt" square)', '(only-in "definition.rkt" squared)')
    .replace('(square 4)', '(squared 4)'));
});

test('a submodule that shares its enclosing phase is read at that phase', { timeout: 120000 }, async t => {
  const consumer = `#lang racket/base
(require (for-syntax racket/base "definition.rkt"))
(begin-for-syntax
  (module* inner #f
    (square 3)))
`;
  assert.equal(await renamed(t, consumer), wholeWord(consumer));
});

test('an import selecting from a primitive module leaves a rename whole', { timeout: 120000 }, async t => {
  const consumer = `#lang racket/base
(require "definition.rkt"
         (only-in '#%kernel [cons kons])
         (except-in '#%paramz exception-handler-key)
         (prefix-in k: (only-in '#%kernel car)))
(square (k:car (kons 3 4)))
`;
  assert.equal(await renamed(t, consumer), wholeWord(consumer));
});

test('a quoted name in an import is the file\'s own submodule', { timeout: 120000 }, async t => {
  const p = await project(t);
  const source = `#lang racket/base
(module inner racket/base
  (provide helper)
  (define (helper x) x))
(require (only-in 'inner helper))
(helper 3)
`;
  const key = p.open('quoted.rkt', source);
  p.write('quoted.rkt', source);
  await p.update();
  const { changes } = await p.rename(key, 'assist', { line: 3, character: 11 });
  assert.equal(edited(source, changes[key]), source.replaceAll('helper', 'assist'));
});

test('a selector over a quoted submodule name stays independent of another binding', { timeout: 120000 }, async t => {
  const consumer = `#lang racket/base
(module inner racket/base
  (provide square)
  (define (square x) x))
(module nested racket/base
  (require "definition.rkt")
  (square 1))
(require (only-in (submod 'inner) square))
(square 3)
`;
  const edited = await renamed(t, consumer);
  assert.equal(edited, consumer.replace('(square 1)', '(squared 1)'));
});

test('an import through a parent directory is the same module', { timeout: 120000 }, async t => {
  const p = await project(t);
  const consumer = `#lang racket/base
(require "../definition.rkt"
         (only-in "../definition.rkt" square)
         (prefix-in p: "../definition.rkt"))
(square 3)
(p:square 4)
`;
  require('node:fs').mkdirSync(p.filename('nested'));
  p.write('nested/consumer.rkt', consumer);
  await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.equal(edited(consumer, changes[uri(p.filename('nested/consumer.rkt'))] || []), wholeWord(consumer));
});
