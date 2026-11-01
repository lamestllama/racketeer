// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness(t, initial) {
  const captures = [], documents = new Map(); let provider, closed;
  const uri = (scheme, name, authority = '') => ({ scheme, path: name, toString: () => `${scheme}://${authority}${name}` });
  const file = { uri: uri('file', '/source.rkt'), getText: () => initial, setText: text => { initial = text; } };
  const vscode = {
    ViewColumn: { One: 1 }, Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    Uri: { file: name => uri('file', name), from: args => uri(args.scheme, args.path, args.authority) },
    Range: class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } },
    Selection: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: {
      fs: { async stat() { if (initial === undefined) throw Error('Deleted'); return { type: 1 }; } },
      registerTextDocumentContentProvider(_scheme, value) { provider = value; return { dispose() {} }; },
      onDidCloseTextDocument(callback) { closed = callback; return { dispose() {} }; },
      async openTextDocument(value) {
        if (value.scheme === 'file') { if (initial === undefined) throw Error('Deleted'); return file; }
        const doc = { uri: value, getText: () => provider.provideTextDocumentContent(value) }; documents.set(value.toString(), doc); return doc;
      }
    },
    window: { async showTextDocument(document, options) { const editor = { document, options, revealRange() {} }; captures.push(editor); return editor; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vscode/error-sources.js'), 'utf8'), { module, require: name => name === 'vscode' ? vscode : require(name) });
  const context = { subscriptions: [] }, sources = module.exports.registerErrorSources(context);
  const dispose = () => context.subscriptions.forEach(item => item.dispose()); t.after(dispose);
  return { sources, file, captures, documents, provider: () => provider, close: doc => closed(doc), dispose, vscode };
}
const source = { name: 'source.rkt', path: '/source.rkt', content: '#lang racket/base\n(/ 1 0)\n' };
const location = { line: 2, column: 1, endLine: 2, endColumn: 8 };

test('matching source opens the editable file with the reported range, including CRLF files', async t => {
  const h = harness(t, source.content.replace(/\n/g, '\r\n'));
  assert.equal((await h.sources.open(source, location)).scheme, 'file');
  assert.deepEqual(h.captures[0].selection.start, { line: 1, character: 0 });
  assert.equal(h.captures[0].selection.end.character, 7);
});

for (const state of ['changed', undefined]) test(`a ${state === undefined ? 'deleted' : state} file opens retained source until its tab closes`, async t => {
  const h = harness(t, state); const opened = await h.sources.open(source, location);
  assert.equal(opened.scheme, 'racketeer-error'); assert.equal(h.provider().provideTextDocumentContent(opened), source.content);
  assert.equal((await h.sources.open(source, location)).toString(), opened.toString());
  h.close(h.documents.get(opened.toString())); assert.throws(() => h.provider().provideTextDocumentContent(opened), /released/);
});

test('editing during navigation falls back to the captured source', async t => {
  const h = harness(t, source.content); const show = h.vscode.window.showTextDocument;
  h.vscode.window.showTextDocument = async (document, options) => { if (document.uri.scheme === 'file') h.file.setText('changed while opening'); return show(document, options); };
  assert.equal((await h.sources.open(source, location)).scheme, 'racketeer-error');
});

test('a deleted file still cached by the editor opens captured source', async t => {
  const h = harness(t, source.content);
  h.vscode.workspace.fs.stat = async () => { throw Error('Deleted'); };
  assert.equal((await h.sources.open(source, location)).scheme, 'racketeer-error');
});
