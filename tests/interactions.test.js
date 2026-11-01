// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { DapClient } = require('./dap-client');
const { InteractionOutput } = require('../vscode/interaction-output');
const { deferCleanup } = require('./cleanup');
async function ok(request) { const response = await request; assert.equal(response.success, true, response.message); return response.body; }
async function start(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket interactions λ '));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'main.rkt'); await fs.writeFile(program, source);
  const client = new DapClient(undefined, { timeout: 60000 }); deferCleanup(t, () => client.close());
  await ok(client.request('initialize'));
  await ok(client.request('launch', { program, cwd: directory, interactive: true, racketdapRichInteractions: true }));
  await ok(client.request('configurationDone')); await client.event('racketdap/ready');
  const output = new InteractionOutput(() => {});
  function drain() {
    for (const event of client.events.filter(event => event.event === 'racketdap/interactionOutput')) output.output(event.body);
    client.events = client.events.filter(event => event.event !== 'racketdap/interactionOutput');
    return output.entries;
  }
  async function evaluate(expression) {
    const result = await client.request('evaluate', { context: 'repl', expression });
    await client.event('racketdap/ready'); drain(); return result;
  }
  return { client, output, drain, evaluate };
}
const images = entries => entries.filter(entry => entry.kind === 'image');
const text = entries => entries.filter(entry => entry.kind !== 'image').map(entry => entry.text).join('');

test('module output and successive mixed results show ordered inline images without reevaluation', async t => {
  const h = await start(t, '#lang racket/base\n(require pict)\n(define picture (colorize (disk 24) "blue"))\n(define count 0)\n(display "before λ")\npicture\n(display "after")\n');
  const loaded = h.drain();
  assert.equal(images(loaded).length, 1); assert.match(loaded[0].text, /before λ/); assert.equal(loaded[1].kind, 'image');
  const original = images(loaded)[0].data;
  assert.equal(Buffer.from(original, 'base64').readUInt32BE(16), 24);
  assert.equal((await h.evaluate('(begin (set! count (add1 count)) (values 1/3 picture "<script>λ</script>" picture))')).success, true);
  assert.equal(images(h.output.entries).length, 3);
  assert.match(text(h.output.entries), /1\/3/); assert.match(text(h.output.entries), /<script>λ<\/script>/);
  assert.equal((await h.evaluate('count')).body.result, '1');
  assert.equal(images(h.output.entries)[0].data, original, 'Earlier snapshots survive another evaluation');
  assert.equal((await h.evaluate('(begin (print picture) (void))')).success, true);
  assert.equal(images(h.output.entries).length, 4, 'Explicit print also draws its image');
  assert.equal((await h.evaluate('(values)')).success, true);
  assert.equal((await h.evaluate('(error "recoverable λ")')).success, false);
  assert.equal((await h.evaluate('(+ 20 22)')).body.result, '42');
});

test('automatic converters run once, report failures, and remain cancellable', async t => {
  const h = await start(t, `#lang racket/base
(require file/convertible)
(define conversions 0)
(struct picture (block?) #:property prop:convertible
 (lambda (v format default)
  (set! conversions (add1 conversions))
  (if (picture-block? v) (begin (displayln "converting") (flush-output) (sync never-evt)) (error "bad converter"))))
(define bad (picture #f))
(define slow (picture #t))
`);
  assert.equal((await h.evaluate('bad')).success, true);
  assert.match(text(h.output.entries), /preview unavailable.*bad converter/);
  assert.equal((await h.evaluate('conversions')).body.result, '1');
  const pending = h.client.request('evaluate', { context: 'repl', expression: 'slow' });
  await h.client.event('output', event => event.body.output.includes('converting'));
  await ok(h.client.request('racketdap/cancelEvaluation'));
  assert.equal((await pending).success, false); await h.client.event('racketdap/ready');
  assert.equal((await h.evaluate('(+ 1 2)')).body.result, '3');
  assert.equal((await h.evaluate('conversions')).body.result, '2');
});

test('rich streams retain Unicode across separate writes and preserve standard text output', async t => {
  const h = await start(t, '#lang racket/base\n');
  assert.equal((await h.evaluate('(begin (write-byte 206) (write-byte 187) (write-byte 240) (write-byte 159) (write-byte 152) (write-byte 128) (display "error λ" (current-error-port)) (void))')).success, true);
  assert.equal(h.output.entries[0].text, 'λ😀');
  assert.equal(h.output.entries[1].kind, 'stderr'); assert.equal(h.output.entries[1].text, 'error λ');
});

test('transcript memory and entry limits evict old output without reusing image identities', () => {
  const messages = [], output = new InteractionOutput(message => messages.push(message), 20);
  output.append('input', '0123456789'); const first = output.entries[0].id;
  output.append('stdout', '0123456789'); output.append('input', 'new');
  assert.equal(output.entries.some(entry => entry.id === first), false); assert.ok(output.bytes <= 20);
  assert.ok(messages.some(message => message.type === 'remove'));
  const id = output.entries.at(-1).id; output.clear(); output.append('stdout', 'λ'); assert.ok(output.entries[0].id > id);
  assert.throws(() => output.output({ category: 'image', mimeType: 'image/png', data: 'bad' }), /Invalid PNG/);
});

// VS Code activates a webview's editor group when it opens the panel beside
// the source, even with preserveFocus. Commands then found no active Racket
// editor, so starting the same module's Debug REPL a second time failed.
test('revealing Interactions keeps the source editor group active', async t => {
  const vm = require('node:vm');
  const groups = { active: 1 }, revealed = [];
  const source = { document: { uri: 'file:///main.rkt', languageId: 'racket' }, viewColumn: 1 };
  const panel = { visible: true, webview: { postMessage: async () => {}, onDidReceiveMessage() {} }, onDidDispose() {},
    reveal(column, preserveFocus) { revealed.push(preserveFocus); groups.active = 2; panel.visible = true; }, dispose() {} };
  let factory;
  const vscode = {
    ViewColumn: { Beside: -2 }, Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    debug: {
      registerDebugAdapterTrackerFactory(_type, value) { factory = value; return { dispose() {} }; },
      onDidTerminateDebugSession: () => ({ dispose() {} })
    },
    window: {
      createWebviewPanel() { groups.active = 2; return panel; },
      get activeTextEditor() { return groups.active === source.viewColumn ? source : undefined; },
      async showTextDocument(document, options) {
        assert.equal(document, source.document);
        // As observed in VS Code 1.98 and 1.144, only a focused editor activates its group.
        if (!options.preserveFocus) groups.active = options.viewColumn;
        return source;
      }
    }
  };
  const module = { exports: {} };
  const local = { './error-sources': { registerErrorSources: () => ({}) } };
  const filename = path.join(__dirname, '../vscode/interactions.js');
  vm.runInNewContext(require('node:fs').readFileSync(filename, 'utf8'), { module, require: name =>
    name === 'vscode' ? vscode : local[name] || require(name.startsWith('.') ? path.join(__dirname, '../vscode', name) : name) }, { filename });
  const context = { subscriptions: [] };
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  const interactions = module.exports.registerInteractions(context, {});
  const session = { id: 'repl', configuration: { program: '/main.rkt', interactive: true, racketdapRichInteractions: true } };
  factory.createDebugAdapterTracker(session);
  const owner = { session, stop: async () => {} };
  assert.equal(vscode.window.activeTextEditor, undefined, 'Opening the panel beside activates its group');
  await interactions.reveal(owner);
  assert.deepEqual(revealed, [], 'A visible panel needs no reveal');
  assert.equal(vscode.window.activeTextEditor, source, 'Opening the panel returns activity to the source');
  panel.visible = false;
  await interactions.reveal(owner);
  assert.deepEqual(revealed, [true]);
  assert.equal(vscode.window.activeTextEditor, source, 'Revealing a hidden panel returns activity to the source');
});
