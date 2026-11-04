// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./support/node-test');
const { languageServer, until } = require('./language-server-project');

// These contract tests supplement tests/vscode-rhombus.js, which requires the
// real server and private Rhombus runtime in the installed-editor harness.
function event() {
  const listeners = new Set();
  return { subscribe: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    emit: value => { for (const callback of listeners) callback(value); } };
}
function fixture(initialDocuments = [], source = 'bundled', magic) {
  const opened = event(), active = event(), changed = event();
  const clients = [], indexes = [], processes = [], commands = new Map();
  let enabled = true, settings = {};
  const disposable = () => ({ dispose() {} });
  const status = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      activeTextEditor: initialDocuments.length ? { document: initialDocuments[0] } : undefined,
      createStatusBarItem: () => status,
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, show() {} }),
      onDidChangeActiveTextEditor: active.subscribe,
      showErrorMessage: async error => { throw new Error(error); },
      showInformationMessage: async (message, ...choices) => { magic.notices.push({ message, choices }); return magic.showInformationMessage ? magic.showInformationMessage() : magic.answer; }
    },
    workspace: {
      isTrusted: true, textDocuments: initialDocuments,
      getConfiguration: section => section === 'magicRacket' ? {
        get: () => magic.enabled,
        inspect: () => ({ workspaceValue: magic.workspaceValue }),
        async update(key, value, target) { magic.updates.push({ key, value, target }); }
      } : ({ get(key, fallback) {
        if (section === undefined && key === 'racket-langserver') return settings;
        return ({ 'languageServer.enabled': enabled, 'languageServer.source': source })[key] ?? fallback;
      } }),
      onDidOpenTextDocument: opened.subscribe,
      onDidChangeConfiguration: changed.subscribe
    },
    extensions: { getExtension: id => magic && id === 'evzen-wybitul.magic-racket' ? {} : undefined },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); },
      executeCommand: async name => { magic.commands.push(name); }
    }
  };
  class Client {
    constructor(_id, _name, factory, options) { this.factory = factory; this.options = options; this.state = event(); this.notifications = []; clients.push(this); }
    createDefaultErrorHandler() { return { error() {}, closed() {} }; }
    onDidChangeState(callback) { return this.state.subscribe(callback); }
    onNotification(_method, callback) { this.indexNotification = callback; return disposable(); }
    isRunning() { return this.running; }
    async start() { await this.factory(); this.running = true; this.state.emit({ newState: 'running' }); }
    async stop() { this.running = false; }
    async sendNotification(method, params) { this.notifications.push({ method, params }); }
    dispose() { return this.stop(); }
  }
  const context = { subscriptions: [], asAbsolutePath: file => `/extension/${file}`,
    globalState: { get: key => magic?.state.get(key), update: async (key, value) => { magic.state.set(key, value); } } };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../vscode/language-client.js');
  const dependencies = {
    vscode, 'vscode-languageclient/node': { LanguageClient: Client, State: { Running: 'running' }, CloseAction: {} },
    './workspace-index': { createWorkspaceIndex(_context, options) {
      const index = { options, disposed: false, starts: 0, async start() { this.starts++; }, refresh() {},
        cancelStart() {}, async dispose() { this.disposed = true; }, provideReferences(...args) { return args.pop()(...args); } };
      indexes.push(index); return index;
    } },
    './racket-version': { racketTooOld: async () => undefined },
    './language-process': { ownedArgs: require('../vscode/language-process').ownedArgs, createLanguageProcess(executable, args) {
      const process = { executable, args, start: async () => ({}), ready() {}, cancelStart() {}, disposed: false,
        async dispose() { this.disposed = true; } };
      processes.push(process); return process;
    } }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => name === './selected-editor' ? require('../vscode/selected-editor') : dependencies[name] }, { filename });
  const language = module.exports.registerLanguageTools(context, { setLanguageClient() {} });
  return { language, vscode, status, clients, indexes, processes, opened, active, changed, commands, context,
    setSettings(value) { settings = value; },
    setEnabled(value) { enabled = value; changed.emit({ affectsConfiguration: key => key === 'racketdap.languageServer' }); } };
}

const magicRacket = values => ({ enabled: true, state: new Map(), notices: [], updates: [], commands: [], ...values });
const offer = async magic => {
  const instance = fixture([{ languageId: 'racket' }], 'bundled', magic);
  await instance.language.whenReady();
  await new Promise(resolve => setImmediate(resolve));
  await instance.language.dispose();
  return instance;
};

test('Magic Racket\u2019s server keeps the bundled one off, and the choice is offered once whatever the answer', async () => {
  for (const answer of ['Use Racketeer\u2019s Tools', 'Keep Magic Racket', undefined]) {
    const magic = magicRacket({ answer });
    const first = await offer(magic);
    assert.equal(first.clients.length, 0);
    assert.equal(first.status.text, 'Racket: external LSP');
    assert.equal(magic.notices.length, 1);
    assert.match(magic.notices[0].message, /find and rename across a project are off/);
    assert.deepEqual(magic.notices[0].choices, ['Use Racketeer\u2019s Tools', 'Keep Magic Racket']);
    await offer(magic);
    assert.equal(magic.notices.length, 1, 'A later window does not ask again');
  }
});

test('a notice still unanswered when the window goes is offered again, and only once in a window', async () => {
  const magic = magicRacket({ showInformationMessage: () => new Promise(() => {}) });
  const instance = fixture([{ languageId: 'racket' }], 'bundled', magic);
  await instance.language.whenReady();
  await new Promise(resolve => setImmediate(resolve));
  instance.changed.emit({ affectsConfiguration: key => key === 'magicRacket.languageServer.enabled' });
  await instance.language.whenReady();
  await new Promise(resolve => setImmediate(resolve));
  await instance.language.dispose();
  assert.equal(magic.notices.length, 1, 'A restart in the same window does not ask twice');
  await offer(magic);
  assert.equal(magic.notices.length, 2, 'A new window asks again while no answer was given');
});

test('choosing Racketeer turns off only Magic Racket\u2019s server, where it was on, and reloads', async () => {
  const global = magicRacket({ answer: 'Use Racketeer\u2019s Tools' });
  await offer(global);
  assert.deepEqual(global.updates, [{ key: 'languageServer.enabled', value: false, target: 1 }]);
  assert.deepEqual(global.commands, ['workbench.action.reloadWindow']);
  const workspace = magicRacket({ answer: 'Use Racketeer\u2019s Tools', workspaceValue: true });
  await offer(workspace);
  assert.deepEqual(workspace.updates, [{ key: 'languageServer.enabled', value: false, target: 2 }]);
});

test('keeping Magic Racket or dismissing the notice changes no setting and does not reload', async () => {
  for (const answer of ['Keep Magic Racket', undefined]) {
    const magic = magicRacket({ answer });
    await offer(magic);
    assert.deepEqual(magic.updates, []);
    assert.deepEqual(magic.commands, []);
  }
});

test('nothing is offered when Magic Racket\u2019s server is already off', async () => {
  const magic = magicRacket({ enabled: false });
  const instance = await offer(magic);
  assert.equal(magic.notices.length, 0);
  assert.equal(instance.clients.length, 1, 'The bundled server starts');
});

test('the analysis wait is declared as the server reads it, and reaches it in the synchronised section', async t => {
  const instance = fixture([{ languageId: 'rhombus' }], 'bundled');
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  const section = instance.clients[0].options.synchronize.configurationSection;
  const manifest = require('../vscode/package.json');
  const setting = manifest.contributes.configuration.properties[`${section}.analysisWaitMilliseconds`];
  assert.ok(setting, 'The setting belongs to the section the client sends');
  assert.equal(setting.type, 'integer');
  assert.equal(setting.minimum, 0);
  const server = path.join(__dirname, '../vendor/collects/racket-langserver');
  const settings = fs.readFileSync(path.join(server, 'common/settings.rkt'), 'utf8');
  assert.equal(setting.default, Number(/default-analysis-wait-milliseconds (\d+)\)/.exec(settings)[1]));
  assert.equal(setting.maximum, Number(/maximum-analysis-wait-milliseconds (\d+)\)/.exec(settings)[1]));
  assert.match(fs.readFileSync(path.join(server, 'common/interfaces.rkt'), 'utf8'), /#:json analysisWaitMilliseconds\]/);
});

test('both formatter settings offer language, and neither offers the name the server has for it', () => {
  const { properties } = require('../vscode/package.json').contributes.configuration;
  for (const setting of ['documentFormatter', 'indentationFormatter']) {
    assert.deepEqual(properties[`racket-langserver.formatting.${setting}`].enum, ['fixw', 'language']);
  }
});

test('settings reach the server by its reading them, with language under the name the server knows', async t => {
  const instance = fixture([{ languageId: 'racket' }]);
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  const { workspace } = instance.clients[0].options.middleware;
  const sent = [];
  await workspace.didChangeConfiguration(['racket-langserver'], async sections => { sent.push(sections); });
  assert.deepEqual(sent, [undefined], 'A change sends no settings, so the server asks for them');
  const read = async (...sections) => JSON.parse(JSON.stringify(
    await workspace.configuration({ items: sections.map(() => ({})) }, {}, () => sections)));
  const section = (documentFormatter, indentationFormatter) => ({
    analysisWaitMilliseconds: 40, formatting: { documentFormatter, indentationFormatter, fmtSettings: { width: 80 } } });
  assert.deepEqual(await read(section('language', 'language')), [section('drracket', 'drracket')]);
  assert.deepEqual(await read(section('fixw', 'language')), [section('fixw', 'drracket')]);
  assert.deepEqual(await read(section('fmt', 'fixw')), [section('fmt', 'fixw')]);
  assert.deepEqual(await read(section('drracket', 'drracket')),
    [{ analysisWaitMilliseconds: 40, formatting: { fmtSettings: { width: 80 } } }], 'The old value is as good as not set');
  assert.deepEqual(await read({ resyntax: { enable: true } }, null, 7), [{ resyntax: { enable: true } }, null, 7]);
});

test('installed servers receive translated settings without requiring support for pull on change', async t => {
  const instance = fixture([{ languageId: 'racket' }], 'installed');
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  const client = instance.clients[0];
  const settings = { analysisWaitMilliseconds: 600, resyntax: { enable: false }, formatting: {
    documentFormatter: 'language', indentationFormatter: 'fixw', fmtSettings: { width: 91 }
  } };
  instance.setSettings(settings);
  await client.options.middleware.workspace.didChangeConfiguration(['racket-langserver'], () => {
    assert.fail('An older installed server cannot pull after settings: null');
  });
  assert.deepEqual(JSON.parse(JSON.stringify(client.notifications)), [{
    method: 'workspace/didChangeConfiguration', params: { settings: { 'racket-langserver': {
      ...settings, formatting: { ...settings.formatting, documentFormatter: 'drracket' }
    } } }
  }]);
  assert.equal(settings.formatting.documentFormatter, 'language');
});

test('language selects the indenter in the server, and the old value leaves its default', async t => {
  const instance = fixture([{ languageId: 'racket' }]);
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  const { workspace } = instance.clients[0].options.middleware;
  const server = await languageServer(t, { capabilities: { workspace: { configuration: true } } });
  let documentFormatter = 'fixw';
  server.connection.onRequest('workspace/configuration', (params, token) =>
    workspace.configuration(params, token, () => [{ formatting: { documentFormatter } }]));
  await server.open('format.rkt', '#lang racket/base\n(define  (f  x)\n(+ x   1))\n');
  // fixw also rewrites the spaces inside a line; the indenter changes only where a line starts.
  const formatted = async () => (await server.request('formatting', 'format.rkt',
    { options: { tabSize: 2, insertSpaces: true } })).map(edit => edit.newText);
  const fixw = ['(define (f x)', '  (+ x 1))'], indenter = ['  '];
  const choose = async (value, expected) => {
    documentFormatter = value;
    await workspace.didChangeConfiguration(['racket-langserver'], () =>
      server.connection.sendNotification('workspace/didChangeConfiguration', { settings: null }));
    await until(async () => JSON.stringify(await formatted()) === JSON.stringify(expected),
      `${value} formats as expected`, server.errors);
  };
  await choose('language', indenter);
  await choose('drracket', fixw);
  await choose('language', indenter);
  await choose('fixw', fixw);
});

for (const source of ['bundled', 'installed']) test(`Rhombus-only startup registers language analysis, leaves its index to the first request and shows status (${source})`, async t => {
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
  assert.equal(instance.indexes[0].starts, 0, 'The index starts at the first request for it');
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

test('the status bar counts a pass and stops when it is stopped', async t => {
  const instance = fixture([{ languageId: 'rhombus' }], 'bundled');
  t.after(() => instance.language.dispose());
  await instance.language.whenReady();
  const { onStatus } = instance.indexes[0].options;
  onStatus({ state: 'indexing' });
  assert.equal(instance.status.text, '$(sync~spin) Racket: indexing');
  onStatus({ state: 'indexing', message: '3/53' });
  assert.equal(instance.status.text, '$(sync~spin) Racket: indexing 3/53');
  onStatus({ state: 'outdated', indexed: 0, total: 0, failures: 0 });
  assert.equal(instance.status.text, 'Racket: ready');
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
