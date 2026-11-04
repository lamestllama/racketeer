// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function (workspace) {
  const directory = path.join(workspace.uri.fsPath, 'repl sessions');
  const config = vscode.workspace.getConfiguration('racketdap');
  const previous = config.inspect('repl.sessionScope')?.workspaceValue;
  const terminals = new Set();
  async function command(name) {
    const terminal = await vscode.commands.executeCommand(`racketdap.${name}`);
    assert.ok(terminal, name + ' returns a terminal');
    terminals.add(terminal);
    return terminal;
  }
  const output = name => path.join(directory, name + '.txt');
  const write = (name, expression) => `(call-with-output-file ${JSON.stringify(output(name))} #:exists 'truncate (lambda (out) (display ${expression} out)))`;
  const written = (name, expected) => until(() => fs.existsSync(output(name)) &&
    fs.readFileSync(output(name), 'utf8') === String(expected), 'REPL writes ' + name);
  async function evaluate(terminal, name, expression, expected) {
    terminal.sendText(write(name, expression));
    await written(name, expected);
  }
  const documents = [];
  for (const [name, value] of [['alpha', 10], ['beta', 20]]) {
    const filename = path.join(directory, name, process.platform === 'win32' ? "module 'λ'.rkt" : 'module "λ".rkt');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `#lang racket/base\n(define value ${value})\n(define state (box 0))\n; ${write(name, 'value')}\n`);
    documents.push(await vscode.workspace.openTextDocument(filename));
  }
  const [alpha, beta] = documents;
  try {
    await config.update('repl.sessionScope', 'file', vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(alpha);
    const first = await command('startRepl');
    assert.equal(await command('loadFile'), first);
    await vscode.window.showTextDocument(beta);
    const second = await command('loadFile');
    assert.notEqual(first, second, 'File sessions isolate modules even when their basenames match');
    assert.notEqual(first.name, second.name, 'Terminal labels distinguish the files');
    for (const [document, terminal, name, value] of [[alpha, first, 'alpha', 10], [beta, second, 'beta', 20]]) {
      const editor = await vscode.window.showTextDocument(document);
      assert.equal(await command('startRepl'), terminal);
      editor.selection = new vscode.Selection(3, 2, 3, document.lineAt(3).text.length);
      assert.equal(await command('sendSelection'), terminal);
      await written(name, value);
    }
    await evaluate(first, 'alpha-state', '(begin (set-box! state 100) (+ value (unbox state)))', 110);
    await evaluate(second, 'beta-state', '(begin (set-box! state 200) (+ value (unbox state)))', 220);

    const editor = await vscode.window.showTextDocument(alpha);
    await editor.edit(edit => edit.replace(alpha.lineAt(1).range, '(define value 30)'));
    assert.equal(alpha.isDirty, true);
    assert.equal(await alpha.save(), true);
    // Module reloads compare modification times, including on coarse filesystems.
    const modified = new Date(Date.now() + 2000);
    fs.utimesSync(alpha.uri.fsPath, modified, modified);
    assert.equal(await command('loadFile'), first);
    await evaluate(first, 'alpha-reloaded', '(+ value (unbox state))', 30);
    await evaluate(second, 'beta-retained', '(+ value (unbox state))', 220);

    first.dispose();
    await until(() => !vscode.window.terminals.includes(first), 'closed terminal removed');
    const replacement = await command('loadFile');
    assert.notEqual(replacement, first);
    await evaluate(replacement, 'alpha-reopened', 'value', 30);
    await vscode.window.showTextDocument(beta);
    assert.equal(await command('startRepl'), second);
    second.sendText('(exit)');
    await until(() => second.exitStatus !== undefined, 'Racket process exits');
    const restarted = await command('loadFile');
    assert.notEqual(restarted, second);
    await evaluate(restarted, 'beta-restarted', 'value', 20);

    await config.update('repl.sessionScope', 'workspace', vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(alpha);
    const shared = await command('loadFile');
    assert.notEqual(shared, replacement);
    await vscode.window.showTextDocument(beta);
    assert.equal(await command('loadFile'), shared, 'Workspace mode shares a terminal');
    await evaluate(shared, 'workspace', 'value', 20);
    await config.update('repl.sessionScope', 'file', vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(alpha);
    assert.equal(await command('startRepl'), replacement, 'Changing scope preserves existing file sessions');
    await vscode.window.showTextDocument(beta);
    assert.equal(await command('startRepl'), restarted);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(await command('startRepl'), shared, 'No source editor uses the workspace session');
    const untitled = await vscode.workspace.openTextDocument({ language: 'racket', content: write('untitled', '(+ 2 3)') });
    const untitledEditor = await vscode.window.showTextDocument(untitled);
    untitledEditor.selection = new vscode.Selection(0, 0, 0, untitled.lineAt(0).text.length);
    assert.equal(await command('sendSelection'), shared, 'Unsaved files use the workspace session');
    await written('untitled', 5);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    return ['file REPL isolation and selection routing', 'distinct labels for duplicate basenames',
      'reload one module while retaining the other session', 'closed and exited REPL recreation',
      'workspace sharing and scope changes preserve sessions', 'no editor and untitled buffer REPL fallback'];
  } finally {
    for (const terminal of terminals) terminal.dispose();
    await config.update('repl.sessionScope', previous, vscode.ConfigurationTarget.Workspace);
  }
};
