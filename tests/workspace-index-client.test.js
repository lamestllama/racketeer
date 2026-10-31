'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }));
const { root, definition, uses, uri, addon } = require('./workspace-index-project');

function event() {
  const listeners = new Set();
  return { listen(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; },
    emit(value) { for (const listener of listeners) listener(value); } };
}
function client(t, processFactory) {
  const vm = require('node:vm');
  const { fileURLToPath } = require('node:url');
  const { createLanguageProcess } = require('../vscode/language-process');
  fs.mkdirSync(path.join(root, '.test-output'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.test-output', 'separate-index-'));
  const changed = event(), opened = event(), closed = event(), disk = event();
  const statuses = [];
  const parse = value => ({ scheme: 'file', fsPath: fileURLToPath(value), toString: () => value });
  const workspace = {
    workspaceFolders: [{ uri: parse(uri(directory)) }], textDocuments: [],
    getConfiguration: () => ({ get: () => ({ enabled: true, timeoutSeconds: 20 }) }),
    onDidOpenTextDocument: opened.listen, onDidCloseTextDocument: closed.listen,
    onDidChangeTextDocument: changed.listen, onDidChangeWorkspaceFolders: event().listen,
    onDidRenameFiles: event().listen, onDidChangeConfiguration: event().listen,
    createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disk.listen,
      onDidChange: disk.listen, onDidDelete: disk.listen })
  };
  const dependencies = {
    vscode: { workspace, Uri: { parse }, Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
      Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
      TextEdit: class { constructor(range, newText) { this.range = range; this.newText = newText; } },
      WorkspaceEdit: class extends Map { set(uri, edits) { return super.set(uri.toString(), edits); } } },
    'node:path': path, 'vscode-languageclient/node': rpc,
    './language-process': { createLanguageProcess: processFactory || ((command, args, options, lifecycle) =>
      createLanguageProcess(command, args, { ...options, env: { ...process.env, PLTADDONDIR: addon } }, lifecycle)) }
  };
  const module = { exports: {} };
  const filename = path.join(root, 'vscode/workspace-index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => dependencies[name] }, { filename });
  const index = module.exports.createWorkspaceIndex({ asAbsolutePath: file => path.join(root, 'vscode', file) }, {
    executable: 'racket', timeout: 60000, output: { append() {}, appendLine() {} }, onStatus: value => statuses.push(value)
  });
  t.after(async () => { await index.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const open = (name, text) => {
    const document = { uri: parse(uri(path.join(directory, name))), languageId: 'racket', version: 1,
      isClosed: false, getText: () => text };
    workspace.textDocuments.push(document); opened.emit(document); return document;
  };
  const refs = document => index.provideReferences(document, { line: 2, character: 10 },
    { includeDeclaration: false }, rpc.CancellationToken.None, () => { throw new Error('Unexpected LSP fallback'); });
  return { index, directory, open, refs, closed, changed, disk, parse, workspace, statuses, vscode: dependencies.vscode };
}

function indexPeer(t, initialize = () => ({}), starting = Promise.resolve()) {
  const { PassThrough } = require('node:stream');
  const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout));
  const snapshots = [];
  connection.onRequest('initialize', params => { snapshots.push(params); return initialize(); });
  connection.onNotification('update', params => snapshots.push(params));
  connection.onRequest('references', () => []);
  connection.listen();
  const c = client(t, () => ({
    async start() { await starting; return child; }, ready() {}, cancelStart() {},
    async dispose() {
      connection.dispose();
      for (const stream of Object.values(child)) stream.destroy();
    }
  }));
  return { ...c, snapshots, connection, disconnect: () => child.stdout.destroy() };
}

for (const method of ['initialize', 'references', 'prepareRename', 'rename']) {
  test(`index rejects pending ${method} when its transport closes`, { timeout: 5000 }, async t => {
    const c = indexPeer(t), doc = c.open('definition.rkt', definition);
    if (method !== 'initialize') await c.index.start();
    let entered, timer;
    const received = new Promise(resolve => { entered = resolve; });
    c.connection.onRequest(method, () => { entered(); return new Promise(() => {}); });
    const position = { line: 2, character: 10 }, token = rpc.CancellationToken.None;
    const request = method === 'initialize' ? c.index.start()
      : method === 'references' ? c.refs(doc)
      : method === 'prepareRename' ? c.index.prepareRename(doc, position, token)
      : c.index.provideRenameEdits(doc, position, 'squared', token);
    const rejected = assert.rejects(request, { code: rpc.ErrorCodes.PendingResponseRejected });
    await received;
    c.disconnect();
    try {
      await Promise.race([rejected, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Request remained pending after transport closure')), 1000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(c.statuses.at(-1).state, 'failed');
  });
}

test('index skips a duplicate startup snapshot', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  await c.index.start(); await c.refs(doc);
  assert.equal(c.snapshots.length, 1, 'Initialization already supplies the current workspace');
});

test('only document open and close events permit verified index reuse', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  await c.index.start(); await c.refs(doc);
  assert.equal(c.snapshots.at(-1).documentsOnly, false);
  const consumer = c.open('uses.rkt', uses); await c.refs(doc);
  assert.equal(c.snapshots.at(-1).documentsOnly, true);
  consumer.isClosed = true; c.closed.emit(consumer); await c.refs(doc);
  assert.equal(c.snapshots.at(-1).documentsOnly, true);
  doc.version++; c.changed.emit({ document: doc, contentChanges: [{ text: definition }] });
  await c.refs(doc);
  assert.equal(c.snapshots.at(-1).documentsOnly, false);
  c.disk.emit(doc.uri); await c.refs(doc);
  assert.equal(c.snapshots.at(-1).documentsOnly, false);
  c.index.refresh({ added: [] }); await c.refs(doc);
  assert.equal(c.snapshots.at(-1).documentsOnly, false, 'Event payloads must not enable reuse');
});

test('index skips unchanged document notifications but synchronizes versions and content', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  await c.index.start(); await c.refs(doc);
  const initial = c.snapshots.length;
  doc.isDirty = true; c.changed.emit({ document: doc, contentChanges: [] });
  doc.isDirty = false; c.changed.emit({ document: doc, contentChanges: [] });
  await c.refs(doc);
  assert.equal(c.snapshots.length, initial, 'Dirty-state notifications must not restart unchanged analysis');
  doc.version++; c.changed.emit({ document: doc, contentChanges: [] });
  await c.refs(doc);
  assert.equal(c.snapshots.length, initial + 1, 'A new version must still reach the index');
  assert.equal(c.snapshots.at(-1).documents[0].version, doc.version);
  doc.version++; doc.getText = () => definition + '(square 4)\n';
  c.changed.emit({ document: doc, contentChanges: [{ text: doc.getText() }] });
  await c.refs(doc);
  assert.equal(c.snapshots.length, initial + 2);
  assert.equal(c.snapshots.at(-1).documents[0].text, doc.getText());
  c.disk.emit(doc.uri); await c.refs(doc);
  assert.equal(c.snapshots.length, initial + 3, 'Disk events must invalidate analysis even with unchanged buffers');
});

test('index synchronizes edits and document replacement during initialization', async t => {
  let doc, reopened;
  const c = indexPeer(t, () => {
    doc.version++; doc.getText = () => definition + '(square 4)\n';
    c.changed.emit({ document: doc, contentChanges: [{ text: doc.getText() }] });
    doc.isClosed = true; c.closed.emit(doc);
    c.workspace.textDocuments.splice(c.workspace.textDocuments.indexOf(doc), 1);
    reopened = c.open('definition.rkt', doc.getText());
    c.disk.emit(reopened.uri);
    return {};
  });
  doc = c.open('definition.rkt', definition);
  await c.index.start(); await c.refs(reopened);
  assert.equal(c.snapshots.length, 2, 'Send the latest snapshot once initialization completes');
  const before = c.snapshots[0].documents[0], after = c.snapshots[1].documents[0];
  assert.equal(before.text, definition);
  assert.equal(after.text, reopened.getText());
  assert.notEqual(before.identity, after.identity, 'Reopening the URI creates a new document lifetime');
  assert.equal(after.version, reopened.version);
  assert.ok(c.snapshots[1].revision > c.snapshots[0].revision);
});

test('index includes edits made before its initialization snapshot without rescanning', async t => {
  let ready;
  const c = indexPeer(t, undefined, new Promise(resolve => { ready = resolve; }));
  const doc = c.open('definition.rkt', definition);
  const starting = c.index.start();
  doc.version++; doc.getText = () => definition + '(square 5)\n';
  c.changed.emit({ document: doc, contentChanges: [{ text: doc.getText() }] });
  ready(); await starting; await c.refs(doc);
  assert.equal(c.snapshots.length, 1);
  assert.equal(c.snapshots[0].documents[0].text, doc.getText());
  assert.equal(c.snapshots[0].documents[0].version, doc.version);
});

test('extension index client watches relative to roots and sends authoritative buffer snapshots', { timeout: 120000 }, async t => {
  const c = client(t);
  fs.writeFileSync(path.join(c.directory, 'definition.rkt'), definition);
  const consumer = path.join(c.directory, 'uses.rkt'); fs.writeFileSync(consumer, uses);
  const doc = c.open('definition.rkt', definition);
  await c.index.start();
  const count = async () => (await c.refs(doc)).filter(location => location.uri.fsPath === consumer).length;
  assert.equal(await count(), 1);
  fs.appendFileSync(consumer, '(square 4)\n'); c.disk.emit(c.parse(uri(consumer)));
  assert.equal(await count(), 2, 'A .test-output ancestor does not exclude the workspace');
  const buffer = c.open('uses.rkt', uses + '(square 4)\n(square 5)\n');
  assert.equal(await count(), 3);
  buffer.isClosed = true; c.closed.emit(buffer);
  assert.equal(await count(), 2, 'Close uses disk even while VS Code still lists the closed document');
  const position = { line: 2, character: 10 }, token = rpc.CancellationToken.None;
  const prepared = await c.index.prepareRename(doc, position, token);
  assert.equal(prepared.start.character, 9);
  const edit = await c.index.provideRenameEdits(doc, position, 'squared', token);
  assert.equal(edit.get(uri(consumer)).length, 2);
  assert.equal(edit.get(doc.uri.toString()).length, 2);
  assert.equal(fs.readFileSync(consumer, 'utf8'), uses + '(square 4)\n');
  const cancellation = new rpc.CancellationTokenSource();
  const pending = c.index.provideRenameEdits(doc, position, 'squared', cancellation.token)
    .then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate); // Let the request enter the RPC connection.
  cancellation.cancel();
  const cancelled = await pending;
  cancellation.dispose();
  assert.equal(cancelled.error, undefined, 'Cancelling rename must not become an editor error');
  assert.equal(cancelled.value, undefined);
});

test('disposing the index cancels and reaps an unresponsive initializing process', { timeout: 10000 }, async t => {
  const { createLanguageProcess } = require('../vscode/language-process');
  let child, spawned;
  const entered = new Promise(resolve => { spawned = resolve; });
  const c = client(t, (_command, _args, _options, lifecycle) => {
    const owned = createLanguageProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, lifecycle);
    return { ...owned, async start() { child = await owned.start(); spawned(); return child; } };
  });
  const starting = c.index.start().catch(() => {});
  await entered;
  await c.index.dispose(); await starting;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('captured references survive source document replacement and reject changed text', { timeout: 120000 }, async t => {
  const c = client(t);
  const source = path.join(c.directory, 'definition.rkt');
  const consumer = path.join(c.directory, 'uses.rkt');
  fs.writeFileSync(source, definition);
  fs.writeFileSync(consumer, uses);
  const file = c.open('definition.rkt', definition);
  const captured = { ...file, uri: { scheme: 'debug', toString: () => 'debug:captured-definition' },
    getText: () => definition.replace(/\n/g, '\r\n') };
  c.workspace.textDocuments.push(captured);
  let provider, tracker;
  const terminated = event();
  const vscode = c.vscode;
  const disposable = () => ({ dispose() {} });
  vscode.Uri.file = filename => c.parse(uri(filename));
  vscode.EventEmitter = class { event = event().listen; fire() {} dispose() {} };
  vscode.debug = {
    registerDebugAdapterTrackerFactory(_type, factory) { tracker = factory.createDebugAdapterTracker({ id: 'session' }); return disposable(); },
    asDebugSourceUri: () => captured.uri, onDidTerminateDebugSession: terminated.listen
  };
  vscode.languages = {
    onDidChangeDiagnostics: event().listen,
    registerHoverProvider: disposable, registerDefinitionProvider: disposable,
    registerReferenceProvider(_selector, value) { provider = value; return disposable(); }
  };
  vscode.workspace.openTextDocument = async () => c.workspace.textDocuments.find(document =>
    !document.isClosed && document.uri.scheme === 'file' && document.uri.fsPath === source) ||
    { getText: () => fs.readFileSync(source, 'utf8') };
  const loaded = { exports: {} };
  const bridge = path.join(root, 'vscode/debug-sources.js');
  require('node:vm').runInNewContext(fs.readFileSync(bridge, 'utf8'), {
    module: loaded, require: () => vscode
  }, { filename: bridge });
  const subscriptions = [];
  const sources = loaded.exports.registerDebugSources({ subscriptions });
  t.after(() => subscriptions.forEach(item => item.dispose()));
  tracker.onDidSendMessage({ type: 'event', event: 'loadedSource',
    body: { reason: 'new', source: { path: source, sourceReference: 1 } } });
  sources.setLanguageClient({}, (...args) => c.index.provideReferences(...args));
  const marker = path.join(c.directory, 'entered');
  const blocker = path.join(c.directory, 'blocked.rkt');
  fs.writeFileSync(blocker, `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(marker)} #:exists 'truncate
    (lambda (out) (display "entered" out)))
  (sync never-evt))\n`);
  const position = { line: 2, character: 10 };
  const refs = (token = rpc.CancellationToken.None) => provider.provideReferences(captured, position,
    { includeDeclaration: false }, token);
  const pending = refs();
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(marker)) {
    assert.ok(Date.now() < deadline, 'Index enters blocked expansion');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  file.isClosed = true; c.closed.emit(file);
  c.workspace.textDocuments.splice(c.workspace.textDocuments.indexOf(file), 1);
  const reopened = c.open('definition.rkt', definition);
  fs.unlinkSync(blocker); c.disk.emit(c.parse(uri(blocker)));
  const count = locations => locations.filter(location => location.uri.fsPath === consumer).length;
  assert.equal(count(await pending), 1, 'The request belongs to the captured source, not the replaced file document');
  reopened.isClosed = true; c.closed.emit(reopened);
  c.workspace.textDocuments.splice(c.workspace.textDocuments.indexOf(reopened), 1);
  assert.equal(count(await refs()), 1, 'Closed files can supply references for matching captured source');
  fs.writeFileSync(source, '('); c.disk.emit(c.parse(uri(source)));
  assert.ok(!(await refs())?.length, 'Changed disk text is rejected before expansion');
  fs.unlinkSync(source); c.disk.emit(c.parse(uri(source)));
  assert.ok(!(await refs())?.length, 'Deleted source cannot supply references');
  fs.writeFileSync(source, definition + '; disk has changed\n'); c.disk.emit(c.parse(uri(source)));
  const buffer = c.open('definition.rkt', definition);
  assert.equal(count(await refs()), 1, 'A matching unsaved buffer takes precedence over disk');
  buffer.version++; buffer.getText = () => '(';
  c.changed.emit({ document: buffer, contentChanges: [{ text: buffer.getText() }] });
  assert.ok(!(await refs())?.length, 'Stale captured source cannot use changed buffer text');
  const cancel = new rpc.CancellationTokenSource();
  const cancelled = refs(cancel.token); cancel.cancel();
  assert.ok(!(await cancelled)?.length); cancel.dispose();
  buffer.version++; buffer.getText = () => definition;
  c.changed.emit({ document: buffer, contentChanges: [{ text: buffer.getText() }] });
  const openDocument = vscode.workspace.openTextDocument;
  vscode.workspace.openTextDocument = async () => {
    captured.version++; captured.getText = () => '\n' + definition;
    buffer.version++; buffer.getText = captured.getText;
    c.changed.emit({ document: buffer, contentChanges: [{ text: buffer.getText() }] });
    return openDocument();
  };
  assert.ok(!(await refs())?.length, 'Source changes during final validation discard earlier locations');
  vscode.workspace.openTextDocument = openDocument;
  const ending = refs();
  terminated.emit({ id: 'session' });
  assert.equal(await ending, undefined, 'Ending the session discards pending source references');
  assert.equal(await refs(), undefined, 'Completed sessions cannot supply source references');
});
