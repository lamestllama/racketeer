'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { definition, uses, uri, edited, project } = require('./workspace-index-project');

function applyPreview(changes) {
  for (const [key, edits] of Object.entries(changes)) {
    const file = fileURLToPath(key);
    fs.writeFileSync(file, edited(fs.readFileSync(file, 'utf8'), edits));
  }
}

function evaluate(p, file) {
  const result = spawnSync('racket', [p.filename(file)], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '9');
}

test('export rename updates selectors outside composed standard imports', { timeout: 120000 }, async t => {
  const p = await project(t);
  const cases = {
    'selected.rkt': ['(only-in (prefix-in p: "definition.rkt") p:square)', '(p:square 3)'],
    'renamed.rkt': ['(rename-in (prefix-in p: "definition.rkt") [p:square local])', '(local 3)'],
    'excluded.rkt': ['(except-in (prefix-in p: "definition.rkt") p:square)', '(display 9)'],
    'combined.rkt': ['(only-in (combine-in "definition.rkt" racket/list) square)', '(square 3)']
  };
  for (const [file, [spec, body]] of Object.entries(cases)) p.write(file, `#lang racket/base\n(require ${spec})\n${body}\n`);
  await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  for (const [file, [spec, body]] of Object.entries(cases)) {
    const source = `#lang racket/base\n(require ${spec})\n${body}\n`;
    assert.equal(edited(source, changes[uri(p.filename(file))]), source.replaceAll('square', 'squared'), file);
    assert.equal(fs.readFileSync(p.filename(file), 'utf8'), source);
  }
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
  applyPreview(changes);
  for (const file of Object.keys(cases)) evaluate(p, file);
});

test('export rename follows phase-shifted uses and keeps their import selectors', { timeout: 120000 }, async t => {
  const p = await project(t);
  const source = '#lang racket/base\n(require (for-syntax racket/base (only-in "definition.rkt" square)))\n'
    + '(define-syntax (answer stx) (datum->syntax stx (square 3)))\n(answer)\n';
  const nested = '#lang racket/base\n(require (for-syntax racket/base))\n'
    + '(begin-for-syntax (require (prefix-in p: (only-in "definition.rkt" square))) (define value (p:square 3)))\n'
    + '(define-syntax (answer stx) (datum->syntax stx value))\n(answer)\n';
  p.write('phase.rkt', source); p.write('nested-phase.rkt', nested); await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.equal(edited(source, changes[uri(p.filename('phase.rkt'))]), source.replaceAll('square', 'squared'));
  assert.equal(fs.readFileSync(p.filename('phase.rkt'), 'utf8'), source);
  assert.equal(edited(nested, changes[uri(p.filename('nested-phase.rkt'))]), nested.replaceAll('square', 'squared'));
  assert.equal(fs.readFileSync(p.filename('nested-phase.rkt'), 'utf8'), nested);
  applyPreview(changes); evaluate(p, 'phase.rkt'); evaluate(p, 'nested-phase.rkt');
});

test('relative submodule selectors keep the identity of the selected submodule', { timeout: 120000 }, async t => {
  const p = await project(t);
  const source = '#lang racket/base\n(module inner racket/base\n  (provide square)\n  (define (square x) (* x x)))\n'
    + '(require (only-in (submod "." inner) square))\n(provide square)\n';
  p.write('definition.rkt', source); p.open('definition.rkt', source, 2); await p.update();
  const { changes } = await p.rename(p.origin, 'squared', { line: 3, character: 12 });
  assert.equal(edited(source, changes[p.origin]), source.replaceAll('square', 'squared'));
  assert.equal(edited(uses, changes[uri(p.filename('uses.rkt'))]), uses.replace('square', 'squared'));
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), source);
  applyPreview(changes); evaluate(p, 'uses.rkt');
});

test('local alias rename inside nested prefixes preserves prefixes and the exported name', { timeout: 120000 }, async t => {
  const p = await project(t);
  const source = '#lang racket/base\n(require (prefix-in π: (prefix-in λ: (rename-in "definition.rkt" [square sq]))))\n(π:λ:sq 3)\n';
  p.write('alias.rkt', source); const consumer = p.open('alias.rkt', source); await p.update();
  const position = { line: 2, character: 6 };
  assert.deepEqual(await p.rename(consumer, undefined, position), { start: { line: 2, character: 5 }, end: { line: 2, character: 7 } });
  const { changes } = await p.rename(consumer, 'area', position);
  assert.deepEqual(Object.keys(changes), [consumer]);
  assert.equal(edited(source, changes[consumer]), source.replace('[square sq]', '[square area]').replace('π:λ:sq', 'π:λ:area'));
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
  assert.equal(fs.readFileSync(p.filename('alias.rkt'), 'utf8'), source);
  applyPreview(changes); evaluate(p, 'alias.rkt');
});

test('relative sibling imports distinguish submodules with the same exported name', { timeout: 120000 }, async t => {
  const p = await project(t);
  const first = '(module first racket/base\n  (provide square)\n  (define (square x) (* x x)))\n';
  const other = '(module other racket/base\n  (provide square)\n  (define (square x) (+ x 1)))\n';
  const consumer = '(module consumer racket/base\n  (require (only-in (submod ".." first) square))\n  (provide result)\n  (define result (square 3)))\n';
  const source = `#lang racket/base\n${first}${other}${consumer}(require (submod "." consumer))\n(provide result)\n`;
  p.write('definition.rkt', source); p.open('definition.rkt', source, 2);
  p.write('uses.rkt', '#lang racket/base\n(require "definition.rkt")\nresult\n');
  await p.update();
  const { changes } = await p.rename(p.origin, 'squared', { line: 3, character: 12 });
  assert.deepEqual(Object.keys(changes), [p.origin]);
  assert.equal(edited(source, changes[p.origin]), source.replace(first, first.replaceAll('square', 'squared'))
    .replace(consumer, consumer.replaceAll('square', 'squared')));
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), source);
  applyPreview(changes); evaluate(p, 'uses.rkt');
});

test('renaming a compile-time definition preserves a same-named runtime binding', { timeout: 120000 }, async t => {
  const p = await project(t);
  const provider = '#lang racket/base\n(require (for-syntax racket/base))\n'
    + '(define (square x) (+ x 1))\n(begin-for-syntax (define (square x) (* x x)))\n'
    + '(provide (for-syntax square))\n';
  const consumer = '#lang racket/base\n(require "definition.rkt" (for-syntax racket/base))\n'
    + '(define-syntax (answer stx) (datum->syntax stx (square 3)))\n(answer)\n';
  p.write('definition.rkt', provider); p.open('definition.rkt', provider, 2);
  p.write('uses.rkt', consumer); await p.update();
  const { changes } = await p.rename(p.origin, 'squared', { line: 3, character: 28 });
  assert.equal(edited(provider, changes[p.origin]), provider.replace('(define (square x) (*', '(define (squared x) (*')
    .replace('(for-syntax square)', '(for-syntax squared)'));
  assert.equal(edited(consumer, changes[uri(p.filename('uses.rkt'))]), consumer.replace('(square 3)', '(squared 3)'));
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), provider);
  applyPreview(changes); evaluate(p, 'uses.rkt');
});

test('prefixed aliases of external definitions can be renamed locally', { timeout: 120000 }, async t => {
  const p = await project(t);
  const source = '#lang racket/base\n(require (prefix-in p: (only-in racket/list [first head])))\n(p:head \'(9))\n';
  p.write('alias.rkt', source); const consumer = p.open('alias.rkt', source); await p.update();
  const { changes } = await p.rename(consumer, 'front', { line: 2, character: 5 });
  assert.deepEqual(Object.keys(changes), [consumer]);
  assert.equal(edited(source, changes[consumer]), source.replace('first head', 'first front').replace('p:head', 'p:front'));
  assert.equal(fs.readFileSync(p.filename('alias.rkt'), 'utf8'), source);
  applyPreview(changes); evaluate(p, 'alias.rkt');
});

test('prefixed alias rename refuses lexical capture without changing files', { timeout: 120000 }, async t => {
  const p = await project(t);
  const source = '#lang racket/base\n(require (prefix-in p: (rename-in "definition.rkt" [square sq])))\n'
    + '(let ([p:area 3]) (p:sq p:area))\n';
  p.write('alias.rkt', source); const consumer = p.open('alias.rkt', source); await p.update();
  await assert.rejects(p.rename(consumer, 'area', { line: 2, character: 20 }), /another binding|Cannot analyse/);
  assert.equal(fs.readFileSync(p.filename('alias.rkt'), 'utf8'), source);
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
});
