'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { project, uri: fileUri, edited } = require('./workspace-index-project');
const { languageServer, until } = require('./language-server-project');

const source = '#lang racket/base\n(define (square x) (* x x))\n(square 3)\n';
const atUse = { line: 2, character: 3 };

test('untitled documents retain their URI through diagnostics, completion and definition', { timeout: 60000 }, async t => {
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

for (const workspace of [true, false]) test(`untitled index references and rename retain document identities with workspace=${workspace}`, { timeout: 120000 }, async t => {
  const p = await project(t);
  const uri = p.open('untitled:Untitled-1', source);
  if (!workspace) p.roots.splice(0);
  await p.update();
  const references = await p.references(uri, atUse, true);
  assert.ok(references.length >= 2);
  assert.ok(references.every(location => location.uri === uri));
  const preview = await p.rename(uri, 'squared', atUse);
  assert.deepEqual(Object.keys(preview.changes), [uri]);
  assert.equal(edited(source, preview.changes[uri]), source.replaceAll('square', 'squared'));
  const old = p.documents.get(uri);
  p.documents.delete(uri); await p.update(true);
  p.open(uri, source.replaceAll('square', 'fresh'));
  await p.update(true);
  assert.ok((await p.references(uri, atUse, true)).every(location => location.uri === uri));
  assert.notEqual(p.documents.get(uri).identity, old.identity);
  assert.deepEqual(fs.readdirSync(p.directory).sort(), ['definition.rkt', 'uses.rkt']);
});

test('untitled consumers use unsaved workspace imports and return real definition URIs', { timeout: 60000 }, async t => {
  const p = await languageServer(t);
  p.write('dependency.rkt', '#lang racket/base\n(provide old)\n(define old 1)\n');
  await p.open('dependency.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 2)\n');
  const uri = 'untitled:Untitled-2';
  await p.open(uri, '#lang racket/base\n(require "dependency.rkt")\nfresh\n');
  await p.expectDiagnostics(uri, false);
  const definition = await p.request('definition', uri, { position: { line: 2, character: 2 } });
  assert.equal(definition.uri, fileUri(p.filename('dependency.rkt')));
  p.forget(uri); await p.close('dependency.rkt'); await p.expectDiagnostics(uri, true);
  assert.deepEqual(fs.readdirSync(p.directory), ['dependency.rkt']);
});

test('untitled documents without a workspace support local semantics and reject relative imports clearly', { timeout: 60000 }, async t => {
  const p = await languageServer(t, { workspace: false });
  const uri = 'untitled:Untitled-3';
  await p.open(uri, source); await p.expectDiagnostics(uri, false);
  assert.equal((await p.request('definition', uri, { position: atUse })).uri, uri);
  p.write('dependency.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 2)\n');
  p.forget(uri);
  await p.change(uri, '#lang racket/base\n(require "dependency.rkt")\nfresh\n', 2);
  await p.expectDiagnostics(uri, true);
  assert.ok(p.diagnostics.get(uri).some(item => /save location or a single workspace folder/.test(item.message)), p.errors());
  p.forget(uri);
  await p.change(uri, `#lang racket/base\n(require (file ${JSON.stringify(p.filename('dependency.rkt'))}))\nfresh\n`, 3);
  await p.expectDiagnostics(uri, false);
  assert.equal((await p.request('definition', uri, { position: { line: 2, character: 2 } })).uri, fileUri(p.filename('dependency.rkt')));
});

test('an associated save location supplies the import base without replacing an existing file', { timeout: 60000 }, async t => {
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

test('multiple workspace folders require an associated save location for relative imports', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-untitled-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = ['one', 'two'].map(name => { const folder = path.join(root, name); fs.mkdirSync(folder); return folder; });
  const p = await languageServer(t, { folders });
  const uri = 'untitled:Untitled-4';
  await p.open(uri, '#lang racket/base\n(require "dependency.rkt")\n');
  await p.expectDiagnostics(uri, true);
  assert.ok(p.diagnostics.get(uri).some(item => /single workspace folder/.test(item.message)), p.errors());
});

test('closing blocked untitled analysis retires queries before Save As and same-URI reopen', { timeout: 90000 }, async t => {
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

test('workspace folder changes rebase untitled imports without changing their URI or text version', { timeout: 60000 }, async t => {
  const p = await languageServer(t, { workspace: false });
  const uri = 'untitled:Untitled-6';
  p.write('dependency.rkt', '#lang racket/base\n(provide fresh)\n(define fresh 2)\n');
  await p.open(uri, '#lang racket/base\n(require "dependency.rkt")\nfresh\n');
  await p.expectDiagnostics(uri, true);
  p.forget(uri);
  const folder = { uri: fileUri(p.directory), name: 'project' };
  await p.connection.sendNotification('workspace/didChangeWorkspaceFolders', { event: { added: [folder], removed: [] } });
  await p.expectDiagnostics(uri, false);
  assert.equal((await p.request('definition', uri, { position: { line: 2, character: 2 } })).uri, fileUri(p.filename('dependency.rkt')));
  p.forget(uri);
  await p.connection.sendNotification('workspace/didChangeWorkspaceFolders', { event: { added: [], removed: [folder] } });
  await p.expectDiagnostics(uri, true);
  assert.ok(p.diagnostics.get(uri).some(item => /single workspace folder/.test(item.message)));
});
