'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { definition, uses, uri, edited, project } = require('./workspace-index-project');

test('export rename preserves explicit aliases and prefixes in unopened consumers', { timeout: 120000 }, async t => {
  const p = await project(t);
  const consumers = {
    'file-prefix.rkt': '#lang racket/base\n(require (prefix-in s: (file "definition.rkt")))\n(s:square 3)\n',
    'file-excluded.rkt': '#lang racket/base\n(require (except-in (file "definition.rkt") square))\n(display 9)\n',
    'file-selected.rkt': '#lang racket/base\n(require (only-in (file "definition.rkt") square))\n(square 3)\n',
    'alias.rkt': '#lang racket/base\n(require (rename-in "definition.rkt" [square sq]))\n(sq 3)\n',
    'same.rkt': '#lang racket/base\n(require (rename-in "definition.rkt" [square square]))\n(square 3)\n',
    'only.rkt': '#lang racket/base\n(require (only-in "definition.rkt" [square sq]))\n(sq 3)\n',
    'prefix.rkt': '#lang racket/base\n(require (prefix-in s: "definition.rkt"))\n(s:square 3)\n',
    'quoted.rkt': '#lang racket/base\n(require "definition.rkt")\n(square 3)\n(define data \'(only-in "definition.rkt" square))\n(define text "square")\n; square\n',
    'matching-prefix.rkt': '#lang racket/base\n(require (prefix-in square "definition.rkt"))\n(squaresquare 3)\n',
    'selected.rkt': '#lang racket/base\n(require (only-in "definition.rkt" square))\n(square 3)\n',
    'excluded.rkt': '#lang racket/base\n(require (except-in "definition.rkt" square))\n(display 9)\n'
  };
  for (const [file, text] of Object.entries(consumers)) p.write(file, text);
  await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.equal(edited(definition, changes[p.origin]), definition.replaceAll('square', 'squared'));
  assert.equal(edited(uses, changes[uri(p.filename('uses.rkt'))]), uses.replace('square', 'squared'));
  for (const [file, text] of Object.entries(consumers)) {
    const edits = changes[uri(p.filename(file))];
    assert.equal(edits.length, file.endsWith('selected.rkt') ? 2 : 1, file);
    const expected = file.endsWith('selected.rkt') ? text.replaceAll('square', 'squared')
      : file === 'matching-prefix.rkt' ? text.replace('squaresquare', 'squaresquared') : text.replace('square', 'squared');
    assert.equal(edited(text, edits), expected, file);
    assert.equal(fs.readFileSync(p.filename(file), 'utf8'), text, 'Preview leaves source untouched');
  }
  for (const [key, edits] of Object.entries(changes)) {
    const file = fileURLToPath(key);
    fs.writeFileSync(file, edited(fs.readFileSync(file, 'utf8'), edits));
  }
  for (const file of Object.keys(consumers)) {
    const result = spawnSync('racket', [p.filename(file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '9');
  }
});

test('renaming a local alias from its use leaves the exporting module unchanged', { timeout: 120000 }, async t => {
  const p = await project(t);
  for (const [spec, name, expression] of [
    ['(rename-in "definition.rkt" [square sq])', 'sq', '(sq 3)'],
    ['(rename-in "definition.rkt" [square square])', 'square', '(square 3)'],
    ['(only-in racket/list [first head])', 'head', "(head '(9))"]
  ]) {
    const text = `#lang racket/base\n(require ${spec})\n${expression}\n; ${name} is an alias\n'${name}\n\"${name}\"\n`;
    p.write('alias.rkt', text);
    const consumer = p.open('alias.rkt', text);
    await p.update();
    const { changes } = await p.rename(consumer, 'local-name', { line: 2, character: 2 });
    assert.deepEqual(Object.keys(changes), [consumer]);
    assert.equal(changes[consumer].length, 2);
    assert.equal(edited(text, changes[consumer]), text.replace(`${name}])`, 'local-name])').replace(`(${name} `, '(local-name '));
    assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
  }
});

test('prefixed use prepares only its base name and retains Unicode prefixes', { timeout: 120000 }, async t => {
  const p = await project(t);
  const text = '#lang racket/base\n(require (prefix-in π: (file "definition.rkt")))\n; 😀\n(π:square 3)\n';
  p.write('prefix.rkt', text);
  const consumer = p.open('prefix.rkt', text);
  await p.update();
  const position = { line: 3, character: 5 };
  assert.deepEqual(await p.rename(consumer, undefined, position), {
    start: { line: 3, character: 3 }, end: { line: 3, character: 9 }
  });
  const { changes } = await p.rename(consumer, '平方', position);
  assert.equal(edited(text, changes[consumer]), text.replace('π:square', 'π:平方'));
  assert.equal(edited(definition, changes[p.origin]), definition.replaceAll('square', '平方'));
});

test('alias and prefix renames retain capture checks and refuse unsupported transformations', { timeout: 120000 }, async t => {
  const p = await project(t);
  for (const [spec, body, target, name] of [
    ['(rename-in "definition.rkt" [square sq])', '(let ([result 1]) (sq result))', 'alias', 'result'],
    ['(prefix-in s: "definition.rkt")', '(let ([s:squared 1]) (s:square s:squared))', 'export', 'squared'],
    ['(prefix-in p: (rename-in "definition.rkt" [square sq]))', '(p:sq 3)', 'export', 'squared'],
    ['(prefix-in a: (prefix-in b: "definition.rkt"))', '(a:b:square 3)', 'export', 'squared'],
    ['(for-syntax racket/base (only-in "definition.rkt" square))', '(begin-for-syntax (square 3))', 'export', 'squared']
  ]) {
    const text = `#lang racket/base\n(require ${spec})\n${body}\n`;
    p.write('consumer.rkt', text);
    const consumer = p.open('consumer.rkt', text);
    await p.update();
    await assert.rejects(p.rename(target === 'alias' ? consumer : p.origin, name,
      target === 'alias' ? { line: 2, character: body.indexOf('(sq ') + 2 } : undefined), /another binding|Cannot analyse/);
    assert.equal(fs.readFileSync(p.filename('consumer.rkt'), 'utf8'), text);
  }
});

test('selectors shared by different export phases are refused without changing the snapshot', { timeout: 120000 }, async t => {
  const p = await project(t);
  for (const compileName of ['square', 'other']) {
    const provider = `#lang racket/base\n(require (for-syntax racket/base))\n(provide square (for-syntax (rename-out [${compileName} square])))\n(define (square x) (* x x))\n(begin-for-syntax (define (${compileName} x) (+ x 1)))\n`;
    const consumer = '#lang racket/base\n(require (only-in "definition.rkt" square))\n(square 3)\n';
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
  await assert.rejects(p.rename(p.origin, 'squared'), /another binding|Cannot analyse|unsupported|composed/);
  assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), consumer);
  const independent = '#lang racket/base\n(require "definition.rkt" (except-in (combine-in "other.rkt") square))\n(square 3)\n';
  p.write('uses.rkt', independent); await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  assert.equal(edited(independent, changes[uri(p.filename('uses.rkt'))]), independent.replace('(square 3)', '(squared 3)'));
});
