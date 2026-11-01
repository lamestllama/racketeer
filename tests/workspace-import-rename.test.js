// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
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
  const text = '#lang racket/base\n(require (prefix-in π: (prefix-in λ: (file "definition.rkt"))))\n; 😀\n(π:λ:square 3)\n';
  p.write('prefix.rkt', uses);
  const consumer = p.open('prefix.rkt', text);
  await p.update();
  const position = { line: 3, character: 7 };
  assert.deepEqual(await p.rename(consumer, undefined, position), {
    start: { line: 3, character: 5 }, end: { line: 3, character: 11 }
  });
  const { changes } = await p.rename(consumer, '平方', position);
  assert.equal(edited(text, changes[consumer]), text.replace('π:λ:square', 'π:λ:平方'));
  assert.equal(edited(definition, changes[p.origin]), definition.replaceAll('square', '平方'));
  assert.equal(fs.readFileSync(p.filename('prefix.rkt'), 'utf8'), uses);
});

test('alias and prefix renames retain capture checks', { timeout: 120000 }, async t => {
  const p = await project(t);
  for (const [spec, body, target, name] of [
    ['(rename-in "definition.rkt" [square sq])', '(let ([result 1]) (sq result))', 'alias', 'result'],
    ['(prefix-in s: "definition.rkt")', '(let ([s:squared 1]) (s:square s:squared))', 'export', 'squared'],
    ['(prefix-in a: (prefix-in b: "definition.rkt"))', '(let ([a:b:squared 1]) (a:b:square a:b:squared))', 'export', 'squared']
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

test('export rename composes nested prefixes and preserves aliases inside prefixes', { timeout: 120000 }, async t => {
  const p = await project(t);
  const provider = definition.replace('(provide square)', '(provide square other)') + '(define other 1)\n';
  p.write('definition.rkt', provider); p.open('definition.rkt', provider, 2);
  const consumers = {
    'nested.rkt': ['(prefix-in a: (prefix-in b: "definition.rkt"))', '(a:b:square 3)', '(a:b:squared 3)'],
    'nested-file.rkt': ['(prefix-in π: (prefix-in square (file "definition.rkt")))', '(π:squaresquare 3)', '(π:squaresquared 3)'],
    'renamed-transformer.rkt': ['(only-in racket/base [prefix-in pfx]) (pfx a: (pfx b: "definition.rkt"))', '(a:b:square 3)', '(a:b:squared 3)'],
    'alias.rkt': ['(prefix-in p: (rename-in "definition.rkt" [square sq]))', '(p:sq 3)', '(p:sq 3)'],
    'same-alias.rkt': ['(prefix-in p: (rename-in "definition.rkt" [square square]))', '(p:square 3)', '(p:square 3)'],
    'selected-alias.rkt': ['(prefix-in p: (only-in (file "definition.rkt") [square sq]))', '(p:sq 3)', '(p:sq 3)'],
    'selected.rkt': ['(prefix-in p: (only-in "definition.rkt" square))', '(p:square 3)', '(p:squared 3)'],
    'excluded.rkt': ['(prefix-in p: (except-in (file "definition.rkt") square))', '(display 9)', '(display 9)'],
    'excluded-other.rkt': ['(prefix-in p: (except-in (file "definition.rkt") other))', '(p:square 3)', '(p:squared 3)'],
    'renamed-other.rkt': ['(prefix-in p: (rename-in (file "definition.rkt") [other spare]))', '(p:square 3)', '(p:squared 3)']
  };
  for (const [file, [spec, body]] of Object.entries(consumers)) {
    p.write(file, `#lang racket/base\n(require ${spec})\n${body}\n`);
  }
  await p.update();
  const { changes } = await p.rename(p.origin, 'squared');
  for (const [file, [spec, body, expectedBody]] of Object.entries(consumers)) {
    const expectedSpec = file.startsWith('nested') || file === 'renamed-transformer.rkt' ? spec : spec.replace('square', 'squared');
    const text = fs.readFileSync(p.filename(file), 'utf8');
    assert.equal(edited(text, changes[uri(p.filename(file))]), `#lang racket/base\n(require ${expectedSpec})\n${expectedBody}\n`, file);
    assert.equal(text, `#lang racket/base\n(require ${spec})\n${body}\n`);
  }
  for (const [key, edits] of Object.entries(changes)) {
    const file = fileURLToPath(key);
    fs.writeFileSync(file, edited(fs.readFileSync(file, 'utf8'), edits));
  }
  for (const file of Object.keys(consumers)) {
    const result = spawnSync('racket', [p.filename(file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '9', file);
  }
});
