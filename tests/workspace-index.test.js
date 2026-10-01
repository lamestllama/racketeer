'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const rpc = require('../vscode/node_modules/vscode-jsonrpc/node');
const root = path.resolve(__dirname, '..');
const definition = '#lang racket/base\n(provide square)\n(define (square x) (* x x))\n';
const uses = '#lang racket/base\n(require "definition.rkt")\n(square 3)\n';
const uri = file => pathToFileURL(file).href;
const addon = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-index-addon-'));
test.after(() => fs.rmSync(addon, { recursive: true, force: true }));

async function project(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-index-')));
  const documents = new Map(), notifications = [];
  let revision = 0, identity = 0, diagnostics = '';
  const child = spawn('racket', [path.join(root, 'vscode/workspace-index-server.rkt')], {
    cwd: directory, stdio: 'pipe', env: { ...process.env, PLTADDONDIR: addon }
  });
  const closed = once(child, 'close');
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { diagnostics += text; });
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  connection.onNotification('status', status => notifications.push(status));
  connection.listen();
  t.after(async () => {
    connection.dispose(); child.kill('SIGKILL');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = name => path.join(directory, name);
  const write = (name, text) => fs.writeFileSync(filename(name), text);
  const open = (name, text, version = 1) => {
    const key = name.startsWith('file:') ? name : uri(filename(name));
    documents.set(key, { uri: key, text, version, identity: ++identity });
    return key;
  };
  const settings = { enabled: true, timeoutSeconds: 20 };
  const snapshot = () => ({ revision: ++revision, roots: [uri(directory)], documents: [...documents.values()], settings });
  const update = () => connection.sendNotification('update', snapshot());
  const references = (key, position = { line: 2, character: 10 }, includeDeclaration = false, token = rpc.CancellationToken.None) => {
    const document = documents.get(key);
    return connection.sendRequest('references', { uri: key, identity: document.identity,
      version: document.version, position, includeDeclaration }, token);
  };
  write('definition.rkt', definition); write('uses.rkt', uses);
  const origin = open('definition.rkt', definition);
  await connection.sendRequest('initialize', snapshot());
  return { directory, documents, notifications, filename, write, open, origin, update, references, settings,
    diagnostics: () => diagnostics };
}

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
  assert.match(p.diagnostics(), /blocked\.rkt \(analysis exceeded its time or memory limit\)/);
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
  fs.unlinkSync(p.filename('blocked.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
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

function event() {
  const listeners = new Set();
  return { listen(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; },
    emit(value) { for (const listener of listeners) listener(value); } };
}
function client(t, processFactory) {
  const vm = require('node:vm');
  const { fileURLToPath } = require('node:url');
  const { createLanguageProcess } = require('../vscode/language-process');
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
      Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } } },
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
  return { index, directory, open, refs, closed, disk, parse, workspace, statuses };
}

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
