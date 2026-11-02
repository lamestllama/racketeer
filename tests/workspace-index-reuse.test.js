// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const { addon, definition, uses, uri, project } = require('./workspace-index-project');

async function trackedProject(t) {
  const p = await project(t);
  // Observe real expansion without relying on elapsed time or internal state.
  const marker = path.join(addon, path.basename(p.directory));
  const consumerText = uses + `(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(marker)} #:exists 'append
    (lambda (out) (display "expanded\\n" out))))
`;
  p.write('uses.rkt', consumerText); await p.update();
  const count = async () => (await p.references(p.origin))
    .filter(location => location.uri === uri(p.filename('uses.rkt'))).length;
  assert.equal(await count(), 1);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  return { ...p, consumerText, count, expansions: () => fs.readFileSync(marker, 'utf8').trim().split('\n').length };
}

test('unchanged open and close reuse complete analysis while disk notifications invalidate it', { timeout: 120000 }, async t => {
  const p = await trackedProject(t), before = p.expansions();
  const consumer = p.open('uses.rkt', p.consumerText);
  await p.update(true); assert.equal(await p.count(), 1);
  assert.equal(p.expansions(), before, 'Opening an unchanged file must not expand the workspace again');
  p.documents.delete(consumer);
  await p.update(true); assert.equal(await p.count(), 1);
  assert.equal(p.expansions(), before, 'Closing an unchanged buffer must reuse the completed index');
  p.write('macro-input.txt', 'changed');
  await p.update(); assert.equal(await p.count(), 1);
  assert.ok(p.expansions() > before, 'Non-source disk events can change macro expansion');
});

test('buffer changes and close after an unreported disk write require fresh analysis', { timeout: 120000 }, async t => {
  const p = await trackedProject(t);
  const consumer = p.open('uses.rkt', p.consumerText + '(square 4)\n');
  await p.update(true); assert.equal(await p.count(), 2);
  p.write('uses.rkt', p.consumerText + '(square 4)\n(square 5)\n');
  p.documents.delete(consumer);
  await p.update(true); assert.equal(await p.count(), 3);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  const reopened = p.open('uses.rkt', p.consumerText);
  await p.update(true); assert.equal(await p.count(), 1);
  const alias = reopened.replace('uses.rkt', '%75ses.rkt');
  p.open(alias, p.consumerText);
  await p.update(true); assert.equal(await p.count(), 0);
  assert.equal(p.notifications.at(-1).state, 'partial');
  p.documents.delete(alias);
  await p.update(true); assert.equal(await p.count(), 1);
  assert.equal(p.notifications.at(-1).state, 'ready');
});

test('saving an unsaved module refreshes dependents even when closing leaves identical source text', { timeout: 120000 }, async t => {
  const p = await project(t), marker = path.join(addon, path.basename(p.directory));
  const dependency = value => `#lang racket/base\n(provide value)\n(define value "${value}")\n`;
  p.write('dependency.rkt', dependency('old'));
  p.write('uses.rkt', uses + `(require (for-syntax racket/base "dependency.rkt"))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(marker)} #:exists 'truncate
    (lambda (out) (display value out))))
`);
  const buffer = p.open('dependency.rkt', dependency('new'));
  await p.update(); await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.equal(fs.readFileSync(marker, 'utf8'), 'new', 'Import expansion must use the unsaved dependency');
  p.write('dependency.rkt', dependency('new'));
  p.documents.delete(buffer); await p.update(true); await p.references(p.origin);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'new', 'Import expansion must use the saved dependency');
});

test('reuse verification catches source additions and deletion without watcher notifications', { timeout: 120000 }, async t => {
  const p = await trackedProject(t), added = uri(p.filename('added.rkt'));
  p.write('added.rkt', uses);
  await p.update(true);
  assert.equal((await p.references(p.origin)).filter(location => location.uri === added).length, 1);
  fs.unlinkSync(p.filename('added.rkt'));
  await p.update(true);
  assert.equal((await p.references(p.origin)).filter(location => location.uri === added).length, 0);
  p.settings.maxFiles = 1;
  await p.update(true); await p.count();
  assert.equal(p.notifications.at(-1).state, 'partial', 'Changed limits must invalidate a completed index');
});

test('reused analysis retains current document ownership and rename disk validation', { timeout: 120000 }, async t => {
  const p = await trackedProject(t);
  const consumer = p.open('uses.rkt', p.consumerText, 9);
  await p.update(true); assert.equal(await p.count(), 1);
  const edit = await p.rename(consumer, 'squared', { line: 2, character: 2 });
  assert.ok(edit.changes[p.origin]?.length);
  assert.ok(edit.changes[consumer]?.length);
  p.write('uses.rkt', p.consumerText + '(square 4)\n');
  p.documents.delete(consumer); await p.update(true);
  assert.equal(await p.count(), 2);
  p.write('uses.rkt', p.consumerText);
  await assert.rejects(p.rename(p.origin, 'squared'), /Workspace files changed/);
});

test('reopening a document cancels its old request even when completed analysis is reused', { timeout: 120000 }, async t => {
  const p = await trackedProject(t);
  const blocked = path.join(addon, path.basename(p.directory) + '-block');
  const entered = blocked + '-entered';
  const source = definition + `(require (for-syntax racket/base))
(begin-for-syntax
  (when (file-exists? ${JSON.stringify(blocked)})
    (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate
      (lambda (out) (display "entered" out)))
    (sync never-evt)))
`;
  p.write('definition.rkt', source); p.open('definition.rkt', source);
  await p.update(); assert.equal(await p.count(), 1);
  const before = p.expansions();
  fs.writeFileSync(blocked, 'block');
  const rejected = assert.rejects(p.references(p.origin), error => error.code === -32801);
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(entered)) {
    assert.ok(Date.now() < deadline, p.diagnostics());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  p.open('definition.rkt', source); await p.update(true);
  await rejected;
  fs.unlinkSync(blocked);
  assert.equal(await p.count(), 1);
  assert.equal(p.expansions(), before, 'Ownership changes must not require repeating unchanged analysis');
});

test('unchanged documents opening and closing during a pass neither restart it nor delay a waiting request', { timeout: 120000 }, async t => {
  const p = await project(t), consumer = uri(p.filename('uses.rkt'));
  await p.references(p.origin);
  const marker = path.join(addon, path.basename(p.directory) + '-slow');
  p.write('slow.rkt', `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(marker)} #:exists 'append
    (lambda (out) (display "expanded\\n" out)))
  (sleep 3))
`);
  await p.update();
  let settled = false;
  const request = p.references(p.origin).finally(() => { settled = true; });
  // Each lifetime event arrives sooner than the pass can finish.
  const deadline = Date.now() + 30000;
  while (!settled && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (p.documents.has(consumer)) p.documents.delete(consumer); else p.open('uses.rkt', uses);
    await p.update(true);
  }
  assert.ok(settled, 'A waiting request must not starve while unchanged documents open and close');
  assert.equal((await request).filter(location => location.uri === consumer).length, 1);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'Unchanged documents must not restart the pass');
});

test('a reported change in an excluded directory starts no pass, and one elsewhere does', { timeout: 120000 }, async t => {
  const p = await trackedProject(t), before = p.expansions();
  await p.diskChange('compiled/definition_rkt.zo');
  await p.diskChange('node_modules/package/file.txt');
  assert.equal(await p.count(), 1);
  assert.equal(p.expansions(), before, 'Excluded directories are not watched for analysis');
  await p.diskChange('uses.rkt');
  assert.equal(await p.count(), 1);
  assert.ok(p.expansions() > before);
});
