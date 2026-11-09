// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }));
const { definition, uses, uri, edited, project } = require('./workspace-index-project');

test('workspace rename follows imports and previews edits without changing files', async t => {
  const p = await project(t), consumer = p.open('uses.rkt', uses);
  const untouched = '#lang racket/base\n(define (square x) (+ x 1))\n(square 3)\n';
  p.write('unrelated.rkt', untouched); await p.update();
  const position = { line: 2, character: 2 };
  assert.deepEqual(await p.rename(consumer, undefined, position), {
    start: { line: 2, character: 1 }, end: { line: 2, character: 7 }
  });
  assert.deepEqual((await p.rename(consumer, 'square', position)).changes, {});
  const { changes } = await p.rename(consumer, 'squared', position);
  assert.deepEqual(Object.keys(changes).sort(), [p.origin, consumer].sort());
  assert.equal(changes[p.origin].length, 2);
  assert.equal(changes[consumer].length, 1);
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
  assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), uses);
  for (const [key, edits] of Object.entries(changes)) {
    fs.writeFileSync(fileURLToPath(key), edited(fs.readFileSync(fileURLToPath(key), 'utf8'), edits));
  }
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('racket', [p.filename('uses.rkt')], { encoding: 'utf8', cwd: p.directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '9');
  assert.equal(fs.readFileSync(p.filename('unrelated.rkt'), 'utf8'), untouched);
});

test('one source identifier with several corresponding binders renames its whole family', async t => {
  // A macro can bind one written name more than once, as Rhombus's fun binds
  // the function and a generated helper at its name.
  const p = await project(t), consumer = p.open('uses.rkt', uses);
  const twice = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    '(define-syntax (define-twice stx)\n  (syntax-case stx ()\n    [(_ name value)\n' +
    '     (with-syntax ([hidden ((make-syntax-introducer) #\'name)])\n' +
    '       #\'(begin (define hidden value) (define name hidden)))]))\n(define-twice square 7)\n(display square)\n';
  p.write('twice.rkt', twice);
  const bound = p.open('twice.rkt', twice);
  await p.update();
  const { changes } = await p.rename(consumer, 'squared', { line: 2, character: 2 });
  assert.deepEqual(Object.keys(changes).sort(), [p.origin, consumer].sort());
  const family = await p.rename(bound, 'squared', { line: 7, character: 15 });
  assert.deepEqual(Object.keys(family.changes), [bound]);
  assert.equal(edited(twice, family.changes[bound]), twice.replaceAll('square', 'squared'));
  assert.equal(fs.readFileSync(p.filename('twice.rkt'), 'utf8'), twice);
});

test('workspace rename rejects capture, conflicting imports, and invalid names', async t => {
  const p = await project(t);
  p.write('other.rkt', '#lang racket/base\n(provide squared)\n(define squared 4)\n');
  await p.update();
  for (const name of ['42', '', 'new name', 'x ;comment', '#;ignored x']) {
    await assert.rejects(p.rename(p.origin, name), /single Racket identifier/);
  }
  for (const [description, text] of [
    ['lexical capture', '#lang racket/base\n(require "definition.rkt")\n(let ([squared 2]) (square squared))\n'],
    ['conflicting unused import', '#lang racket/base\n(require "definition.rkt" "other.rkt")\n']
  ]) {
    t.diagnostic(`Checking ${description}`);
    p.write('uses.rkt', text); await p.update();
    await assert.rejects(p.rename(p.origin, 'squared'), /another binding|Cannot analyse|alias/, description);
    assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
    assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), text);
  }
});

test('lexical rename preserves scopes and uses current Unicode buffers', async t => {
  const p = await project(t);
  const text = '#lang racket/base\n; 😀\n(define (f x) (let ([other 2]) (+ x other)))\n(define (g x) x)\n';
  p.write('local.rkt', text);
  const local = p.open('local.rkt', text);
  await p.update();
  const position = { line: 2, character: 11 };
  const result = await p.rename(local, 'value', position);
  assert.deepEqual(Object.keys(result.changes), [local]);
  assert.equal(edited(text, result.changes[local]), text.replace('(f x)', '(f value)').replace('(+ x other)', '(+ value other)'));
  await assert.rejects(p.rename(local, 'other', position), /another binding/);
  const unused = '#lang racket/base\n(define outer 5)\n(define (f unused) outer)\n';
  p.write('local.rkt', unused); p.open('local.rkt', unused, 2); await p.update();
  await assert.rejects(p.rename(local, 'outer', position), /another binding/,
    'Renaming an unused parameter must not capture an unchanged outer reference');
  const unsaved = definition + '(define extra (square 2))\n';
  p.open('definition.rkt', unsaved, 2); await p.update();
  const renamed = await p.rename(p.origin, '平方');
  assert.equal(renamed.changes[p.origin].length, 3);
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
});

test('rename refuses partial indexes, stale disk snapshots and retired requests', async t => {
  const p = await project(t);
  p.write('broken.rkt', '#lang racket/base\nunknown-name\n'); await p.update();
  await assert.rejects(p.rename(p.origin, 'squared'), /analysis is incomplete/);
  fs.unlinkSync(p.filename('broken.rkt')); await p.update();
  await p.references(p.origin);
  p.write('uses.rkt', uses + '(square 5)\n');
  await assert.rejects(p.rename(p.origin, 'squared'), /files changed/);
  await p.update();
  const retired = p.rename(p.origin, 'squared');
  p.open('definition.rkt', definition, 1); await p.update();
  await assert.rejects(retired, error => error.code === -32803 &&
    error.message === 'Workspace changed during rename. Try Rename again.');
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition, 'A refused rename makes no edits');
  const cancel = new rpc.CancellationTokenSource();
  const cancelled = p.rename(p.origin, 'squared', undefined, cancel.token);
  cancel.cancel();
  await assert.rejects(cancelled, error => error.code === -32800);
  cancel.dispose();
  assert.equal((await p.rename(p.origin, 'squared')).changes[uri(p.filename('uses.rkt'))].length, 2);
});

test('workspace rename releases expansion state within the worker memory limit', async t => {
  const p = await project(t);
  const consumers = Array.from({ length: 4 }, (_, index) => `shapes-${index}.rkt`);
  const text = '#lang racket/base\n(require (prefix-in image: 2htdp/image) (prefix-in plot: plot/no-gui) "definition.rkt")\n(image:circle (square 3) "solid" "red")\n';
  for (const file of consumers) p.write(file, text);
  for (let index = 0; index < 24; index++) p.write(`consumer-${index}.rkt`, uses);
  await p.update();
  for (const name of ['squared', 'area']) {
    const { changes } = await p.rename(p.origin, name);
    assert.equal(edited(definition, changes[p.origin]), definition.replaceAll('square', name));
    for (const file of consumers) {
      assert.equal(edited(text, changes[uri(p.filename(file))]), text.replace('(square 3)', `(${name} 3)`));
      assert.equal(fs.readFileSync(p.filename(file), 'utf8'), text);
    }
    for (let index = 0; index < 24; index++) {
      assert.equal(edited(uses, changes[uri(p.filename(`consumer-${index}.rkt`))]), uses.replace('square', name));
    }
  }
});

test('rename names the version of each buffer it analysed, and null for text on disk', async t => {
  const p = await project(t), consumer = p.open('uses.rkt', uses + '(square 4)\n', 7);
  await p.update();
  const { documentChanges } = await p.rename(p.origin, 'squared');
  const versions = Object.fromEntries(documentChanges.map(({ textDocument }) => [textDocument.uri, textDocument.version]));
  assert.deepEqual(versions, { [p.origin]: 1, [consumer]: 7 });
  p.documents.delete(consumer); await p.update();
  const after = await p.rename(p.origin, 'squared');
  assert.equal(after.documentChanges.find(({ textDocument }) => textDocument.uri === consumer).textDocument.version, null);
});

test('a rename pending while source files change answers from the new sources', async t => {
  const p = await project(t), consumer = uri(p.filename('uses.rkt'));
  await p.references(p.origin);
  const pending = p.rename(p.origin, 'squared');
  p.write('uses.rkt', uses + '(square 4)\n'); await p.diskChange('uses.rkt');
  assert.equal((await pending).changes[consumer].length, 2);
});

test('successive renames use unsaved edits in every changed buffer', async t => {
  const p = await project(t), consumer = p.open('uses.rkt', uses);
  await p.update();
  const first = await p.rename(p.origin, 'squared');
  const buffers = new Map([[p.origin, definition], [consumer, uses]]);
  assert.deepEqual(Object.keys(first.changes).sort(), [...buffers.keys()].sort());
  for (const [key, edits] of Object.entries(first.changes)) {
    const text = edited(buffers.get(key), edits);
    buffers.set(key, text);
    p.open(key, text, 2);
  }
  await p.update(true);
  const second = await p.rename(consumer, 'area', { line: 2, character: 2 });
  assert.deepEqual(Object.keys(second.changes).sort(), [...buffers.keys()].sort());
  for (const [key, text] of buffers) {
    assert.equal(edited(text, second.changes[key]), text.replaceAll('squared', 'area'));
  }
  assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), definition);
  assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), uses);
});
