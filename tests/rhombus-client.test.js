// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./support/node-test');

// These contract tests supplement tests/vscode-rhombus.js, which requires the
// real server and private Rhombus runtime in the installed-editor harness.
function event() {
  const listeners = new Set();
  return { subscribe: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    emit: value => { for (const callback of listeners) callback(value); } };
}
function fixture(initialDocuments = [], source = 'bundled') {
  const opened = event(), active = event(), changed = event();
  const clients = [], indexes = [], processes = [], commands = new Map();
  let enabled = true;
  const disposable = () => ({ dispose() {} });
  const status = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      activeTextEditor: initialDocuments.length ? { document: initialDocuments[0] } : undefined,
      createStatusBarItem: () => status,
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, show() {} }),
      onDidChangeActiveTextEditor: active.subscribe,
      showErrorMessage: async error => { throw new Error(error); }
    },
    workspace: {
      isTrusted: true, textDocuments: initialDocuments,
      getConfiguration: () => ({ get(key, fallback) {
        return ({ 'languageServer.enabled': enabled, 'languageServer.source': source })[key] ?? fallback;
      } }),
      onDidOpenTextDocument: opened.subscribe,
      onDidChangeConfiguration: changed.subscribe
    },
    extensions: { getExtension() {} },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } }
  };
  class Client {
    constructor(_id, _name, factory, options) { this.factory = factory; this.options = options; this.state = event(); clients.push(this); }
    createDefaultErrorHandler() { return { error() {}, closed() {} }; }
    onDidChangeState(callback) { return this.state.subscribe(callback); }
    onNotification(_method, callback) { this.indexNotification = callback; return disposable(); }
    isRunning() { return this.running; }
    async start() { await this.factory(); this.running = true; this.state.emit({ newState: 'running' }); }
    async stop() { this.running = false; }
    dispose() { return this.stop(); }
  }
  const context = { subscriptions: [], asAbsolutePath: file => `/extension/${file}` };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../vscode/language-client.js');
  const dependencies = {
    vscode, 'vscode-languageclient/node': { LanguageClient: Client, State: { Running: 'running' }, CloseAction: {} },
    './workspace-index': { createWorkspaceIndex() {
      const index = { disposed: false, starts: 0, async start() { this.starts++; }, refresh() {},
        cancelStart() {}, async dispose() { this.disposed = true; }, provideReferences(...args) { return args.pop()(...args); } };
      indexes.push(index); return index;
    } },
    './language-process': { ownedArgs: require('../vscode/language-process').ownedArgs, createLanguageProcess(executable, args) {
      const process = { executable, args, start: async () => ({}), ready() {}, cancelStart() {}, disposed: false,
        async dispose() { this.disposed = true; } };
      processes.push(process); return process;
    } }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => dependencies[name] }, { filename });
  const language = module.exports.registerLanguageTools(context, { setLanguageClient() {} });
  return { language, vscode, status, clients, indexes, processes, opened, active, changed, commands, context,
    setEnabled(value) { enabled = value; changed.emit({ affectsConfiguration: key => key === 'racketdap.languageServer' }); } };
}

for (const source of ['bundled', 'installed']) test(`Rhombus-only startup registers language analysis, starts its index and shows status (${source})`, async t => {
  const instance = fixture([{ languageId: 'rhombus' }], source);
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  assert.equal(instance.clients.length, 1);
  const { options } = instance.clients[0];
  assert.deepEqual(JSON.parse(JSON.stringify(options.documentSelector)),
    source === 'bundled'
      ? [{ language: 'racket', scheme: 'file' }, { language: 'racket', scheme: 'untitled' },
        { language: 'rhombus', scheme: 'file' }, { language: 'rhombus', scheme: 'untitled' }]
      : [{ language: 'racket', scheme: 'file' }, { language: 'rhombus', scheme: 'file' }]);
  assert.equal(instance.indexes[0].starts, 1);
  assert.equal(options.synchronize.fileEvents, undefined, 'The index owns file watching');
  assert.equal(instance.status.visible, true);
  assert.match(instance.status.tooltip, /Rhombus/);
  assert.deepEqual(JSON.parse(JSON.stringify(instance.processes[0].args)),
    ['/extension/runtime/racketdap/tools/owned-command.rkt', ...(source === 'installed' ? ['-l', 'racket-langserver'] : ['/extension/language-server.rkt'])]);
  instance.vscode.window.activeTextEditor = { document: { languageId: 'plaintext' } };
  instance.active.emit(); assert.equal(instance.status.visible, false);
  instance.vscode.window.activeTextEditor = { document: { languageId: 'rhombus' } };
  instance.active.emit(); assert.equal(instance.status.visible, true);
  await instance.commands.get('racketdap.restartLanguageServer')();
  assert.equal(instance.clients.length, 2);
  assert.equal(instance.indexes[0].disposed, true);
  assert.equal(instance.processes[0].disposed, true);
});

test('opening the first Rhombus document starts analysis and supports disable/re-enable', async t => {
  const instance = fixture();
  t.after(() => instance.language.dispose());
  await instance.language.whenReady(); assert.equal(instance.clients.length, 0);
  instance.opened.emit({ languageId: 'plaintext' });
  await instance.language.whenReady(); assert.equal(instance.clients.length, 0);
  instance.opened.emit({ languageId: 'rhombus' });
  await instance.language.whenReady(); assert.equal(instance.clients.length, 1);
  instance.setEnabled(false); await instance.language.whenReady();
  assert.equal(instance.clients[0].isRunning(), false);
  instance.setEnabled(true); await instance.language.whenReady();
  assert.equal(instance.clients.length, 2); assert.equal(instance.clients[1].isRunning(), true);
});

test('Rhombus formatting blocks every S-expression edit path while Racket delegates unchanged', async t => {
  const instance = fixture([{ languageId: 'rhombus' }]);
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  const middleware = instance.clients[0].options.middleware;
  const suffixes = {
    provideDocumentFormattingEdits: [{ tabSize: 2 }, { cancelled: false }],
    provideDocumentRangeFormattingEdits: [{ start: 1, end: 2 }, { tabSize: 2 }, { cancelled: false }],
    provideDocumentRangesFormattingEdits: [[{ start: 1, end: 2 }], { tabSize: 2 }, { cancelled: false }],
    provideOnTypeFormattingEdits: [{ line: 2, character: 0 }, '\n', { tabSize: 2 }, { cancelled: false }]
  };
  for (const [name, args] of Object.entries(suffixes)) {
    const edits = [{ newText: 'server formatting result' }];
    let calls = 0;
    const next = (document, ...forwarded) => {
      calls++; assert.equal(document.languageId, 'racket'); assert.deepEqual(forwarded, args); return edits;
    };
    assert.equal(middleware[name]({ languageId: 'rhombus' }, ...args, next).length, 0);
    assert.equal(calls, 0);
    assert.equal(middleware[name]({ languageId: 'racket' }, ...args, next), edits);
    assert.equal(calls, 1);
  }
});
