// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { definition, uri, edited, project } = require('./workspace-index-project');

test('selectors shared by different export phases are refused without changing the snapshot', { timeout: 120000 }, async t => {
  const p = await project(t);
  for (const compileName of ['square', 'other']) {
    const provider = `#lang racket/base\n(require (for-syntax racket/base))\n(provide square (for-syntax (rename-out [${compileName} square])))\n(define (square x) (* x x))\n(begin-for-syntax (define (${compileName} x) (+ x 1)))\n`;
    const consumer = '#lang racket/base\n(require (prefix-in p: (only-in "definition.rkt" square)))\n(p:square 3)\n';
    p.write('definition.rkt', provider); p.open('definition.rkt', provider, 2);
    p.write('uses.rkt', consumer); await p.update();
    await assert.rejects(p.rename(p.origin, 'squared', { line: 3, character: 10 }), /more than one phase or binding space/);
    assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), provider);
    assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), consumer);
  }
});

test('an import selector is not confused with a hidden definition of the same name', { timeout: 120000 }, async t => {
  const p = await project(t);
  const provider = '#lang racket/base\n(provide (rename-out [other square] [third squared]))\n(define (square x) (* x x))\n(define (other x) x)\n(define (third x) x)\n(error "Rename must not run this module body")\n';
  const consumer = '#lang racket/base\n(require (only-in "definition.rkt" square))\n';
  p.write('definition.rkt', provider); p.open('definition.rkt', provider, 2);
  p.write('uses.rkt', consumer); await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.deepEqual(Object.keys(changes), [p.origin]);
  assert.equal(edited(provider, changes[p.origin]), provider.replace('(square x)', '(squared x)'));
});

test('selective imports retain submodule identity', { timeout: 120000 }, async t => {
  const p = await project(t);
  const provider = '#lang racket/base\n(module inner racket/base\n  (provide square)\n  (define (square x) (* x x)))\n';
  const consumer = '#lang racket/base\n(require (only-in (submod "definition.rkt" inner) square))\n(square 3)\n';
  p.write('definition.rkt', provider); p.open('definition.rkt', provider, 2);
  p.write('uses.rkt', consumer); await p.update();
  const { changes } = await p.rename(p.origin, 'squared', { line: 3, character: 12 });
  assert.equal(edited(provider, changes[p.origin]), provider.replaceAll('square', 'squared'));
  assert.equal(edited(consumer, changes[uri(p.filename('uses.rkt'))]), consumer.replaceAll('square', 'squared'));
  for (const [key, edits] of Object.entries(changes)) {
    fs.writeFileSync(fileURLToPath(key), edited(fs.readFileSync(fileURLToPath(key), 'utf8'), edits));
  }
  const result = spawnSync('racket', [p.filename('uses.rkt')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '9');
});

test('composed selectors shared by different modules are refused', { timeout: 120000 }, async t => {
  const p = await project(t);
  p.write('other.rkt', '#lang racket/base\n(provide square)\n(define square 3)\n');
  const consumer = '#lang racket/base\n(require (except-in (combine-in "definition.rkt" "other.rkt") square))\n';
  p.write('uses.rkt', consumer); await p.update();
  await assert.rejects(p.rename(p.origin, 'squared'), /more than one binding/);
  assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), consumer);
  const independent = '#lang racket/base\n(require "definition.rkt" (except-in (combine-in "other.rkt") square))\n(square 3)\n';
  p.write('uses.rkt', independent); await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.equal(edited(independent, changes[uri(p.filename('uses.rkt'))]), independent.replace('(square 3)', '(squared 3)'));
});

test('nested import discovery does not interpret a custom transformer or quoted data', { timeout: 120000 }, async t => {
  const p = await project(t);
  const text = '#lang racket/base\n(require (only-in racket/base [prefix-in standard-prefix])\n'
    + '         (for-syntax racket/base racket/require-transform))\n'
    + '(define-syntax prefix-in (make-require-transformer\n'
    + '  (lambda (stx) (syntax-case stx () [(_ ignored spec) (expand-import #\'spec)]))))\n'
    + '(require (standard-prefix a: (prefix-in b: "definition.rkt")))\n(a:square 3)\n';
  p.write('consumer.rkt', text); await p.update();
  await assert.rejects(p.rename(p.origin, 'squared'), /custom import transformer/);
  assert.equal(fs.readFileSync(p.filename('consumer.rkt'), 'utf8'), text);
  const quoted = '#lang racket/base\n(require (prefix-in a: (prefix-in b: "definition.rkt")))\n'
    + '(a:b:square 3)\n\'(prefix-in a: (only-in "definition.rkt" square))\n'
    + '(define template #\'(only-in "definition.rkt" square))\n'
    + '(define incomplete-template #\'(prefix-in p:))\n';
  p.write('consumer.rkt', quoted); await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.equal(edited(quoted, changes[uri(p.filename('consumer.rkt'))]), quoted.replace('(a:b:square 3)', '(a:b:squared 3)'));
});
