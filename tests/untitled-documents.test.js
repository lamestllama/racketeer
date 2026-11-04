// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const { uri: fileUri } = require('./workspace-index-project');
const { languageServer, until } = require('./language-server-project');

const source = '#lang racket/base\n(define (square x) (* x x))\n(square 3)\n';
const atUse = { line: 2, character: 3 };

test('untitled documents retain their URI through diagnostics, completion and definition', async t => {
  const p = await languageServer(t);
  const uri = 'untitled:Untitled-1';
  await p.open(uri, source);
  await p.expectDiagnostics(uri, false);
  const definition = await p.request('definition', uri, { position: atUse });
  assert.equal(definition.uri, uri);
  assert.equal(definition.range.start.line, 1);
  const completions = await p.request('completion', uri, { position: atUse });
  assert.ok((completions.items || completions).some(item => item.label === 'square'));
  p.forget(uri);
  await p.change(uri, source.replace('(square 3)', '(missing 3)'), 2);
  await p.expectDiagnostics(uri, true);
  p.forget(uri); await p.change(uri, source, 3);
  await p.expectDiagnostics(uri, false);
  assert.deepEqual(fs.readdirSync(p.directory), []);
});

for (const workspace of [true, false]) test(`untitled documents refuse relative imports without a save location with workspace=${workspace}`, async t => {
  const p = await languageServer(t, { workspace });
  const uri = 'untitled:Untitled-3';
  await p.open(uri, source); await p.expectDiagnostics(uri, false);
  assert.equal((await p.request('definition', uri, { position: atUse })).uri, uri);
  // A workspace folder is not an import base, even when this file exists in it.
  p.write('dependency.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 2)\n');
  p.forget(uri);
  await p.change(uri, '#lang racket/base\n(require "dependency.rkt")\nfresh\n', 2);
  await p.expectDiagnostics(uri, true);
  assert.ok(p.diagnostics.get(uri).some(item => /Relative imports need a save location/.test(item.message)), p.errors());
  p.forget(uri);
  await p.change(uri, `#lang racket/base\n(require (file ${JSON.stringify(p.filename('dependency.rkt'))}))\nfresh\n`, 3);
  await p.expectDiagnostics(uri, false);
  assert.deepEqual(fs.readdirSync(p.directory), ['dependency.rkt']);
});

test('an associated save location supplies the import base without replacing an existing file', async t => {
  const p = await languageServer(t, { workspace: false });
  p.write('draft.rkt', 'keep this existing file');
  p.write('dependency.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 2)\n');
  const uri = fileUri(p.filename('draft.rkt')).replace(/^file:/, 'untitled:');
  await p.open(uri, '#lang racket/base\n(require "dependency.rkt")\n(define answer fresh)\nanswer\n');
  await p.expectDiagnostics(uri, false);
  assert.equal((await p.request('definition', uri, { position: { line: 3, character: 2 } })).uri, uri);
  assert.equal(fs.readFileSync(p.filename('draft.rkt'), 'utf8'), 'keep this existing file');
  assert.deepEqual(fs.readdirSync(p.directory).sort(), ['dependency.rkt', 'draft.rkt']);
});

test('closing blocked untitled analysis retires queries before Save As and same-URI reopen', async t => {
  const p = await languageServer(t);
  const uri = 'untitled:Untitled-5';
  const entered = p.filename('entered');
  const blocked = `#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate (lambda (out) (display "entered" out))) (sync never-evt))\n`;
  await p.open(uri, blocked);
  await until(() => fs.existsSync(entered), 'untitled expansion reached its gate');
  const pending = p.request('definition', uri, { position: atUse }).then(value => ({ value }), error => ({ error }));
  await p.close(uri);
  await p.open(uri, source);
  await p.expectDiagnostics(uri, false);
  const retired = await pending;
  assert.ok(retired.error || retired.value === null, 'Retired request must not return replacement-document locations');
  assert.equal((await p.request('definition', uri, { position: atUse })).uri, uri);
  await p.close(uri);
  p.write('saved.rkt', source);
  await p.open('saved.rkt', source);
  await p.expectDiagnostics('saved.rkt', false);
  assert.equal((await p.request('definition', 'saved.rkt', { position: atUse })).uri, fileUri(p.filename('saved.rkt')));
  await until(() => p.diagnostics.get(uri)?.length === 0, 'untitled diagnostics clear on close');
});
