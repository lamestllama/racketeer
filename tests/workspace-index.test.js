// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const { root, uses, uri, project, rawServer } = require('./workspace-index-project');

const from = (locations, source) => locations.filter(location => location.uri === source);

test('standalone index follows disk and unsaved buffers through close, rename and deletion', { timeout: 120000 }, async t => {
  const p = await project(t), consumer = uri(p.filename('uses.rkt'));
  const initial = await p.references(p.origin);
  assert.equal(from(initial, consumer).length, 1, JSON.stringify({ consumer, locations: initial,
    status: p.notifications.at(-1), diagnostics: p.diagnostics() }));
  p.write('uses.rkt', uses + '(square 4)\n'); await p.update();
  assert.equal(from(await p.references(p.origin), consumer).length, 2);
  p.open('uses.rkt', uses + '(square 4)\n(square 5)\n', 7);
  p.write('uses.rkt', '#lang racket/base\n'); await p.update();
  assert.equal(from(await p.references(p.origin), consumer).length, 3);
  p.documents.delete(consumer); await p.update();
  assert.equal(from(await p.references(p.origin), consumer).length, 0);
  p.write('uses.rkt', uses); fs.renameSync(p.filename('uses.rkt'), p.filename('renamed.rkt')); await p.update();
  const renamed = uri(p.filename('renamed.rkt'));
  const refs = await p.references(p.origin);
  assert.equal(from(refs, consumer).length, 0); assert.equal(from(refs, renamed).length, 1);
  fs.unlinkSync(p.filename('renamed.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), renamed).length, 0);
});

test('standalone analysis preserves local references and protects protocol output', { timeout: 120000 }, async t => {
  const p = await project(t);
  const noisy = '#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (display "noise") (eprintf "more noise"))\n(define (twice local) (+ local local))\n(twice 4)\n';
  p.write('local.rkt', noisy);
  const source = p.open('local.rkt', noisy); await p.update();
  const refs = await p.references(source, { line: 3, character: 15 });
  assert.equal(from(refs, source).length, 2);
  assert.equal(from(await p.references(source, { line: 3, character: 15 }, true), source).length, 3);
  assert.ok(!p.diagnostics().includes('more noise'));
});

test('references from nested imports include unopened consumers and the definition', { timeout: 120000 }, async t => {
  const p = await project(t);
  fs.cpSync(path.join(root, 'examples/multi-file'), p.filename('multi-file'), { recursive: true,
    filter: source => path.basename(source) !== 'compiled' });
  p.write('multi-file/index-consumer.rkt', '#lang racket/base\n(require "app/orders.rkt")\n(order-total 10 2 1/10)\n');
  const source = p.open('multi-file/main.rkt', fs.readFileSync(p.filename('multi-file/main.rkt'), 'utf8'));
  await p.update();
  const locations = await p.references(source, { line: 5, character: 35 }, true);
  for (const [file, line] of [['multi-file/main.rkt', 5], ['multi-file/app/orders.rkt', 4],
    ['multi-file/index-consumer.rkt', 2]]) {
    assert.ok(from(locations, uri(p.filename(file))).some(location => location.range.start.line === line),
      JSON.stringify({ file, line, locations, status: p.notifications.at(-1), diagnostics: p.diagnostics() }));
  }
});

test('ambiguous URI aliases cannot overwrite one another and imports resolve by binding', { timeout: 120000 }, async t => {
  const p = await project(t), consumer = p.open('uses.rkt', uses);
  const alias = consumer.replace('uses.rkt', '%75ses.rkt');
  p.open(alias, uses + '(square 4)\n', 3); await p.update();
  assert.equal(from(await p.references(p.origin), consumer).length, 0);
  assert.equal(p.notifications.at(-1).state, 'partial');
  p.documents.delete(alias); await p.update();
  const refs = await p.references(consumer, { line: 2, character: 2 }, true);
  assert.deepEqual(from(refs, p.origin).map(location => location.range.start.line).sort(), [1, 2],
    'The provide reference and definition are distinct locations');
  assert.equal(from(refs, consumer).length, 1);
});

test('a failed analysis and a failing request answer RequestFailed', { timeout: 120000 }, async t => {
  const p = await project(t);
  const broken = '#lang racket/base\n(\n';
  p.write('broken.rkt', broken);
  const source = p.open('broken.rkt', broken); await p.update();
  await assert.rejects(p.references(source, { line: 0, character: 0 }), error => error.code === -32803);
  await assert.rejects(p.request('textDocument/references', {}), error => error.code === -32803);
});

test('malformed JSON answers ParseError with a null id, and the server reads on', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  server.writeFrame('{bad}');
  const parse = await server.next();
  assert.equal(parse.error.code, -32700);
  assert.equal(parse.id, null);
  server.send({ id: 7, method: 'initialize', params: { capabilities: {} } });
  assert.equal((await server.next()).id, 7);
  server.send({ id: 8, method: 'no/such/method' });
  const unknown = await server.next();
  assert.equal(unknown.id, 8);
  assert.equal(unknown.error.code, -32601);
});
