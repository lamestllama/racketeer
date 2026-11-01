// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }));
const { definition, uri, project } = require('./workspace-index-project');

const from = (locations, source) => locations.filter(location => location.uri === source);

test('cancelled requests finish while a macro is blocked, and the index recovers', { timeout: 120000 }, async t => {
  const p = await project(t);
  p.write('blocked.rkt', '#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (sync never-evt))\n');
  await p.update();
  const cancel = new rpc.CancellationTokenSource();
  const request = p.references(p.origin, undefined, false, cancel.token);
  cancel.cancel();
  await assert.rejects(request, error => error.code === -32800);
  cancel.dispose();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.match(p.diagnostics(), /blocked\.rkt \(analysis exceeded its 20 second time limit\)/);
  fs.unlinkSync(p.filename('blocked.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready');
});

test('edits and reopening a URI retire pending requests even at the same version', { timeout: 120000 }, async t => {
  const p = await project(t);
  p.write('blocked.rkt', '#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (sync never-evt))\n');
  await p.update();
  const retired = p.references(p.origin);
  p.open('definition.rkt', definition, 1); await p.update();
  await assert.rejects(retired, error => error.code === -32801);
  const edited = p.references(p.origin);
  p.documents.get(p.origin).version++; await p.update();
  await assert.rejects(edited, error => error.code === -32801);
  // Reopening alone leaves the sources unchanged, so the blocked pass
  // continues; the request still retires without waiting for it.
  const reopened = p.references(p.origin), started = Date.now();
  p.open('definition.rkt', definition, 2); await p.update(true);
  await assert.rejects(reopened, error => error.code === -32801);
  assert.ok(Date.now() - started < 10000, 'Retirement must not wait for the blocked pass');
  fs.unlinkSync(p.filename('blocked.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
});

test('cancelling active expansion and losing a worker leave later indexing usable', { timeout: 120000 }, async t => {
  const p = await project(t), marker = p.filename('entered');
  p.write('blocked.rkt', `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(marker)} #:exists 'truncate
    (lambda (out) (display "entered" out)))
  (sync never-evt))\n`);
  await p.update();
  const cancel = new rpc.CancellationTokenSource();
  const request = p.references(p.origin, undefined, false, cancel.token);
  const rejected = assert.rejects(request, error => error.code === -32800);
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(marker)) {
    assert.ok(Date.now() < deadline, p.diagnostics());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  cancel.cancel(); await rejected; cancel.dispose();
  fs.unlinkSync(p.filename('blocked.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready');
  p.write('dead.rkt', '#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (kill-thread (current-thread)))\n');
  await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.match(p.diagnostics(), /dead\.rkt \(analysis worker exited\)/);
  fs.unlinkSync(p.filename('dead.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready');
});
