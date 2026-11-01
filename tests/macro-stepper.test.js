// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createMacroProcess } = require('../vscode/macro-process');
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'racketdap/tools/macro-stepper.rkt');
const racket = process.env.RACKET || 'racket';
function request(text, mode = 'fragment') {
  return { text, mode, source: 'untitled:macro-test', sourceIsFile: false, prefix: '', directory: root, cwd: root };
}
function owned(command, program, input) {
  let output = '', errors = [], code;
  const process = createMacroProcess(command, program, input, {
    output: text => { output += text; }, failure: error => errors.push(error), finished: value => { code = value; }
  });
  return { process, get output() { return output; }, get errors() { return errors; }, get code() { return code; } };
}
function load(dependencies) {
  const filename = path.join(root, 'vscode/macro-stepper.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: name => dependencies[name] || localRequire(name)
  }, { filename });
  return module.exports;
}
function emitter() {
  const callbacks = new Set();
  return { event(callback) { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; },
    fire(value) { for (const callback of callbacks) callback(value); }, dispose() { callbacks.clear(); } };
}

test('buffer capture selects the line or exact selection, preserving Unicode prefix and module directory', () => {
  const buffer = '; 😀\r\n\t(or #f 42)\n';
  const start = buffer.indexOf('(or');
  const uri = { scheme: 'file', fsPath: '/workspace/sub/dirty λ.rkt' };
  const folder = { uri: { fsPath: '/workspace' } };
  const vscode = { workspace: { getWorkspaceFolder: () => folder,
    getConfiguration: () => ({ get: () => '/tools/Racket binary' }) } };
  const { macroTarget } = load({ vscode });
  const editor = { document: { uri, languageId: 'racket', getText: () => buffer,
    offsetAt: position => position.offset,
    lineAt: () => ({ range: { start: { offset: start - 1 }, end: { offset: buffer.length - 1 } } }) },
    selection: { isEmpty: true, active: { line: 1 } } };
  const line = macroTarget(editor, false);
  assert.equal(line.request.text, '\t(or #f 42)');
  assert.equal(line.request.prefix, '; 😀\r\n');
  assert.equal(line.request.directory, '/workspace/sub');
  assert.equal(line.request.cwd, '/workspace');
  assert.equal(line.executable, '/tools/Racket binary');
  editor.selection = { isEmpty: false, start: { offset: start }, end: { offset: buffer.length - 1 } };
  assert.equal(macroTarget(editor, false).request.text, '(or #f 42)');
  assert.equal(macroTarget(editor, true).request.text, buffer);
  editor.document.uri = { scheme: 'untitled', toString: () => 'untitled:Untitled-1' };
  assert.equal(macroTarget(editor, true).request.source, 'untitled:Untitled-1');
  editor.document.getText = () => '   ';
  assert.throws(() => macroTarget(editor, true), /no Racket forms/);
});

test('missing configured executable reports once and cancellation before open starts nothing', async () => {
  const missing = owned(path.join(os.tmpdir(), 'racketeer-no-such-executable'), helper, request('42'));
  missing.process.start(); await missing.process.done;
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /racketExecutable/);
  const cancelled = owned('must-not-run', helper, request('42'));
  await cancelled.process.stop(); cancelled.process.start();
  await cancelled.process.done;
  assert.equal(cancelled.code, 0);
  assert.deepEqual(cancelled.errors, []);
});

test('workspace trust and disposal before the owned terminal opens prevent launch', async () => {
  let pty, launched = 0, stopped = 0, terminated = 0, shown = 0;
  const terminal = { dispose() { terminated++; }, show(preserveFocus) { assert.equal(preserveFocus, true); shown++; } };
  const vscode = { EventEmitter: emitter,
    workspace: { isTrusted: false, workspaceFolders: [], getWorkspaceFolder() {},
      getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: {
      activeTextEditor: { document: { languageId: 'racket',
        uri: { scheme: 'untitled', toString: () => 'untitled:1' }, getText: () => '(or #f 42)' } },
      createTerminal(options) { assert.equal(options.isTransient, true); pty = options.pty; return terminal; }
    },
    tasks: { executeTask() { throw new Error('Macro inspection must not execute a task or auto-save editors'); } }
  };
  const context = { subscriptions: [], asAbsolutePath: value => value };
  const open = load({ vscode, './macro-process': { createMacroProcess: (_command, _helper, _request, handlers) => ({
    start() { launched++; }, stop() { stopped++; handlers.finished(0); return Promise.resolve(); }
  }) } }).registerMacroStepper(context);
  await assert.rejects(open(true), /Trust this workspace/);
  vscode.workspace.isTrusted = true;
  assert.equal(await open(true), terminal);
  assert.equal(shown, 1);
  context.subscriptions[0].dispose();
  let closed;
  pty.onDidClose(code => { closed = code; });
  pty.open();
  assert.equal(closed, 0);
  assert.equal(launched, 0);
  assert.equal(stopped, 1);
  assert.equal(terminated, 1);
});

test('closing an opened macro terminal stops only its owned process', async () => {
  const terminals = [], processes = [];
  const vscode = { EventEmitter: emitter,
    workspace: { isTrusted: true, workspaceFolders: [], getWorkspaceFolder() {},
      getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: {
      activeTextEditor: { document: { languageId: 'racket',
        uri: { scheme: 'untitled', toString: () => 'untitled:1' }, getText: () => '(or #f 42)' } },
      createTerminal({ pty }) {
        const terminal = { show() { pty.open(); }, dispose() { pty.close(); } };
        terminals.push(terminal); return terminal;
      }
    }
  };
  const context = { subscriptions: [], asAbsolutePath: value => value };
  const open = load({ vscode, './macro-process': { createMacroProcess: (_command, _helper, _request, handlers) => {
    const process = { started: false, stopped: false, start() { this.started = true; }, stop() {
      if (!this.stopped) { this.stopped = true; handlers.finished(0); }
      return Promise.resolve();
    } };
    processes.push(process); return process;
  } } }).registerMacroStepper(context);
  const first = await open(true), second = await open(true);
  assert.ok(processes.every(process => process.started));
  first.dispose();
  assert.equal(processes[0].stopped, true);
  assert.equal(processes[1].stopped, false);
  context.subscriptions[0].dispose();
  assert.equal(processes[1].stopped, true);
  assert.equal(second, terminals[1]);
});

test('missing graphical display surfaces a native startup error', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  const child = spawn(racket, [helper], { cwd: root, env: { ...process.env, DISPLAY: ':9876', WAYLAND_DISPLAY: '' } });
  let stderr = ''; child.stderr.on('data', text => { stderr += text; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(request('(or #f 42)')) + '\n');
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(stderr, /Gtk initialization failed|display|GUI/i);
});
