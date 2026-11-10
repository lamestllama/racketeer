// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./support/node-test');
const { until } = require('./support/wait');
function event() {
  const callbacks = new Set();
  return { listen: callback => { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; },
    emit: value => callbacks.forEach(callback => callback(value)) };
}
function fixture(t) {
  const opened = event(), closed = event(), changed = event(), statuses = [], sent = [], converted = [];
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  let answer = () => [], conversion = async value => value, closedConnection;
  let initialising = async () => ({});
  const workspace = { textDocuments: [], workspaceFolders: [],
    getConfiguration: () => ({ get: () => ({ enabled: false }) }),
    onDidOpenTextDocument: opened.listen, onDidCloseTextDocument: closed.listen,
    onDidChangeTextDocument: changed.listen, onDidChangeWorkspaceFolders: event().listen,
    onDidChangeConfiguration: event().listen };
  const connection = { listen() {}, dispose() {}, onNotification() {}, onError() {}, onClose(callback) { closedConnection = callback; }, onRequest() {}, onUnhandledProgress() {},
    sendNotification: async (method, params) => { sent.push({ method, params }); },
    sendRequest: async (method, params) => { sent.push({ method, params }); return method === 'initialize' ? initialising() : method.startsWith('textDocument/') ? answer(method, params) : {}; } };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../vscode/workspace-index.js');
  const dependencies = { 'node:path': path, 'node:process': process, vscode: { workspace, Uri: { parse: value => ({ toString: () => value }) } },
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
    crash: () => closedConnection(), initialise: fn => { initialising = fn; },
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
    assert.equal(await p.call(method, origin, () => 'accepted source'), 'accepted source',
      'Sources that never settle fall back without delivering a stale location');
    p.answer(() => { throw Object.assign(new Error('settings changed'), { code: -32801 }); });
    assert.equal(await p.call(method, origin, () => 'accepted source'), 'accepted source');
  });
}

test('initialize identifies the extension host process', async t => {
  const p = fixture(t);
  await p.index.start();
  assert.equal(p.sent.find(message => message.method === 'initialize').params.processId, process.pid);
});

test('a crashed index restarts at most three times and restores current open documents', async t => {
  const p = fixture(t), doc = p.open('file:///origin');
  await p.index.start();
  for (let crash = 0; crash < 3; crash++) {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    p.initialise(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    p.crash();
    await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error('Index did not restart')), 2000))]);
    doc.version++; doc.getText = () => `source ${doc.version}`;
    p.changed.emit({ document: doc, contentChanges: [{ text: doc.getText() }] });
    const closed = p.open('file:///closed'); p.close(closed);
    release({});
    await until(() => p.sent.filter(message => message.method === 'textDocument/didOpen' && message.params.textDocument.uri === 'file:///origin').length === crash + 2);
    assert.equal(p.sent.filter(message => message.method === 'textDocument/didOpen').at(-1).params.textDocument.text, doc.getText());
    assert.equal((await p.call('definition', doc)).length, 0);
  }
  p.crash();
  assert.equal(p.statuses.at(-1).state, 'failed');
  await assert.rejects(p.index.start(), /stopped/i);
  assert.equal(p.sent.filter(message => message.method === 'initialize').length, 4);
});

test('a connection closing during initialisation restarts and synchronises open documents', async t => {
  const p = fixture(t), doc = p.open('file:///origin');
  let entered, reject, restarted;
  const initialising = new Promise(resolve => { entered = resolve; });
  const again = new Promise(resolve => { restarted = resolve; });
  p.initialise(() => { entered(); return new Promise((_, fail) => { reject = fail; }); });
  const pending = p.index.start();
  await initialising;
  p.initialise(() => { restarted(); return {}; });
  p.crash(); reject(new Error('Connection closed'));
  await assert.rejects(pending, /Connection closed/);
  let timer;
  try {
    await Promise.race([again, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Index did not restart')), 2000); })]);
  } finally { clearTimeout(timer); }
  await p.index.start();
  assert.ok(p.sent.some(message => message.method === 'textDocument/didOpen' && message.params.textDocument.uri === doc.uri.toString()));
  assert.equal(p.statuses.filter(status => status.state === 'failed').length, 0);
});
