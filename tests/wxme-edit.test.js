// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const treeRemoval = require('./support/tree-removal');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { WxmeDocument, normalize, hash } = require('../vscode/wxme-document');
const { requestWxme, decodeWxme } = require('../vscode/wxme-process');
const { spawnSync } = require('node:child_process');
const helper = path.resolve(__dirname, '../racketdap/tools/wxme-edit.rkt');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/wxme', name + '.wxme'));
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const uri = file => ({ scheme: 'file', fsPath: file, toString: () => 'file://' + file });
const parts = [{ kind: 'text', text: 'λ 😀\n' }, { kind: 'comment', parts: [] }, { kind: 'text', text: '\nend' }];
function directory(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wxme-edit-')); t.after(() => fs.rmSync(d, treeRemoval)); return d; }
function harness(t) {
  const root = directory(t), file = path.join(root, 'source.wxme');
  fs.writeFileSync(file, JSON.stringify({ parts }));
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(e) { for (const fn of this.listeners) fn(e); }
    dispose() { this.listeners.clear(); }
  }
  const vscode = { EventEmitter, CancellationError: class extends Error {}, Uri: { parse: s => uri(s.slice(7)) },
    workspace: { isTrusted: true, textDocuments: [], getConfiguration: () => ({ get: () => 'racket' }), fs: {
      writeFile: (u, b) => fs.promises.writeFile(u.fsPath, b), delete: u => fs.promises.unlink(u.fsPath)
    } }, window: { registerCustomEditorProvider: () => ({ dispose() {} }), showErrorMessage: message => errors.push(message) },
    commands: { executeCommand: async () => {} }
  };
  const errors = [], events = [], panels = [];
  let interception;
  const codec = async (_command, _helper, _file, request, options) => {
    if (interception) await interception(options);
    const bytes = Buffer.from(request.bytes, 'base64');
    const doc = new WxmeDocument(uri(file), bytes, JSON.parse(bytes));
    if (request.tree) doc.setTree(request.tree);
    return { version: 1, parts: doc.parts, bytes: Buffer.from(JSON.stringify({ parts: doc.parts })).toString('base64') };
  };
  const filename = path.resolve(__dirname, '../vscode/wxme-editor.js'), local = createRequire(filename), module = { exports: {} };
  const viewerFile = path.resolve(__dirname, '../vscode/wxme-viewer.js'), viewer = { exports: {} };
  vm.runInNewContext(fs.readFileSync(viewerFile, 'utf8'), { module: viewer, Buffer, require: name => name === 'vscode' ? vscode : local(name) });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, AbortController,
    require: name => name === 'vscode' ? vscode : name === './wxme-process' ? { requestWxme: codec } : name === './wxme-viewer' ? viewer.exports : local(name) });
  const context = { subscriptions: [], asAbsolutePath: () => helper }, provider = module.exports.registerWxmeEditor(context);
  provider.onDidChangeCustomDocument(e => events.push(e));
  t.after(() => context.subscriptions.forEach(s => s.dispose()));
  function panel(doc) {
    const received = new EventEmitter(), closed = new EventEmitter(), visibility = new EventEmitter(), messages = [];
    const p = { webview: { onDidReceiveMessage: received.event, postMessage: m => { messages.push(m); return Promise.resolve(true); } }, onDidDispose: closed.event,
      visible: true, onDidChangeViewState: visibility.event,
      show: visible => { p.visible = visible; visibility.fire({ webviewPanel: p }); },
      edit: async (id, text, before = doc.fields.get(id).part.text) => { received.fire({ type: 'edit', generation: doc.generation, id, text, before }); await new Promise(r => setImmediate(r)); },
      message: async message => { received.fire({ generation: doc.generation, ...message }); await new Promise(r => setImmediate(r)); },
      close: () => closed.fire(), messages };
    provider.resolveCustomEditor(doc, p, token); panels.push(p); return p;
  }
  return { provider, file, uri: uri(file), root, events, errors, panel, vscode, render: module.exports.renderEditor, replaceFile: module.exports.replaceFile,
    intercept: callback => { interception = callback; }, dispose: () => context.subscriptions.forEach(s => s.dispose()) };
}

test('text fields retain stable object boundaries, Unicode, empty slots and backup state', () => {
  const doc = new WxmeDocument(uri('/a'), Buffer.from('original'), { parts });
  assert.deepEqual([...doc.fields.keys()], ['0', '1/0', '2']);
  doc.edit('1/0', 'comment 😀'); doc.edit('0', '');
  const copy = new WxmeDocument(doc.uri, doc.bytes, { parts }); copy.restore(JSON.parse(doc.backup()));
  assert.deepEqual(copy.parts, doc.parts); assert.equal(copy.diskHash, doc.diskHash);
  assert.throws(() => doc.edit('1', 'replace object'), /Invalid/);
  assert.throws(() => doc.edit('0', 'oops', 'stale'), /another view/);
  assert.throws(() => doc.edit('0', 'x'.repeat(32 * 1024 * 1024 + 1)), /32 MiB/);
});

test('provider sends undoable edits to VS Code and synchronizes split views', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), a = h.panel(doc), b = h.panel(doc);
  await a.edit('1/0', 'inside λ 😀');
  assert.equal(h.events.length, 1); assert.equal(a.messages.length, 0); assert.equal(b.messages.at(-1).text, 'inside λ 😀');
  h.events[0].undo(); assert.equal(doc.fields.get('1/0').part.text, ''); assert.equal(a.messages.at(-1).text, '');
  h.events[0].redo(); assert.equal(doc.fields.get('1/0').part.text, 'inside λ 😀');
  await b.edit('1/0', 'stale edit', ''); assert.equal(h.errors.length, 1); assert.equal(h.events.length, 1);
  assert.equal(doc.fields.get('1/0').part.text, 'inside λ 😀');
  a.close(); assert.equal(doc.panels.size, 1); doc.dispose(); assert.equal(doc.panels.size, 0);
});

test('XML mode changes use native undo events, synchronize views and reject stale actions', async t => {
  const h = harness(t);
  fs.writeFileSync(h.file, JSON.stringify({ parts: [{ kind: 'xml', eliminateWhitespace: false, parts: [] }] }));
  const doc = await h.provider.openCustomDocument(h.uri, {}, token), a = h.panel(doc), b = h.panel(doc);
  const generation = doc.generation;
  await a.message({ type: 'mode', id: '1', value: true });
  assert.equal(h.events.length, 1); assert.equal(doc.parts[1].eliminateWhitespace, true);
  for (const panel of [a, b]) assert.match(panel.webview.html, /XML box \(eliminate empty-tag whitespace\)/);
  h.events[0].undo(); assert.equal(doc.parts[1].eliminateWhitespace, false);
  h.events[0].redo(); assert.equal(doc.parts[1].eliminateWhitespace, true);
  await b.message({ type: 'mode', generation, id: '1', value: false });
  assert.equal(h.events.length, 1); assert.match(h.errors.at(-1), /structure changed/);
  await h.provider.saveCustomDocument(doc, token);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).parts[1].eliminateWhitespace, true);
});

test('revealed editors render current text without changing the document or undo history', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), a = h.panel(doc), b = h.panel(doc);
  await a.edit('0', 'saved text'); await h.provider.saveCustomDocument(doc, token);
  a.show(false); a.show(true); assert.match(a.webview.html, /saved text/);
  a.show(false); await b.edit('0', 'edited in another view');
  const tree = doc.tree, revision = doc.revision;
  a.show(true); assert.match(a.webview.html, /edited in another view/);
  assert.strictEqual(doc.tree, tree); assert.equal(doc.revision, revision); assert.equal(h.events.length, 2);
  a.show(false); h.events[1].undo(); a.show(true); assert.match(a.webview.html, /saved text/);
  const html = a.webview.html; a.close(); a.show(false); a.show(true); assert.equal(a.webview.html, html);
});

test('save, undo after save, Save As, revert and backup restore retain content', async t => {
  const h = harness(t), original = fs.readFileSync(h.file), doc = await h.provider.openCustomDocument(h.uri, {}, token), panel = h.panel(doc);
  await h.provider.saveCustomDocument(doc, token); assert.deepEqual(fs.readFileSync(h.file), original);
  await panel.edit('0', 'changed 😀\n'); await h.provider.saveCustomDocument(doc, token);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).parts[0].text, 'changed 😀\n');
  h.events[0].undo(); await h.provider.saveCustomDocument(doc, token); assert.deepEqual(fs.readFileSync(h.file), original);
  h.events[0].redo();
  const backupUri = uri(path.join(h.root, 'backup.json'));
  const backup = await h.provider.backupCustomDocument(doc, { destination: backupUri }, token);
  const restored = await h.provider.openCustomDocument(h.uri, { backupId: backup.id }, token);
  assert.deepEqual(restored.parts, doc.parts);
  const destination = uri(path.join(h.root, 'copy.wxme'));
  await h.provider.saveCustomDocumentAs(restored, destination, token);
  assert.equal(JSON.parse(fs.readFileSync(destination.fsPath)).parts[0].text, 'changed 😀\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(destination.fsPath).mode & 0o777, 0o666 & ~process.umask());
  assert.deepEqual(fs.readFileSync(h.file), original);
  await h.provider.revertCustomDocument(doc, token); assert.equal(doc.fields.get('0').part.text, parts[0].text);
  backup.delete(); doc.dispose(); restored.dispose();
});

test('structural transactions synchronize views, survive saving and reject stale panel actions', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), a = h.panel(doc), b = h.panel(doc);
  const before = doc.tree, generation = doc.generation;
  await a.message({ type: 'insert', id: '0', start: 2, end: 4, before: 'λ 😀\n', kind: 'comment' });
  assert.equal(h.events.length, 1); assert.equal(doc.parts[1].parts[0].text, '😀');
  assert.notEqual(doc.generation, generation); assert.match(b.webview.html, /data-remove="n0"/);
  await b.message({ type: 'remove', generation, id: 'n0' });
  assert.equal(h.errors.length, 1); assert.equal(h.events.length, 1);
  h.events[0].undo(); assert.strictEqual(doc.tree, before);
  h.events[0].redo(); await h.provider.saveCustomDocument(doc, token);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).parts[1].parts[0].text, '😀');
  await a.message({ type: 'remove', id: 'n0' }); assert.equal(h.events.length, 2);
  assert.equal(doc.parts[0].text, 'λ \n');
  h.events[1].undo(); assert.equal(doc.parts[1].parts[0].text, '😀');
});

test('cancelling image selection leaves structure and undo history unchanged', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), panel = h.panel(doc), before = doc.tree;
  h.vscode.window.showOpenDialog = async () => undefined;
  await panel.message({ type: 'insert', id: '0', start: 0, end: 0, before: 'λ 😀\n', kind: 'image' });
  assert.strictEqual(doc.tree, before); assert.equal(h.events.length, 0); assert.equal(h.errors.length, 0);
});

test('external replacement, deletion and an edit during encoding refuse save without losing either version', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), panel = h.panel(doc);
  await panel.edit('0', 'mine'); fs.writeFileSync(h.file, 'external');
  await assert.rejects(h.provider.saveCustomDocument(doc, token), /outside/); assert.equal(fs.readFileSync(h.file, 'utf8'), 'external');
  fs.unlinkSync(h.file); await assert.rejects(h.provider.saveCustomDocument(doc, token), /outside/); assert.equal(fs.existsSync(h.file), false);
  fs.writeFileSync(h.file, doc.bytes);
  h.intercept(async () => { doc.edit('0', 'newer'); });
  await assert.rejects(h.provider.saveCustomDocument(doc, token), /during saving|preserve/);
  assert.deepEqual(fs.readFileSync(h.file), doc.bytes); assert.equal(doc.fields.get('0').part.text, 'newer');
  assert.deepEqual(fs.readdirSync(h.root), ['source.wxme']);
});

test('failed or cancelled encoding preserves disk, dirty content and subsequent save recovery', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), panel = h.panel(doc);
  await panel.edit('0', 'mine');
  h.intercept(async () => { throw new Error('codec unavailable'); });
  await assert.rejects(h.provider.saveCustomDocument(doc, token), /unavailable/);
  assert.deepEqual(fs.readFileSync(h.file), doc.bytes); assert.equal(doc.fields.get('0').part.text, 'mine');
  h.intercept(undefined); await h.provider.saveCustomDocument(doc, token);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).parts[0].text, 'mine');
  h.intercept(options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))));
  const pending = h.provider.saveCustomDocument(doc, token);
  await new Promise(r => setImmediate(r)); doc.dispose();
  await assert.rejects(pending); assert.equal(doc.jobs.size, 0);
});

test('trust, dirty buffers and cancellation block opening and saving', async t => {
  const h = harness(t); h.vscode.workspace.isTrusted = false;
  await assert.rejects(h.provider.openCustomDocument(h.uri, {}, token), /Trust/);
  h.vscode.workspace.isTrusted = true;
  await assert.rejects(h.provider.openCustomDocument({ ...h.uri, scheme: 'untitled' }, {}, token), /saved local/);
  await assert.rejects(h.provider.openCustomDocument(h.uri, {}, { ...token, isCancellationRequested: true }));
  const doc = await h.provider.openCustomDocument(h.uri, {}, token);
  h.vscode.workspace.textDocuments = [{ uri: h.uri, isDirty: true }];
  await assert.rejects(h.provider.saveCustomDocument(doc, token), /unsaved changes/);
  assert.deepEqual(fs.readFileSync(h.file), doc.bytes);
});

test('staged saves preserve permissions and symlinks and remove temporary files on cancellation', { skip: process.platform === 'win32' }, async t => {
  const h = harness(t), link = path.join(h.root, 'link.wxme'); fs.chmodSync(h.file, 0o640); fs.symlinkSync(h.file, link);
  const original = fs.readFileSync(h.file);
  await assert.rejects(h.replaceFile(link, Buffer.from('cancelled'), hash(original), () => { throw new Error('cancelled'); }), /cancelled/);
  assert.deepEqual(fs.readFileSync(h.file), original); assert.ok(fs.lstatSync(link).isSymbolicLink());
  await h.replaceFile(link, Buffer.from('saved'), hash(original), () => {});
  assert.equal(fs.readFileSync(h.file, 'utf8'), 'saved'); assert.equal(fs.statSync(h.file).mode & 0o777, 0o640);
  assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.deepEqual(fs.readdirSync(h.root).sort(), ['link.wxme', 'source.wxme']);
});

test('editor escapes source, restricts scripts and creates fields for empty comments', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token);
  doc.edit('0', '\n</textarea><script>danger</script>');
  const html = h.render(doc);
  assert.match(html, /data-field="1\/0"/); assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;danger/);
  assert.equal((html.match(/<script /g) || []).length, 1); assert.match(html, /script-src 'nonce-/);
  assert.doesNotMatch(html, /unsafe-inline/);
});

test('webview leaves save and undo commands to VS Code instead of sending duplicates', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), html = h.render(doc);
  const listeners = {}, messages = [], field = { value: 'text', dataset: { field: '0' }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
    document: { body: { dataset: { generation: 'test' } }, querySelectorAll: selector => selector === 'textarea' ? [field] : [], querySelector: () => undefined }, window: { addEventListener() {} } });
  for (const key of ['s', 'z', 'y']) {
    let prevented = false;
    listeners.keydown({ key, ctrlKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(messages.length, 0);
  }
  field.value = 'edited'; listeners.input(); assert.equal(messages.length, 1); assert.equal(messages[0].type, 'edit');
});

test('a replacement save waits for a cancelled save and then succeeds', async t => {
  const h = harness(t), doc = await h.provider.openCustomDocument(h.uri, {}, token), panel = h.panel(doc);
  await panel.edit('0', 'saved after cancellation');
  let cancel, started;
  const ready = new Promise(resolve => { started = resolve; });
  const cancellation = { isCancellationRequested: false, onCancellationRequested: callback => { cancel = callback; return { dispose() {} }; } };
  h.intercept(options => new Promise((resolve, reject) => { started(); options.signal.addEventListener('abort', () => reject(options.signal.reason)); }));
  const first = h.provider.saveCustomDocument(doc, cancellation), rejected = assert.rejects(first);
  await ready;
  const second = h.provider.saveCustomDocument(doc, token);
  h.intercept(undefined); cancellation.isCancellationRequested = true; cancel();
  await rejected; await second;
  assert.equal(JSON.parse(fs.readFileSync(h.file)).parts[0].text, 'saved after cancellation');
});

const gui = { skip: !process.env.RACKETDAP_TEST_WXME_GUI };
test('public encoder preserves images, nested comments and Unicode across text edits and reopen', gui, async () => {
  for (const [name, edits] of [['images', [{ path: [0], text: '#lang racket/base\n; edited λ 😀\n(define first ' }]],
    ['boxes', [{ path: [1, 1, 0], text: 'changed comment λ 😀\n' }]], ['empty-comment', [{ path: [1, 0], text: 'no longer empty' }]],
    ['empty', [{ path: [0], text: '#lang racket/base\n42\n' }]]]) {
    const bytes = fixture(name);
    const original = await decodeWxme('racket', path.resolve(__dirname, '../racketdap/tools/wxme-view.rkt'), path.join(__dirname, 'fixtures/wxme', name + '.wxme'));
    const expected = new WxmeDocument(uri('/a'), bytes, original);
    for (const edit of edits) expected.edit(edit.path.join('/'), edit.text);
    const result = await requestWxme('racket', helper, __filename, expected.request());
    assert.deepEqual(normalize(result.parts), expected.parts);
    const reopen = await requestWxme('racket', helper, __filename, { version: 1, bytes: result.bytes });
    assert.deepEqual(reopen.parts, result.parts); assert.deepEqual(fixture(name), bytes);
  }
});

test('GUI encoder refuses custom readers, invalid positions and oversized edits', gui, async () => {
  for (const name of ['custom', 'nested-custom']) await assert.rejects(requestWxme('racket', helper, __filename,
    { version: 1, bytes: fixture(name).toString('base64') }), /Unsupported/);
  await assert.rejects(requestWxme('racket', helper, __filename, { version: 1, bytes: fixture('images').toString('base64'), tree: [{ id: '0', kind: 'text', pieces: [{ source: 'missing', start: 0, end: 1 }] }] }), /Unknown original content/);
  await assert.rejects(requestWxme('racket', helper, __filename, { version: 1, bytes: fixture('text').toString('base64'), tree: [{ id: '0', kind: 'text', pieces: [{ text: 'x'.repeat(32 * 1024 * 1024 + 1) }] }] }), /32 MiB/);
});

test('a headless comment mapping does not authorize a different GUI reader', gui, async t => {
  const root = directory(t), collection = path.join(root, 'racketeer-fixture'); fs.mkdirSync(collection);
  const marker = path.join(root, 'reader-loaded');
  fs.writeFileSync(path.join(collection, 'reader.rkt'), `#lang racket/base\n(call-with-output-file ${JSON.stringify(marker)} (lambda (out) (display "loaded" out)))\n(error "CUSTOM READER LOADED")\n`);
  const previous = process.env.PLTCOLLECTS; process.env.PLTCOLLECTS = root + path.delimiter + (previous || '');
  try {
    await assert.rejects(requestWxme('racket', helper, __filename, { version: 1, bytes: fixture('different-readers').toString('base64') }), /Unsupported object class/);
    assert.equal(fs.existsSync(marker), false);
  } finally { if (previous === undefined) delete process.env.PLTCOLLECTS; else process.env.PLTCOLLECTS = previous; }
});

test('saving original executable source preserves its objects and intended evaluation result', gui, async t => {
  const root = directory(t), original = path.join(root, 'before.rkt'), saved = path.join(root, 'after.rkt');
  fs.writeFileSync(original, fixture('editable-program'));
  const read = await decodeWxme('racket', path.resolve(__dirname, '../racketdap/tools/wxme-view.rkt'), original);
  const text = read.parts[0].text.replace('20 22', '20 23');
  const document = new WxmeDocument(uri(original), fixture('editable-program'), read); document.edit('0', text);
  const changed = await requestWxme('racket', helper, __filename, document.request());
  fs.writeFileSync(saved, Buffer.from(changed.bytes, 'base64'));
  assert.deepEqual(changed.parts.slice(1), read.parts.slice(1));
  for (const [file, value] of [[original, '42'], [saved, '43']]) {
    const run = spawnSync('racket', ['-e', `(display (dynamic-require '(file ${JSON.stringify(file)}) 'value))`], { encoding: 'utf8', timeout: 240000 });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, value);
  }
});

test('editing without a display returns a useful error and leaves the source intact', { skip: process.platform !== 'linux' }, async () => {
  const display = process.env.DISPLAY; process.env.DISPLAY = ':9876';
  try { await assert.rejects(requestWxme('racket', helper, __filename, { version: 1, bytes: fixture('text').toString('base64') }), /working display/); }
  finally { if (display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = display; }
});
