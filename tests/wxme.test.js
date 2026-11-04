// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const treeRemoval = require('./support/tree-removal');
const { until } = require('./support/wait');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { decodeWxme } = require('../vscode/wxme-process');
const helper = path.resolve(__dirname, '../racketdap/tools/wxme-view.rkt');
const fixture = name => path.join(__dirname, 'fixtures/wxme', `${name}.wxme`);
const decode = file => decodeWxme(process.env.RACKET || 'racket', helper, file);
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-wxme-'));
  t.after(() => fs.rmSync(directory, treeRemoval));
  return directory;
};
function emitter() {
  const listeners = new Set();
  return { event(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    fire(value) { for (const fn of listeners) fn(value); }, get size() { return listeners.size; } };
}
function harness(t, decoder = decodeWxme) {
  let provider;
  const changes = emitter(), edits = emitter(), watchers = [];
  const vscode = {
    CancellationError: class extends Error {},
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: { isTrusted: true, textDocuments: [],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeTextDocument: edits.event,
      createFileSystemWatcher() {
        const watcher = { onDidChange: changes.event, onDidCreate: changes.event, onDidDelete: changes.event,
          dispose() { this.disposed = true; } };
        watchers.push(watcher); return watcher;
      }
    },
    window: { registerCustomEditorProvider(type, value, options) {
      assert.equal(type, 'racketeer.wxme'); assert.equal(options.supportsMultipleEditorsPerDocument, true);
      provider = value; return { dispose() {} };
    } }
  };
  const filename = path.resolve(__dirname, '../vscode/wxme-viewer.js'), local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, AbortController,
    require: name => name === 'vscode' ? vscode : name === './wxme-process' ? { decodeWxme: decoder } : local(name) }, { filename });
  const context = { subscriptions: [], asAbsolutePath: () => helper };
  module.exports.registerWxmeViewer(context);
  const dispose = () => context.subscriptions.forEach(s => s.dispose());
  t.after(dispose);
  const uri = { scheme: 'file', fsPath: fixture('images'), toString() { return this.fsPath; } };
  const cancellation = emitter();
  const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
  return { provider, vscode, uri, token, cancellation, changes, edits, watchers, dispose, render: module.exports.renderWxme };
}

test('public codec preserves Unicode, tabs, text/image order, crop dimensions and source bytes without a display', async () => {
  const before = fs.readFileSync(fixture('images'));
  const oldDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':9876';
  let result;
  try { result = await decode(fixture('images')); }
  finally { if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; }
  assert.deepEqual(result.parts.map(p => p.kind), ['text', 'image', 'text', 'image', 'text']);
  assert.equal(result.parts[0].text, '#lang racket/base\n; λ 😀 <script>&\n(define first ');
  assert.equal(result.parts[4].text, ')\n\t(list first cropped)\n');
  assert.deepEqual(result.parts.filter(p => p.kind === 'image').map(p => [p.width, p.height]), [[48, 32], [16, 12]]);
  // Decode output pixels through the public draw API, independently of the viewer.
  const pixels = spawnSync(process.env.RACKET || 'racket', ['-e',
    '(require json net/base64 racket/class racket/draw) (define bm (read-bitmap (open-input-bytes (base64-decode (string->bytes/utf-8 (read-json)))))) (define b (make-bytes 4)) (send bm get-argb-pixels 0 0 1 1 b) (write-json (bytes->list b))'],
  { input: JSON.stringify(result.parts[3].data), encoding: 'utf8' });
  assert.equal(pixels.status, 0, pixels.stderr);
  assert.deepEqual(JSON.parse(pixels.stdout), [255, 255, 215, 0]);
  assert.deepEqual(fs.readFileSync(fixture('images')), before);
});

test('empty, text-only and nested WXME documents preserve their text and boundaries', async () => {
  assert.deepEqual((await decode(fixture('empty'))).parts, []);
  assert.deepEqual((await decode(fixture('text'))).parts, [{ kind: 'text', text: '#lang racket/base\n(define λ "😀")\n' }]);
  assert.deepEqual((await decode(fixture('nested'))).parts, [
    { kind: 'text', text: 'before ' }, { kind: 'editor', parts: [{ kind: 'text', text: 'hidden text' }] },
    { kind: 'text', text: ' after\n' }
  ]);
});

test('nested comment boxes preserve text, Unicode, images and source bytes without evaluation', async t => {
  const before = fs.readFileSync(fixture('boxes')), result = await decode(fixture('boxes'));
  assert.equal(result.parts[0].text, 'before ');
  const editor = result.parts[1]; assert.equal(editor.kind, 'editor');
  assert.equal(editor.parts[0].text, 'inside ');
  const comment = editor.parts[1]; assert.equal(comment.kind, 'comment');
  assert.equal(comment.parts[0].text, 'comment λ 😀 <script>&\n(error "not executable")\n');
  assert.deepEqual(comment.parts[1], (await decode(fixture('images'))).parts[1]);
  assert.equal(editor.parts[2].text, ' after\n'); assert.equal(result.parts[2].text, ' after\n');
  const html = harness(t).render(result, '<document>');
  assert.match(html, /aria-label="Nested editor"/); assert.match(html, /aria-label="Comment box"/);
  assert.match(html, /comment λ 😀 &lt;script&gt;&amp;/); assert.doesNotMatch(html, /<script/);
  assert.ok(html.indexOf('Nested editor') < html.indexOf('Comment box'));
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.deepEqual(fs.readFileSync(fixture('boxes')), before);
});

test('an empty comment remains an explicit box between its surrounding text', async t => {
  const result = await decode(fixture('empty-comment'));
  assert.deepEqual(result.parts, [{ kind: 'text', text: 'left ' }, { kind: 'comment', parts: [] },
    { kind: 'text', text: ' right\n' }]);
  assert.match(harness(t).render(result, 'empty'), /aria-label="Comment box"/);
});

test('decoder and renderer accept 32 editor levels and refuse a deeper document without modifying it', async t => {
  const h = harness(t), result = await decode(fixture('depth-limit'));
  assert.equal((h.render(result, 'limit').match(/aria-label="Nested editor"/g) || []).length, 32);
  assert.throws(() => h.render({ parts: [{ kind: 'editor', parts: result.parts }] }, 'too deep'), /32 levels/);
  const before = fs.readFileSync(fixture('deep'));
  await assert.rejects(decode(fixture('deep')), /32 levels/);
  assert.deepEqual(fs.readFileSync(fixture('deep')), before);
});

test('custom readers are refused before module loading and bytes are preserved', async t => {
  const directory = temporary(t), collection = path.join(directory, 'racketeer-fixture');
  fs.mkdirSync(collection);
  const marker = path.join(directory, 'reader-loaded');
  fs.writeFileSync(path.join(collection, 'reader.rkt'), `#lang racket/base\n(call-with-output-file ${JSON.stringify(marker)} (lambda (out) (display "loaded" out)))\n(error "CUSTOM READER WAS LOADED")\n`);
  const before = fs.readFileSync(fixture('custom')), old = process.env.PLTCOLLECTS;
  process.env.PLTCOLLECTS = directory + path.delimiter + (old || '');
  try {
    for (const name of ['custom', 'nested-custom']) await assert.rejects(decode(fixture(name)), error => {
      assert.match(error.message, /Unsupported WXME object classes/);
      assert.doesNotMatch(error.message, /CUSTOM READER WAS LOADED/); return true;
    });
  } finally { if (old === undefined) delete process.env.PLTCOLLECTS; else process.env.PLTCOLLECTS = old; }
  assert.equal(fs.existsSync(marker), false, 'No custom reader side effects occurred');
  assert.deepEqual(fs.readFileSync(fixture('custom')), before);
});

test('plain source, malformed streams, missing files and oversized input fail without writes', async t => {
  const directory = temporary(t), file = path.join(directory, 'source.rkt');
  for (const [bytes, error] of [[Buffer.from('#lang racket/base\n42\n'), /not a WXME document/],
    [fs.readFileSync(fixture('images')).subarray(0, 300), /Cannot view WXME/],
    [Buffer.alloc(32 * 1024 * 1024 + 1), /32 MiB/]]) {
    fs.writeFileSync(file, bytes); await assert.rejects(decode(file), error); assert.deepEqual(fs.readFileSync(file), bytes);
  }
  await assert.rejects(decode(path.join(directory, 'missing.wxme')), /cannot open input file/);
});

test('missing executable and cancellation before launch settle without a worker', async () => {
  await assert.rejects(decodeWxme('/no-such-racketeer-racket', helper, fixture('images')), /racketExecutable/);
  const controller = new AbortController(); controller.abort(new Error('cancelled before launch'));
  await assert.rejects(decodeWxme('/must-not-start', helper, fixture('images'), { signal: controller.signal }), /cancelled before launch/);
});

test('timeout and cancellation reap only their own unresponsive worker', async t => {
  const directory = temporary(t), stalled = path.join(directory, 'stalled.js');
  fs.writeFileSync(stalled, `process.stdin.once('data', chunk => { require('fs').writeFileSync(JSON.parse(chunk).path, String(process.pid)); }); setInterval(() => {}, 1000);`);
  const first = path.join(directory, 'first'), second = path.join(directory, 'second');
  const controller = new AbortController();
  const a = decodeWxme(process.execPath, stalled, first, { signal: controller.signal });
  const b = decodeWxme(process.execPath, stalled, second, { timeout: 3000 });
  const checkedA = assert.rejects(a, /cancelled/), checkedB = assert.rejects(b, /timed out/);
  // A worker creates its file before it writes the number.
  const pidIn = file => fs.existsSync(file) ? Number(fs.readFileSync(file)) : 0;
  await until(() => pidIn(first) && pidIn(second));
  const pidA = pidIn(first), pidB = pidIn(second);
  controller.abort(new Error('cancelled'));
  await checkedA;
  assert.throws(() => process.kill(pidA, 0), { code: 'ESRCH' });
  assert.doesNotThrow(() => process.kill(pidB, 0));
  await checkedB;
  assert.throws(() => process.kill(pidB, 0), { code: 'ESRCH' });
});

test('decoder exits when its extension input lease closes', async () => {
  const child = spawn(process.env.RACKET || 'racket', [helper], { stdio: 'pipe' });
  const closed = once(child, 'close');
  child.stdin.on('error', () => {}); child.stderr.resume(); child.stdout.resume();
  child.stdin.end(JSON.stringify({ path: fixture('images') }) + '\n');
  const [code] = await closed;
  assert.equal(code, 0);
});

test('readonly provider offers optional Open With and escapes text with scripts disabled', async t => {
  const h = harness(t), document = await h.provider.openCustomDocument(h.uri, {}, h.token);
  const closed = emitter(), panel = { webview: {}, onDidDispose: closed.event };
  h.provider.resolveCustomEditor(document, panel, h.token);
  assert.equal(h.provider.saveCustomDocument, undefined);
  assert.equal(panel.webview.options.enableScripts, false);
  assert.equal(panel.webview.options.localResourceRoots.length, 0);
  assert.match(panel.webview.html, /λ 😀 &lt;script&gt;&amp;/);
  assert.equal((panel.webview.html.match(/<img /g) || []).length, 2);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /<script/);
  const contribution = require('../vscode/package.json').contributes.customEditors.find(e => e.viewType === 'racketeer.wxme');
  assert.equal(contribution.priority, 'option');
  closed.fire(); document.dispose();
  assert.equal(h.changes.size, 0); assert.equal(h.edits.size, 0);
});

test('views notice disk and buffer changes, share a document, and reopen from current bytes', async t => {
  const directory = temporary(t), file = path.join(directory, 'source.wxme');
  fs.copyFileSync(fixture('images'), file);
  const h = harness(t); h.uri.fsPath = file;
  const document = await h.provider.openCustomDocument(h.uri, {}, h.token);
  const panels = [1, 2].map(() => ({ webview: {}, onDidDispose: emitter().event }));
  for (const panel of panels) h.provider.resolveCustomEditor(document, panel, h.token);
  h.changes.fire({ toString: () => 'another file' });
  assert.equal(document.stale, false);
  h.changes.fire(h.uri);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(document.stale, false, 'Delayed create/save events with identical bytes are ignored');
  fs.copyFileSync(fixture('text'), file); h.changes.fire(h.uri);
  await until(() => document.stale);
  for (const panel of panels) assert.match(panel.webview.html, /file has changed/);
  document.dispose();
  const reopened = await h.provider.openCustomDocument(h.uri, {}, h.token);
  assert.equal(reopened.result.parts.length, 1); assert.equal(reopened.stale, false);
  h.edits.fire({ document: { uri: h.uri }, contentChanges: [] }); assert.equal(reopened.stale, false);
  h.edits.fire({ document: { uri: h.uri }, contentChanges: [{ text: 'edit' }] }); assert.equal(reopened.stale, true);
  reopened.dispose(); assert.ok(h.watchers.every(w => w.disposed));
});

test('trust, dirty buffers, non-file documents and pre-cancelled opens prevent decoding', async t => {
  const h = harness(t, () => assert.fail('decoder must not start'));
  h.vscode.workspace.isTrusted = false;
  await assert.rejects(h.provider.openCustomDocument(h.uri, {}, h.token), /Trust/);
  h.vscode.workspace.isTrusted = true; h.uri.scheme = 'untitled';
  await assert.rejects(h.provider.openCustomDocument(h.uri, {}, h.token), /saved local file/);
  h.uri.scheme = 'file'; h.vscode.workspace.textDocuments = [{ uri: h.uri, isDirty: true }];
  await assert.rejects(h.provider.openCustomDocument(h.uri, {}, h.token), /unsaved/);
  h.vscode.workspace.textDocuments = []; h.token.isCancellationRequested = true;
  await assert.rejects(h.provider.openCustomDocument(h.uri, {}, h.token), h.vscode.CancellationError);
});

test('provider cancellation and extension disposal abort pending decoding and remove watchers', async t => {
  for (const close of [h => h.cancellation.fire(), h => h.dispose()]) {
    const h = harness(t, (_command, _helper, _file, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const opening = h.provider.openCustomDocument(h.uri, {}, h.token);
    close(h); await assert.rejects(opening, h.vscode.CancellationError);
    assert.ok(h.watchers.every(w => w.disposed)); assert.equal(h.changes.size, 0); assert.equal(h.edits.size, 0);
  }
});

test('changes during decoding mark the snapshot stale and late dirty buffers reject it', async t => {
  let finish;
  const h = harness(t, () => new Promise(resolve => { finish = resolve; }));
  const opening = h.provider.openCustomDocument(h.uri, {}, h.token);
  h.changes.fire(h.uri); finish({ parts: [], sourceHash: createHash('sha256').update('old bytes').digest('hex') });
  const document = await opening; assert.equal(document.stale, true); document.dispose();
  const dirty = h.provider.openCustomDocument(h.uri, {}, h.token);
  h.vscode.workspace.textDocuments = [{ uri: h.uri, isDirty: true }]; finish({ parts: [] });
  await assert.rejects(dirty, /changed while opening/);
  assert.ok(h.watchers.every(w => w.disposed));
});
