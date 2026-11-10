// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./support/node-test');
function event() {
  const callbacks = new Set();
  return { listen: callback => { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; },
    emit: value => callbacks.forEach(callback => callback(value)) };
}
function fixture(t) {
  const opened = event(), closed = event(), changed = event(), statuses = [], sent = [], converted = [];
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  let answer = () => [], conversion = async value => value;
  const workspace = { textDocuments: [], workspaceFolders: [],
    getConfiguration: () => ({ get: () => ({ enabled: false }) }),
    onDidOpenTextDocument: opened.listen, onDidCloseTextDocument: closed.listen,
    onDidChangeTextDocument: changed.listen, onDidChangeWorkspaceFolders: event().listen,
    onDidChangeConfiguration: event().listen };
  const connection = { listen() {}, dispose() {}, onNotification() {}, onError() {}, onClose() {}, onRequest() {}, onUnhandledProgress() {},
    sendNotification: async (method, params) => { sent.push({ method, params }); },
    sendRequest: async (method, params) => { sent.push({ method, params }); return method.startsWith('textDocument/') ? answer(method, params) : {}; } };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../vscode/workspace-index.js');
  const dependencies = { 'node:path': path, vscode: { workspace },
    'vscode-languageclient/node': { createMessageConnection: () => connection,
      StreamMessageReader: class {}, StreamMessageWriter: class {},
      CancellationTokenSource: class { token = token; cancel() {} dispose() {} } },
    './racket-version': { racketTooOld: async () => undefined },
    './language-process': { ownedArgs: (_context, args) => args, createLanguageProcess: () => ({
      start: async () => ({ stderr: { setEncoding() {}, on() {} } }), ready() {}, cancelStart() {}, dispose() {} }) } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => dependencies[name],
    setTimeout, clearTimeout, setInterval, clearInterval }, { filename });
  const params = (document, position) => ({ textDocument: { uri: document.uri.toString() }, position });
  const convert = kind => async (value, received) => { assert.equal(received, token); converted.push(kind); return conversion(value); };
  const index = module.exports.createWorkspaceIndex({ asAbsolutePath: file => file }, {
    executable: 'unused', timeout: 60000, output: { appendLine() {} }, onStatus: status => statuses.push(status),
    supportsDocument: document => document.languageId === 'selected',
    code2ProtocolConverter: { asTextDocumentPositionParams: params,
      asReferenceParams: (document, position, context) => ({ ...params(document, position), context }) },
    protocol2CodeConverter: { asDefinitionResult: convert('definition'), asDocumentHighlights: convert('documentHighlight'), asReferences: convert('references') }
  });
  t.after(() => index.dispose());
  const open = (uri = 'untitled:Buffer-1', version = 1) => {
    const document = { uri: { scheme: uri.split(':')[0], toString: () => uri }, languageId: 'selected',
      version, isClosed: false, getText: () => 'current source' };
    workspace.textDocuments.push(document); opened.emit(document); return document;
  };
  const call = (method, document, next = () => { throw new Error('Unexpected fallback'); }) =>
    method === 'references' ? index.provideReferences(document, { line: 1, character: 2 }, { includeDeclaration: true }, token, next)
      : index[method === 'definition' ? 'provideDefinition' : 'provideDocumentHighlights'](document, { line: 1, character: 2 }, token, next);
  return { index, open, call, workspace, statuses, sent, converted, changed,
    answer: fn => { answer = fn; }, conversion: fn => { conversion = fn; },
    close(document) { document.isClosed = true; workspace.textDocuments.splice(workspace.textDocuments.indexOf(document), 1); closed.emit(document); } };
}
for (const method of ['definition', 'documentHighlight', 'references']) {
  test(`${method} uses the selector and real file and untitled URIs with scanning disabled`, async t => {
    const p = fixture(t);
    for (const uri of ['file:///outside/source', 'untitled:Buffer-1?part=2#cell']) {
      const document = p.open(uri);
      p.answer((received, params) => { assert.equal(received, `textDocument/${method}`); assert.equal(params.textDocument.uri, uri); return [{ independent: true }]; });
      assert.deepEqual(await p.call(method, document), [{ independent: true }]);
      assert.ok(p.sent.some(message => message.method === 'textDocument/didOpen' && message.params.textDocument.uri === uri));
    }
    assert.deepEqual(p.converted, [method, method]);
    const unsupported = p.open('custom:buffer');
    assert.equal(await p.call(method, unsupported, () => 'unsupported'), 'unsupported');
    unsupported.uri.scheme = 'file'; unsupported.languageId = 'unselected';
    assert.equal(await p.call(method, unsupported, () => 'unselected'), 'unselected');
  });
  test(`${method} falls back only for a failed source and preserves authoritative empty results`, async t => {
    const p = fixture(t), document = p.open();
    let fallbacks = 0;
    const next = () => { fallbacks++; return 'accepted source'; };
    p.answer(() => null);
    assert.equal(await p.call(method, document, next), 'accepted source');
    p.answer(() => []);
    assert.equal((await p.call(method, document, next)).length, 0);
    assert.equal(fallbacks, 1);
    p.answer(() => { throw Object.assign(new Error('worker failed'), { code: -32803 }); });
    await assert.rejects(p.call(method, document, next), /worker failed/);
    assert.equal(fallbacks, 1);
    assert.equal(p.statuses.at(-1).message, 'worker failed');
  });
  test(`${method} suppresses a superseded source before and after conversion and on same-version reopen`, async t => {
    const p = fixture(t);
    let document = p.open(), deliver, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    p.answer(() => { entered(); return new Promise(resolve => { deliver = resolve; }); });
    const pending = p.call(method, document);
    await waiting;
    p.close(document); document = p.open('untitled:Buffer-1', 1);
    deliver([{ stale: true }]);
    assert.equal((await pending).length, 0);
    p.answer(() => [{ current: true }]);
    p.conversion(async value => { document.version++; return value; });
    assert.equal((await p.call(method, document)).length, 0);
    p.conversion(async value => value);
    assert.deepEqual(await p.call(method, document), [{ current: true }]);
    assert.ok(p.sent.some(message => message.method === 'textDocument/didChange' && message.params.textDocument.version === 2));
  });
  test(`${method} asks again when another open source changes during delivery`, async t => {
    const p = fixture(t), origin = p.open('file:///origin'), dependency = p.open('file:///target');
    const location = line => [{ uri: 'file:///target', range: { start: { line, character: 8 }, end: { line, character: 11 } } }];
    const stale = location(2), current = location(3);
    const change = () => {
      dependency.version++;
      p.changed.emit({ document: dependency, contentChanges: [{ text: '\ncurrent source' }] });
    };
    let asked = 0;
    p.answer(() => { asked++; if (asked === 1) change(); return asked === 1 ? stale : current; });
    assert.deepEqual(await p.call(method, origin), current);
    assert.equal(asked, 2);
    let converting = 0;
    asked = 0;
    p.answer(() => { asked++; return asked === 1 ? stale : current; });
    p.conversion(async value => { if (++converting === 1) change(); return value; });
    assert.deepEqual(await p.call(method, origin), current);
    assert.equal(asked, 2);
    p.conversion(async value => value);
    p.answer(() => { change(); return stale; });
    assert.equal((await p.call(method, origin)).length, 0, 'Sources that never settle give nothing, not a stale location');
  });
}
