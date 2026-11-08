// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { removeQuietly } = require('./cleanup');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }));
const { root, definition, uses, uri, addon } = require('./workspace-index-project');

function event() {
  const listeners = new Set();
  return { listen(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; },
    emit(value) { for (const listener of listeners) listener(value); } };
}
function client(t, processFactory, timeout = 60000, environment = {}) {
  const vm = require('node:vm');
  const { fileURLToPath } = require('node:url');
  const { createLanguageProcess, ownedArgs } = require('../vscode/language-process');
  fs.mkdirSync(path.join(root, '.test-output'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.test-output', 'separate-index-'));
  const changed = event(), opened = event(), closed = event(), disk = event();
  const statuses = [];
  const parse = value => ({ scheme: 'file', fsPath: fileURLToPath(value), toString: () => value });
  const workspace = {
    workspaceFolders: [{ uri: parse(uri(directory)) }], textDocuments: [],
    getConfiguration: () => ({ get: () => ({ enabled: true, timeoutSeconds: 120 }) }),
    onDidOpenTextDocument: opened.listen, onDidCloseTextDocument: closed.listen,
    onDidChangeTextDocument: changed.listen, onDidChangeWorkspaceFolders: event().listen,
    onDidChangeConfiguration: event().listen,
    createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: event().listen,
      onDidChange: disk.listen, onDidDelete: event().listen })
  };
  const dependencies = {
    vscode: { workspace, Uri: { parse }, RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } }, Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
      Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
      TextEdit: class { constructor(range, newText) { this.range = range; this.newText = newText; } },
      WorkspaceEdit: class extends Map { set(uri, edits) { return super.set(uri.toString(), edits); } } },
    'node:path': path, 'vscode-languageclient/node': environment.rpc || rpc,
    './racket-version': require('../vscode/racket-version'),
    './language-process': { ownedArgs, createLanguageProcess: processFactory || ((command, args, options, lifecycle) =>
      createLanguageProcess(command, args, { ...options, env: { ...process.env, PLTADDONDIR: addon } }, lifecycle)) }
  };
  const module = { exports: {} };
  const filename = path.join(root, 'vscode/workspace-index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => name === './selected-editor' ? require('../vscode/selected-editor') : dependencies[name], setInterval, clearInterval, setTimeout, clearTimeout, ...environment }, { filename });
  const index = module.exports.createWorkspaceIndex({ asAbsolutePath: file => path.join(root, 'vscode', file) }, {
    executable: 'racket', timeout, output: { append() {}, appendLine() {} }, onStatus: value => statuses.push(value)
  });
  t.after(async () => { await index.dispose(); removeQuietly(directory); });
  const open = (name, text) => {
    const document = { uri: parse(uri(path.join(directory, name))), languageId: 'racket', version: 1,
      isClosed: false, getText: () => text };
    workspace.textDocuments.push(document); opened.emit(document); return document;
  };
  const refs = document => index.provideReferences(document, { line: 2, character: 10 },
    { includeDeclaration: false }, rpc.CancellationToken.None, () => { throw new Error('Unexpected LSP fallback'); });
  return { index, directory, open, refs, closed, changed, disk, parse, workspace, statuses, vscode: dependencies.vscode };
}

function indexPeer(t, initialize = () => ({}), starting = Promise.resolve(), timeout, environment) {
  const { PassThrough } = require('node:stream');
  const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout));
  // The assertions read the wire as snapshots: one for each message that changes
  // the source view, with the documents as a server's registry then holds them.
  const snapshots = [], documents = new Map();
  let lifetimes = 0, opened = false;
  const snapshot = (documentsOnly = false) => {
    snapshots.push({ revision: snapshots.length + 1, documentsOnly: documentsOnly && opened,
      documents: [...documents.values()].map(document => ({ ...document })) });
    // The opens that follow initialized belong to the first pass.
    opened = true;
  };
  connection.onRequest('initialize', () => initialize());
  connection.onNotification('initialized', () => {
    void connection.sendRequest('client/registerCapability', { registrations: [{ id: 'folder', method: 'workspace/didChangeWatchedFiles',
      registerOptions: { watchers: [{ globPattern: { baseUri: uri(c.directory), pattern: '**/*' } }] } }] }).catch(() => {});
  });
  connection.onNotification('textDocument/didOpen', ({ textDocument: { uri: key, version, text } }) => {
    documents.set(key, { uri: key, identity: ++lifetimes, version, text });
    snapshot(true);
  });
  connection.onNotification('textDocument/didChange', ({ textDocument: { uri: key, version }, contentChanges }) => {
    Object.assign(documents.get(key), { version, text: contentChanges.at(-1).text });
    snapshot();
  });
  connection.onNotification('textDocument/didClose', ({ textDocument: { uri: key } }) => {
    documents.delete(key);
    snapshot(true);
  });
  connection.onNotification('workspace/didChangeWatchedFiles', () => snapshot());
  connection.onRequest('workspace/executeCommand', () => { snapshot(); return null; });
  connection.onRequest('textDocument/references', () => []);
  connection.listen();
  const c = client(t, () => ({
    async start() { await starting; return child; }, ready() {}, cancelStart() {},
    async dispose() {
      // A process reads what was written to it before its pipes close.
      await new Promise(resolve => setTimeout(resolve, 50));
      connection.dispose();
      for (const stream of Object.values(child)) stream.destroy();
    }
  }), timeout, environment);
  return { ...c, snapshots, connection, disconnect: () => child.stdout.destroy() };
}
const wire = method => method === 'initialize' ? method : `textDocument/${method}`;

for (const method of ['initialize', 'references', 'prepareRename', 'rename']) {
  test(`index rejects pending ${method} when its transport closes`, async t => {
    const c = indexPeer(t), doc = c.open('definition.rkt', definition);
    if (method !== 'initialize') await c.index.start();
    let entered, timer;
    const received = new Promise(resolve => { entered = resolve; });
    c.connection.onRequest(wire(method), () => { entered(); return new Promise(() => {}); });
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
        timer = setTimeout(() => reject(new Error('Request remained pending after transport closure')), 240000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(c.statuses.at(-1).state, 'failed');
  });
}

test('an index that stops answering cleans up before falling back and refuses further requests', async t => {
  let now = 0, sourcesDisposed = 0;
  const intervals = new Set(), listeners = new Set();
  const c = indexPeer(t, undefined, undefined, 1500, {
    rpc: { ...rpc, CancellationTokenSource: class extends rpc.CancellationTokenSource {
      dispose() { sourcesDisposed++; super.dispose(); }
    } },
    Date: { now: () => now },
    setInterval: fn => { intervals.add(fn); return fn; },
    clearInterval: fn => intervals.delete(fn)
  }), doc = c.open('definition.rkt', definition);
  await c.index.start();
  let entered;
  const received = new Promise(resolve => { entered = resolve; });
  c.connection.onRequest(wire('references'), () => { entered(); return new Promise(() => {}); });
  const position = { line: 2, character: 10 }, token = { isCancellationRequested: false,
    onCancellationRequested(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
  const pending = c.index.provideReferences(doc, position, { includeDeclaration: false }, token, () => 'language server');
  await received;
  assert.equal(intervals.size, 1); assert.equal(listeners.size, 1);
  now = 1501; for (const fn of intervals) fn();
  assert.equal(await pending, 'language server');
  assert.equal(intervals.size, 0, 'The fallback has no remaining watchdog');
  assert.equal(listeners.size, 0, 'The fallback releases the caller listener');
  assert.equal(sourcesDisposed, 1, 'The fallback disposes its cancellation source');
  const failures = c.statuses.filter(s => s.state === 'failed').length;
  now *= 2; for (const fn of intervals) fn();
  assert.equal(c.statuses.filter(s => s.state === 'failed').length, failures);
  await assert.rejects(c.index.provideRenameEdits(doc, position, 'squared', token), /stopped answering/);
  assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
});

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
  assert.equal(c.snapshots.length, 1, 'The server hears of documents only after initialisation, so it hears the latest state once');
  const before = c.snapshots[0].documents[0];
  assert.equal(before.text, reopened.getText());
  assert.equal(before.version, reopened.version);
  reopened.isClosed = true; c.closed.emit(reopened);
  c.workspace.textDocuments.splice(c.workspace.textDocuments.indexOf(reopened), 1);
  const again = c.open('definition.rkt', reopened.getText());
  await c.refs(again);
  const after = c.snapshots.at(-1).documents[0];
  assert.notEqual(before.identity, after.identity, 'Reopening the URI creates a new document lifetime');
  assert.ok(c.snapshots.at(-1).revision > c.snapshots[0].revision);
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

test('extension index client watches relative to roots and sends authoritative buffer snapshots', async t => {
  const c = client(t);
  fs.writeFileSync(path.join(c.directory, 'definition.rkt'), definition);
  const consumer = path.join(c.directory, 'uses.rkt'); fs.writeFileSync(consumer, uses);
  const doc = c.open('definition.rkt', definition);
  await c.index.start();
  const count = async () => (await c.refs(doc)).filter(location => location.uri.fsPath === consumer).length;
  assert.equal(await count(), 1);
  const passing = c.statuses.filter(status => status.state === 'indexing');
  assert.ok(passing.some(status => status.message === '2/2'), 'What the status bar counts comes from standard progress');
  assert.equal(c.statuses.at(-1).state, 'ready');
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

test('disposing the index cancels and reaps an unresponsive initializing process', async t => {
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

test('a file event reaches the server at once only for a source file or a name with no suffix', async t => {
  const c = indexPeer(t);
  c.open('definition.rkt', definition);
  await c.index.start();
  // The next event's arrival shows that the ones before it sent nothing.
  const updated = async expected => {
    await until(() => c.snapshots.length >= expected);
    assert.equal(c.snapshots.length, expected);
  };
  const event = name => c.disk.emit(c.parse(`file://${path.join(c.directory, name)}`));
  await updated(1);
  for (const name of ['program.log', 'output.json', 'picture.png']) event(name);
  await updated(1);
  event('uses.rkt');
  await updated(2);
  event('removed-folder');
  await updated(3);
});

test('the server starts at the first request, not for documents, edits or a refresh', async t => {
  let started = 0;
  const c = indexPeer(t, () => { started++; return {}; });
  const doc = c.open('definition.rkt', definition);
  doc.version++; c.changed.emit({ document: doc, contentChanges: [{ text: definition }] });
  c.index.refresh();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(started, 0);
  await c.refs(doc);
  assert.equal(started, 1);
  assert.equal(c.snapshots.length, 1, 'It hears the current documents once');
});

test('a file event outside the source suffixes waits for the next request and arrives once per folder', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition), order = [];
  const event = name => c.disk.emit(c.parse(`file://${path.join(c.directory, name)}`));
  await c.index.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  c.connection.onNotification('workspace/didChangeWatchedFiles', ({ changes }) => order.push(changes.map(change => path.basename(change.uri))));
  c.connection.onRequest(wire('references'), () => { order.push('request'); return []; });
  for (const name of ['program.log', 'program.log', 'later.log', 'build/output.json']) event(name);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(order, [], 'A request that is waiting cannot be held up by them');
  await c.refs(doc);
  assert.deepEqual(order, [['later.log', 'output.json'], 'request']);
  await c.refs(doc);
  assert.deepEqual(order, [['later.log', 'output.json'], 'request', 'request']);
});

test('moving in or deleting a folder with a dot in its name marks the index out of date', async t => {
  const c = client(t), elsewhere = fs.mkdtempSync(path.join(root, '.test-output', 'dotted-'));
  t.after(() => removeQuietly(elsewhere));
  fs.writeFileSync(path.join(c.directory, 'definition.rkt'), definition);
  const doc = c.open('definition.rkt', definition);
  const folder = path.join(c.directory, 'my.project'), inside = path.join(folder, 'uses.rkt');
  const count = async () => (await c.refs(doc)).filter(location => location.uri.fsPath === inside).length;
  assert.equal(await count(), 0);
  // A watcher reports such a folder by its own name alone, and nothing else tells the index.
  const prepared = path.join(elsewhere, 'my.project');
  fs.mkdirSync(prepared);
  fs.writeFileSync(path.join(prepared, 'uses.rkt'), uses.replace('"definition.rkt"', '"../definition.rkt"'));
  fs.renameSync(prepared, folder);
  c.disk.emit(c.parse(uri(folder)));
  assert.equal(await count(), 1, 'A folder moved in is analysed');
  fs.rmSync(folder, { recursive: true });
  c.disk.emit(c.parse(uri(folder)));
  assert.equal(await count(), 0, 'A folder deleted is gone');
});

test('an event for an excluded folder with a dot in its name does not displace one held beside it', async t => {
  const c = client(t);
  c.workspace.getConfiguration = () => ({ get: () => ({ enabled: true, timeoutSeconds: 120, excludedDirectories: ['ignored.project'] }) });
  fs.writeFileSync(path.join(c.directory, 'definition.rkt'), definition);
  const folder = path.join(c.directory, 'my.project'), inside = path.join(folder, 'uses.rkt');
  fs.mkdirSync(folder);
  fs.writeFileSync(inside, uses.replace('"definition.rkt"', '"../definition.rkt"'));
  const doc = c.open('definition.rkt', definition);
  const count = async () => (await c.refs(doc)).filter(location => location.uri.fsPath === inside).length;
  assert.equal(await count(), 1);
  fs.rmSync(folder, { recursive: true });
  c.disk.emit(c.parse(uri(folder)));
  const excluded = path.join(c.directory, 'ignored.project');
  fs.mkdirSync(excluded);
  c.disk.emit(c.parse(uri(excluded)));
  assert.equal(await count(), 0, 'The deletion still reaches the server');
});

test('disposing a running index shuts its server down before exit', async t => {
  const c = indexPeer(t), order = [];
  c.connection.onRequest('shutdown', () => { order.push('shutdown'); return null; });
  c.connection.onNotification('exit', () => { order.push('exit'); });
  await c.index.start();
  await c.index.dispose();
  assert.deepEqual(order, ['shutdown', 'exit']);
});

test('a server that does not answer shutdown does not hold up dispose', async t => {
  const c = indexPeer(t);
  c.connection.onRequest('shutdown', () => new Promise(() => {}));
  await c.index.start();
  await c.index.dispose();
});

// A rename the peer answers once `during` has happened.
function renameDuring(t, during, version = 1) {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  c.connection.onRequest('textDocument/rename', async () => {
    await during(c, doc);
    return { documentChanges: [{ textDocument: { uri: doc.uri.toString(), version }, edits: [
      { range: { start: { line: 2, character: 9 }, end: { line: 2, character: 15 } }, newText: 'squared' }] }] };
  });
  const request = c.index.start().then(() => c.refs(doc))
    .then(() => c.index.provideRenameEdits(doc, { line: 2, character: 10 }, 'squared', rpc.CancellationToken.None));
  return { c, doc, request };
}
const refused = /Workspace changed during rename/;

test('a rename keeps its edit when an unrelated document opens during it', async t => {
  const { request } = renameDuring(t, c => { c.open('uses.rkt', uses); });
  assert.equal((await request).size, 1);
});

test('a rename keeps its edit when a document it read from disk opens unchanged during it', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  let other;
  const target = uri(path.join(c.directory, 'uses.rkt'));
  c.connection.onRequest('textDocument/rename', async () => {
    other = c.open('uses.rkt', uses);
    return { documentChanges: [{ textDocument: { uri: target, version: null }, edits: [] }] };
  });
  await c.index.start();
  await c.index.provideRenameEdits(doc, { line: 2, character: 10 }, 'squared', rpc.CancellationToken.None);
  other.isDirty = true;
  c.connection.onRequest('textDocument/rename', async () =>
    ({ documentChanges: [{ textDocument: { uri: target, version: null }, edits: [] }] }));
  await assert.rejects(c.index.provideRenameEdits(doc, { line: 2, character: 10 }, 'squared', rpc.CancellationToken.None), refused,
    'A buffer that differs from the disk text refuses the edit');
});

test('a rename refuses its edit when an edited buffer it analysed closes during it', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition), buffer = c.open('uses.rkt', uses);
  buffer.version = 4; buffer.isDirty = true;
  c.connection.onRequest('textDocument/rename', async () => {
    buffer.isClosed = true; c.closed.emit(buffer);
    return { documentChanges: [{ textDocument: { uri: buffer.uri.toString(), version: 4 }, edits: [] }] };
  });
  await c.index.start();
  await assert.rejects(c.index.provideRenameEdits(doc, { line: 2, character: 10 }, 'squared', rpc.CancellationToken.None), refused);
});

test('a rename refuses its edit when a buffer it names reopens at the same version with other text', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition), buffer = c.open('uses.rkt', uses);
  buffer.isDirty = true;
  c.connection.onRequest('textDocument/rename', async () => {
    buffer.isClosed = true; c.closed.emit(buffer);
    c.workspace.textDocuments.splice(c.workspace.textDocuments.indexOf(buffer), 1);
    c.open('uses.rkt', uses.replace('(square 3)', '(string 3)')).isDirty = true;
    return { documentChanges: [{ textDocument: { uri: buffer.uri.toString(), version: 1 }, edits: [
      { range: { start: { line: 2, character: 1 }, end: { line: 2, character: 7 } }, newText: 'squared' }] }] };
  });
  await c.index.start();
  await assert.rejects(c.index.provideRenameEdits(doc, { line: 2, character: 10 }, 'squared', rpc.CancellationToken.None), refused);
});

test('a rename refuses its edit when a document it analysed moves to another version', async t => {
  const { request } = renameDuring(t, () => {}, 5);
  await assert.rejects(request, refused);
});

test('a rename keeps its edit when the server answers after a disk change it has read', async t => {
  const { request } = renameDuring(t, c => { c.disk.emit(c.parse(uri(path.join(c.directory, 'uses.rkt')))); });
  assert.equal((await request).size, 1);
});

test('progress keeps a request from being withdrawn and drives the status', async t => {
  const c = indexPeer(t, undefined, undefined, 1500), doc = c.open('definition.rkt', definition);
  await c.index.start();
  await c.refs(doc);
  c.connection.onRequest('textDocument/references', async () => {
    for (let n = 0; n < 8; n++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await c.connection.sendNotification('$/progress', { token: 'pass', value: { kind: 'report', message: `${n} files analysed` } });
    }
    return [];
  });
  assert.deepEqual(await c.index.provideReferences(doc, { line: 2, character: 10 }, { includeDeclaration: false },
    rpc.CancellationToken.None, () => 'language server'), [], 'Four seconds of progress outlast a watchdog of 1.5 seconds');
  assert.deepEqual({ ...c.statuses.at(-1) }, { state: 'indexing', message: '7 files analysed' });
});

test('references the server refuses in words pass those words on, and the index is not reported stopped', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  const words = 'Workspace sources kept changing for 20 seconds. Try again when they settle.';
  c.connection.onRequest('textDocument/references', () => { throw new rpc.ResponseError(-32803, words); });
  await c.index.start();
  await assert.rejects(c.refs(doc), new RegExp(words));
  assert.deepEqual({ ...c.statuses.at(-1) }, { state: 'refused', message: words });
});

test('final index status reaches the status item', async t => {
  const c = indexPeer(t), doc = c.open('definition.rkt', definition);
  await c.index.start(); await c.refs(doc);
  c.connection.sendNotification('racketeer/indexStatus', { state: 'ready', indexed: 3, failures: 0 });
  await c.refs(doc);
  assert.deepEqual({ ...c.statuses.at(-1) }, { state: 'ready', indexed: 3, failures: 0 });
});
