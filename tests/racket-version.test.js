// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// What a person with an older Racket is told on each way in, with a stand-in Racket.
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { racketPath, versionProblem, racketTooOld } = require('../vscode/racket-version');

// A shell script stands in, and Windows starts no script without a shell.
const stands = { skip: process.platform === 'win32' && 'a stand-in Racket is a shell script' };
function standIn(t, version = 'Welcome to Racket v9.0 [cs].') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racket version-'));
  const file = path.join(directory, 'racket');
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return file;
}
function load(name, dependencies) {
  const filename = path.join(__dirname, '..', 'vscode', name);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, setTimeout, clearTimeout, setInterval, clearInterval,
    require: required => Object.hasOwn(dependencies, required) ? dependencies[required] : localRequire(required)
  }, { filename });
  return module.exports;
}
const disposable = () => ({ dispose() {} });
const expected = file => `Racket 9.0 at ${file} is too old: Racketeer needs Racket 9.1 or newer. Set racketdap.racketExecutable to a newer Racket.`;

test('a version is too old below 9.1, and names itself, its file and the setting', () => {
  const env = { PATH: '' };
  for (const version of ['9.0', '8.18', '9.0.0.7', '6.12']) {
    const problem = versionProblem(`Welcome to Racket v${version} [cs].\n`, '/opt/racket/bin/racket', env);
    assert.match(problem, new RegExp(`^Racket ${version.replaceAll('.', '\\.')} at .*racket is too old`));
    assert.ok(problem.includes(path.resolve('/opt/racket/bin/racket')), problem);
    assert.match(problem, /Racket 9\.1 or newer/);
    assert.match(problem, /racketdap\.racketExecutable/);
  }
  for (const version of ['9.1', '9.1.0.3', '9.3', '9.10', '10.0']) {
    assert.equal(versionProblem(`Welcome to Racket v${version} [cs].\n`, 'racket', env), undefined, version);
  }
  assert.match(versionProblem('Hello\n', 'racket', env), /racket did not report a Racket version.*Racket 9\.1 or newer.*racketdap\.racketExecutable/);
});

test('a command name is reported as the file the search path finds first', stands, t => {
  const file = standIn(t);
  const later = standIn(t, 'Welcome to Racket v9.1 [cs].');
  const search = { PATH: [path.join(os.tmpdir(), 'no such folder'), path.dirname(file), path.dirname(later)].join(path.delimiter) };
  assert.equal(racketPath('racket', search), file);
  assert.equal(racketPath(later, search), later);
  assert.equal(racketPath('racket', { PATH: '' }), 'racket');
  assert.equal(versionProblem('Welcome to Racket v9.0 [cs].', 'racket', search), expected(file));
});

test('asking a Racket reports an old or unusable executable', stands, async t => {
  const old = standIn(t);
  assert.equal(await racketTooOld(old), expected(old));
  assert.equal(await racketTooOld(standIn(t, 'Welcome to Racket v9.1 [cs].')), undefined);
  assert.match(await racketTooOld(path.join(path.dirname(old), 'nothing here')), /Cannot check.*racketExecutable/);
});

test('Run or Debug says the Racket found is too old, and offers the setting', stands, async t => {
  const old = standIn(t);
  let provider, command;
  const errors = [];
  const vscode = { workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showErrorMessage: async (message, ...actions) => { errors.push({ message, actions }); return actions[0]; } },
    debug: { registerDebugConfigurationProvider(_type, value) { provider = value; return disposable(); },
      registerDebugAdapterDescriptorFactory: disposable, registerDebugAdapterTrackerFactory: disposable },
    commands: { registerCommand: disposable, executeCommand: async (...args) => { command = args; } } };
  const dependencies = { vscode };
  for (const [name, method] of Object.entries({ terminal: 'createProgramTerminal', 'language-client': 'registerLanguageTools',
    commands: 'registerFileCommands', 'debug-actions': 'registerDebugActions', 'debug-images': 'registerDebugImages',
    'debug-sources': 'registerDebugSources', sessions: 'registerSessions', testing: 'registerTesting', 'debug-repl': 'registerDebugRepl',
    interactions: 'registerInteractions', 'file-runs': 'registerFileRuns', packages: 'registerPackages',
    'application-builds': 'registerApplicationBuilds', 'wxme-viewer': 'registerWxmeViewer', 'wxme-editor': 'registerWxmeEditor',
    dependencies: 'registerDependencies' })) dependencies[`./${name}`] = { [method]: () => ({}) };
  dependencies['./application-logs'] = { registerApplicationLogs: () => ({}), filterError: () => undefined };
  load('extension.js', dependencies).activate({ subscriptions: [], asAbsolutePath: file => path.join('/extension', file) });
  const program = path.resolve(__dirname, '../examples/demo.rkt');
  const launch = { request: 'launch', program, racketExecutable: old };
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, launch), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, expected(old));
  assert.deepEqual(Array.from(errors[0].actions), ['Open Settings']);
  await new Promise(setImmediate);
  assert.deepEqual(command, ['workbench.action.openSettings', '@id:racketdap.racketExecutable']);
  // One that cannot run is a different fault, and says so.
  const missing = path.join(path.dirname(old), 'nothing here');
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { ...launch, racketExecutable: missing }), undefined);
  assert.match(errors[1].message, /^Cannot start Racket DAP: .*ENOENT.*racketdap\.racketExecutable/);
});

function refusedLaunches() {
  return { workspace: { isTrusted: true }, debug: { registerDebugAdapterTrackerFactory: disposable,
    onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable, startDebugging: async () => false } };
}
test('a workflow whose launch is refused says the Racket found is too old', stands, async t => {
  const old = standIn(t);
  const context = { subscriptions: [] };
  const sessions = load('sessions.js', { vscode: refusedLaunches(),
    './execution': { launchConfiguration: (_target, config) => config } }).registerSessions(context);
  await assert.rejects(sessions.start({ program: 'p.rkt', racketExecutable: old }, {}), { message: expected(old) });
  // A launch refused for anything else keeps the general message.
  const current = standIn(t, 'Welcome to Racket v9.1 [cs].');
  await assert.rejects(sessions.start({ program: 'p.rkt', racketExecutable: current }, {}), /cancelled or failed/);
  context.subscriptions.forEach(item => item.dispose());
});

test('Test Explorer says the Racket found is too old, for discovery and for a run', stands, async t => {
  const old = standIn(t);
  const collection = () => {
    const map = new Map();
    return { add: item => map.set(item.id, item), get: id => map.get(id), delete: id => map.delete(id), get size() { return map.size; },
      replace(items) { map.clear(); items.forEach(item => map.set(item.id, item)); },
      forEach: callback => map.forEach(item => callback(item)), [Symbol.iterator]: () => map.entries() };
  };
  const results = [];
  const never = { onCancellationRequested: disposable, isCancellationRequested: false };
  const profiles = [];
  const controller = { items: collection(), dispose() {}, invalidateTestResults() {},
    createTestItem: (id, label, uri) => ({ id, label, uri, children: collection() }),
    createRunProfile: (label, _kind, handler) => { const profile = { label, handler }; profiles.push(profile); return profile; },
    createTestRun: () => ({ token: never, enqueued() {}, started() {}, passed() {}, skipped() {}, failed() {}, appendOutput() {},
      end() {}, errored: (item, message) => results.push({ item, message: message.message }) }) };
  const uri = { scheme: 'file', fsPath: path.join(path.dirname(old), 'tests.rkt'), toString: () => 'file:///tests.rkt' };
  const document = { uri, version: 1, isDirty: false, languageId: 'racket', getText: () => '#lang racket/base\n' };
  const events = { onDidCreate: disposable, onDidDelete: disposable, onDidChange: disposable, dispose() {} };
  const vscode = { ...refusedLaunches(),
    tests: { createTestController: () => controller },
    TestTag: class {}, TestMessage: class { constructor(message) { this.message = message; } },
    TestRunProfileKind: {}, TestRunRequest: class { constructor(include) { this.include = include; } },
    RelativePattern: class {}, CancellationTokenSource: class { token = never; cancel() {} dispose() {} },
    workspace: { isTrusted: true, workspaceFolders: [], textDocuments: [], getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (key, fallback) => key === 'racketExecutable' ? old : fallback }),
      openTextDocument: async () => document, createFileSystemWatcher: () => events, findFiles: async () => [],
      onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable, onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: disposable } };
  const execution = load('execution.js', { vscode, './selected-editor': { selectedEditor() {} } });
  const context = { subscriptions: [], asAbsolutePath: file => file };
  const sessions = load('sessions.js', { vscode, './execution': execution }).registerSessions(context);
  const testing = load('testing.js', { vscode, './execution': execution, './packages': { runPackageTask() {} },
    './test-coverage': { TestCoverage: class {}, loadDetailedCoverage() {} } }).registerTesting(context, sessions);
  const totals = await testing.runFile(uri);
  assert.equal(totals.errored, 1);
  assert.deepEqual(results.map(result => result.message), [expected(old)]);
  const listed = [...controller.items].map(([, value]) => value)[0];
  await until(() => !(listed.error !== expected(old)));
  assert.equal(listed.error, expected(old));
  context.subscriptions.forEach(entry => entry.dispose());
});

function languageTools(executable, starts) {
  const commands = new Map(), errors = [], statuses = [];
  const status = { show() {}, hide() {}, dispose() {},
    set text(value) { statuses.push(value); }, get text() { return statuses.at(-1); } };
  const vscode = { StatusBarAlignment: { Left: 1 },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {}, show() {} }), createStatusBarItem: () => status,
      showErrorMessage: async (message, ...actions) => { errors.push({ message, actions }); }, onDidChangeActiveTextEditor: disposable },
    workspace: { isTrusted: true, textDocuments: [], workspaceFolders: [],
      getConfiguration: () => ({ get: (key, fallback) => key === 'racketExecutable' ? executable : fallback }),
      createFileSystemWatcher: disposable, onDidOpenTextDocument: disposable, onDidChangeConfiguration: disposable },
    extensions: { getExtension() {} },
    commands: { registerCommand(id, command) { commands.set(id, command); return disposable(); } } };
  class Client {
    constructor(_id, _name, factory) { this.factory = factory; }
    createDefaultErrorHandler() { return {}; }
    onDidChangeState = disposable;
    isRunning() { return false; }
    async dispose() {}
    error() {}
    async start() { await this.factory(); }
  }
  const tools = load('language-client.js', { vscode,
    'vscode-languageclient/node': { LanguageClient: Client, State: {}, CloseAction: {} },
    './workspace-index': { createWorkspaceIndex: () => ({ cancelStart() {}, async dispose() {} }) },
    './language-process': { ownedArgs: () => [], createLanguageProcess: () => ({ start: async () => { starts.push(executable); },
      cancelStart() {}, ready() {}, dispose: async () => {} }) }
  }).registerLanguageTools({ subscriptions: [], asAbsolutePath: value => value });
  return { commands, errors, statuses, tools };
}

test('the language server does not start on a Racket that is too old, and says so once', stands, async t => {
  const old = standIn(t), starts = [];
  const { commands, errors, tools } = languageTools(old, starts);
  t.after(() => tools.dispose());
  await commands.get('racketdap.restartLanguageServer')();
  assert.deepEqual(starts, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, `Racket language server could not start: ${expected(old)}`);
  assert.deepEqual(Array.from(errors[0].actions), ['Open Settings', 'Show Output']);
});

test('the language server starts on a current Racket', stands, async t => {
  const current = standIn(t, 'Welcome to Racket v9.1 [cs].'), starts = [];
  const { commands, errors, tools } = languageTools(current, starts);
  t.after(() => tools.dispose());
  await commands.get('racketdap.restartLanguageServer')();
  assert.deepEqual(starts, [current]);
  assert.deepEqual(errors, []);
});

test('the workspace index does not start on a Racket that is too old, and each request says so', stands, async t => {
  const old = standIn(t), statuses = [];
  let started = 0;
  const parse = value => ({ scheme: 'file', fsPath: value, toString: () => value });
  const events = () => disposable;
  const workspace = { workspaceFolders: [{ uri: parse('/workspace') }], textDocuments: [],
    getConfiguration: () => ({ get: () => ({ enabled: true, timeoutSeconds: 120 }) }),
    onDidOpenTextDocument: events(), onDidCloseTextDocument: events(), onDidChangeTextDocument: events(),
    onDidChangeWorkspaceFolders: events(), onDidChangeConfiguration: events() };
  const { createWorkspaceIndex } = load('workspace-index.js', { vscode: { workspace, Uri: { parse } },
    'vscode-languageclient/node': {},
    './language-process': { ownedArgs: () => [], createLanguageProcess: () => ({ start: async () => { started++; }, cancelStart() {}, ready() {}, dispose: async () => {} }) } });
  const index = createWorkspaceIndex({ asAbsolutePath: file => file },
    { supportsDocument: document => document.languageId === 'racket', executable: old, timeout: 1000, output: { append() {}, appendLine() {} }, onStatus: value => statuses.push(value) });
  t.after(() => index.dispose());
  const document = { uri: parse('/workspace/a.rkt'), languageId: 'racket', version: 1, isClosed: false, getText: () => '' };
  const token = { isCancellationRequested: false };
  for (let request = 1; request <= 2; request++) {
    await assert.rejects(index.provideReferences(document, { line: 0, character: 0 }, {}, token, () => []), { message: expected(old) });
    assert.equal(statuses.length, request);
    assert.deepEqual({ ...statuses.at(-1) }, { state: 'refused', message: expected(old) });
  }
  await assert.rejects(index.provideRenameEdits(document, { line: 0, character: 0 }, 'b', token), { message: expected(old) });
  assert.equal(started, 0);
});

test('a failed version probe gives a reason, and terminates a hung executable', stands, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racket probe-'));
  const executable = path.join(directory, 'racket');
  fs.writeFileSync(executable, '#!/bin/sh\ntrap "" TERM\nwhile :; do :; done\n', { mode: 0o755 });
  const children = [];
  const implementation = load('racket-version.js', {
    'node:child_process': { execFile(...args) {
      const child = require('node:child_process').execFile(...args);
      children.push(child);
      return child;
    } }
  });
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }));
  let timer;
  const result = await Promise.race([
    implementation.racketTooOld(executable),
    new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 240000); })
  ]);
  clearTimeout(timer);
  assert.match(result, /Cannot check.*racketExecutable/s);
});
