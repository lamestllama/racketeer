// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { uri, addon, project, edited } = require('./workspace-index-project');

const { languageServer, until } = require('./language-server-project');

const dependency = name => `#lang racket/base\n\n(provide ${name})\n(define (${name} x) (+ x 1))\n`;
const consumer = name => `#lang racket/base\n(require "dependency.rkt")\n(${name} 3)\n`;

test('index references and rename follow unsaved exports without saving either file', async t => {
  const p = await project(t);
  p.write('dependency.rkt', dependency('before'));
  p.write('consumer.rkt', consumer('before'));
  const dep = p.open('dependency.rkt', dependency('after'));
  const use = p.open('consumer.rkt', consumer('after'));
  await p.update();
  const locations = await p.references(use, { line: 2, character: 2 }, true);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.ok(locations.some(location => location.uri === dep && location.range.start.line === 3));
  assert.ok(locations.some(location => location.uri === use && location.range.start.line === 2));
  const edit = await p.rename(use, 'next', { line: 2, character: 2 });
  assert.equal(edited(dependency('after'), edit.changes[dep]), dependency('next'));
  assert.equal(edited(consumer('after'), edit.changes[use]), consumer('next'));
  assert.equal(fs.readFileSync(p.filename('dependency.rkt'), 'utf8'), dependency('before'));
  assert.equal(fs.readFileSync(p.filename('consumer.rkt'), 'utf8'), consumer('before'));
  p.documents.delete(dep); p.documents.delete(use); await p.update(true);
  assert.equal((await p.references(p.origin)).filter(location => location.uri === uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
});

test('language diagnostics and definitions refresh consumers on dependency open, edit, revert, save and close', async t => {
  const p = await languageServer(t);
  p.write('dependency.rkt', dependency('before'));
  p.write('consumer.rkt', consumer('after'));
  await p.open('consumer.rkt', consumer('after'));
  await p.expectDiagnostics('consumer.rkt', true);
  p.forget('consumer.rkt');
  await p.open('dependency.rkt', dependency('after'));
  await p.expectDiagnostics('consumer.rkt', false);
  const definitions = await p.request('definition', 'consumer.rkt', { position: { line: 2, character: 2 } });
  assert.ok(definitions, 'The imported definition is available from unsaved source');
  assert.equal(definitions.uri, uri(p.filename('dependency.rkt')));
  assert.equal(definitions.range.start.line, 3);
  p.forget('consumer.rkt');
  await p.change('dependency.rkt', dependency('before'), 2);
  await p.expectDiagnostics('consumer.rkt', true);
  p.forget('consumer.rkt');
  await p.change('dependency.rkt', dependency('after'), 3);
  await p.expectDiagnostics('consumer.rkt', false);
  p.forget('consumer.rkt');
  await p.close('dependency.rkt');
  await p.expectDiagnostics('consumer.rkt', true);
  p.forget('consumer.rkt');
  await p.open('dependency.rkt', dependency('after'));
  await p.expectDiagnostics('consumer.rkt', false);
  p.write('dependency.rkt', dependency('after'));
  p.forget('consumer.rkt');
  await p.close('dependency.rkt');
  await p.expectDiagnostics('consumer.rkt', false);
});

test('unsaved compile-time imports replace values baked into compiled intermediate modules', async t => {
  const p = await languageServer(t);
  const leaf = value => `#lang racket/base\n(provide stamp)\n(define stamp '${value})\n`;
  p.write('leaf.rkt', leaf('old'));
  p.write('bridge.rkt', `#lang racket/base
(require (for-syntax racket/base "leaf.rkt"))
(provide stamp)
(define-syntax (bake stx) (datum->syntax stx (list 'quote stamp)))
(define stamp (bake))
`);
  const compiled = spawnSync('raco', ['make', p.filename('bridge.rkt')], { encoding: 'utf8', env: { ...process.env, PLTADDONDIR: addon } });
  assert.equal(compiled.status, 0, compiled.stderr);
  const bytecode = p.filename('compiled/bridge_rkt.zo');
  const before = fs.readFileSync(bytecode);
  const text = `#lang racket/base
(require (for-syntax racket/base "bridge.rkt"))
(begin-for-syntax (unless (eq? stamp 'new) (raise-syntax-error #f "stale import" #'stamp)))
`;
  p.write('consumer.rkt', text);
  await p.open('consumer.rkt', text);
  await p.expectDiagnostics('consumer.rkt', true);
  p.forget('consumer.rkt');
  await p.open('leaf.rkt', leaf('new'));
  await p.expectDiagnostics('consumer.rkt', false);
  assert.equal(fs.readFileSync(p.filename('leaf.rkt'), 'utf8'), leaf('old'));
  assert.deepEqual(fs.readFileSync(bytecode), before, 'Unsaved analysis must not replace disk bytecode');
});

test('dependency replacement cancels blocked expansion and releases unchanged consumer queries', async t => {
  const p = await languageServer(t);
  const gate = p.filename('gate'), entered = p.filename('entered');
  const leaf = value => `#lang racket/base\n(provide stamp)\n(define stamp '${value})\n`;
  const text = `#lang racket/base
(require (for-syntax racket/base "dependency.rkt"))
(begin-for-syntax
  (when (file-exists? ${JSON.stringify(gate)})
    (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate (lambda (out) (display "entered" out)))
    (sync never-evt))
  (unless (eq? stamp 'new) (raise-syntax-error #f "stale import" #'stamp)))
`;
  p.write('dependency.rkt', leaf('old')); p.write('consumer.rkt', text);
  await p.open('dependency.rkt', leaf('new'));
  await p.open('consumer.rkt', text);
  await p.expectDiagnostics('consumer.rkt', false);
  fs.writeFileSync(gate, 'block');
  await p.change('dependency.rkt', leaf('old'), 2);
  await until(() => fs.existsSync(entered), 'consumer expansion reached its gate');
  const pending = p.request('semanticTokens/full', 'consumer.rkt');
  p.forget('consumer.rkt');
  fs.unlinkSync(gate);
  await p.change('dependency.rkt', leaf('new'), 3);
  await p.expectDiagnostics('consumer.rkt', false);
  assert.ok(Array.isArray((await pending).data));
  assert.equal(fs.readFileSync(p.filename('dependency.rkt'), 'utf8'), leaf('old'));
});

test('open buffers survive disk deletion and supply unsaved submodules through legacy paths', async t => {
  const p = await languageServer(t);
  const submodule = name => `#lang racket/base\n(module tools racket/base (provide ${name}) (define ${name} 7))\n`;
  p.write('dependency.ss', submodule('before'));
  const text = '#lang racket/base\n(require (submod "dependency.rkt" tools) "new.rkt")\n(+ after fresh)\n';
  p.write('consumer.rkt', text);
  p.write('new.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 5)\n');
  await p.open('dependency.ss', submodule('after'));
  await p.open('new.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 5)\n');
  fs.unlinkSync(p.filename('new.rkt'));
  await p.open('consumer.rkt', text);
  await p.expectDiagnostics('consumer.rkt', false);
  assert.equal(fs.existsSync(p.filename('new.rkt')), false);
  assert.equal(fs.readFileSync(p.filename('dependency.ss'), 'utf8'), submodule('before'));
});
