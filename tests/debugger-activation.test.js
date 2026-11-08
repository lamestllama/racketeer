// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('./support/node-test');
const { until } = require('./support/wait');
const root = path.resolve(__dirname, '..');

function load(file, dependencies, platform) {
  const filename = path.join(root, 'vscode', file);
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: { platform },
    require: name => dependencies[name] || localRequire(name)
  }, { filename });
  return module.exports;
}

for (const platform of ['linux', 'darwin', 'win32']) test(`${platform}: activation starts one debugger build before any debug session`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer activation '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime/racketdap');
  fs.cpSync(path.join(root, 'racketdap'), runtime, { recursive: true, filter: file => path.basename(file) !== 'compiled' });
  // Exercise the real launcher and build lock without compiling the full debugger.
  const marker = path.join(directory, 'built');
  fs.writeFileSync(path.join(runtime, 'tools/compile-debugger.rkt'), `#lang racket/base
(require racket/os)
(call-with-output-file ${JSON.stringify(marker)} #:exists 'append
  (lambda (out) (displayln (getpid) out)))
`);
  const calls = [];
  const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(directory, 'storage') },
    asAbsolutePath: file => path.join(directory, file) };
  const languageProcess = load('language-process.js', {}, platform);
  let descriptor;
  const disposable = () => ({ dispose() {} });
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: 'workspace' }],
      getConfiguration(section, uri) {
        assert.equal(section, 'racketdap'); assert.equal(uri, 'workspace');
        return { get: (key, fallback) => key === 'racketExecutable' ? (process.env.RACKET || 'racket') : fallback };
      } },
    debug: { registerDebugConfigurationProvider: disposable, registerDebugAdapterTrackerFactory: disposable,
      registerDebugAdapterDescriptorFactory(_type, factory) { descriptor = factory; return disposable(); } },
    commands: { registerCommand: disposable },
    DebugAdapterExecutable: class { constructor(command, args) { this.command = command; this.args = args; } }
  };
  const dependencies = { vscode, './language-process': languageProcess,
    'node:child_process': { execFile(command, args, callback) { calls.push({ command, args }); callback?.(null, '', ''); } } };
  // Registration is independent of starting a server or a debug session.
  for (const name of ['terminal', 'language-client', 'debug-version', 'commands', 'debug-actions', 'debug-images',
    'debug-sources', 'sessions', 'testing', 'debug-repl', 'interactions', 'file-runs', 'packages',
    'application-builds', 'application-logs', 'wxme-viewer', 'wxme-editor', 'dependencies']) {
    dependencies['./' + name] = new Proxy({}, { get: () => () => ({ whenReady() {}, dispose() {} }) });
  }
  const extension = load('extension.js', dependencies, platform);
  const api = extension.activate(context);
  await api.languageServerReady(); await api.languageServerReady();
  assert.equal(calls.length, 1, 'Activation must start the build without a server or debug session');
  const owned = Array.from(languageProcess.ownedArgs(context, ['server.rkt']));
  assert.deepEqual(owned, platform === 'win32'
    ? [...languageProcess.debuggerArgs(context, 'tools/owned-command.rkt'), '--supervise-input', 'server.rkt'] : ['server.rkt']);
  descriptor.createDebugAdapterDescriptor({ configuration: { racketExecutable: 'racket' } });
  assert.equal(calls.length, 1, 'Starting a debug session does not repeat the activation build');
  const { command, args } = calls[0];
  assert.equal(command, process.env.RACKET || 'racket');
  assert.ok(args.includes(path.join(context.globalStorageUri.fsPath, 'debugger')), 'Use the debugger storage');
  await promisify(execFile)(command, args);
  const builders = (await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim(),
    'Activation reaches the debugger builder')).split('\n');
  assert.equal(builders.length, 1);
  await until(() => {
    try { process.kill(Number(builders[0]), 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'The debugger builder exits');
  await extension.deactivate();
});
