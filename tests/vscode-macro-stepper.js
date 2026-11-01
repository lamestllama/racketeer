// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Runs in the isolated installed-artifact editor harness. Native widget
// navigation is checked separately through public Racket GUI APIs.
exports.run = async function (extension, workspace) {
  const configuration = vscode.workspace.getConfiguration('racketdap', workspace.uri);
  const previous = configuration.inspect('languageServer.enabled').workspaceValue;
  await configuration.update('languageServer.enabled', false, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('racketdap.restartLanguageServer');
  await extension.exports.languageServerReady();
  const directory = path.join(workspace.uri.fsPath, 'macro-stepper-acceptance');
  const source = path.join(directory, 'dirty λ😀.rkt');
  const marker = path.join(directory, 'expanded.txt');
  const runtime = path.join(directory, 'runtime-must-not-run.txt');
  let terminal, sourceDocument, untitledDocument;
  const ended = new Set();
  const active = new Set();
  const subscription = vscode.window.onDidCloseTerminal(value => ended.add(value));
  // Creating the marker precedes writing and closing it in the worker.
  const markerWritten = (file, expected) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === expected;
  const timeout = async (predicate, description) => {
    const started = Date.now();
    const deadline = started + 20000;
    while (Date.now() < deadline) {
      if (predicate()) {
        console.log(`${description}: ${Date.now() - started} ms`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${description}; terminals: ${JSON.stringify([...active].map(value => ({
      name: value.name, exitStatus: value.exitStatus
    })))}`);
  };
  async function closeTerminal() {
    if (!terminal) return;
    terminal.dispose();
    await timeout(() => ended.has(terminal), 'macro-stepper terminal ends');
    active.delete(terminal);
    terminal = undefined;
  }
  async function launch(command) {
    const opened = await vscode.commands.executeCommand(command);
    if (opened) active.add(opened);
    return opened;
  }
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'support.rkt'),
      '#lang racket/base\n(provide answer)\n(define-syntax-rule (answer) 42)\n(error "import runtime must not run")\n');
    fs.writeFileSync(source, '#lang racket/base\n(error "on-disk version must not be used")\n');
    const document = await vscode.workspace.openTextDocument(source);
    sourceDocument = document;
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      `#lang racket/base\n(require "support.rkt" (for-syntax racket/base))\n` +
      `(begin-for-syntax (call-with-output-file ${JSON.stringify(marker)} #:exists 'truncate (lambda (out) (display "expanded buffer" out))))\n` +
      `(define result (answer))\n(call-with-output-file ${JSON.stringify(runtime)} (lambda (out) (display result out)))\n`);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    terminal = await launch('racketdap.openFileInMacroStepper');
    assert.ok(terminal, 'Whole-file command returns its owned terminal');
    await timeout(() => markerWritten(marker, 'expanded buffer'), 'dirty module expands with relative macro import');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'expanded buffer');
    assert.equal(fs.existsSync(runtime), false, 'Module runtime body was not instantiated');
    assert.match(fs.readFileSync(source, 'utf8'), /on-disk version/, 'Command does not save the document');
    assert.equal(document.isDirty, true, 'Macro inspection preserves the dirty editor');
    assert.equal(ended.has(terminal), false, 'Native GUI remains owned by its terminal');
    await closeTerminal();

    const lineMarker = path.join(directory, 'line.txt');
    const selectionMarker = path.join(directory, 'selection.txt');
    const fragment = output => `(let-syntax ([m (lambda (stx) (call-with-output-file ${JSON.stringify(output)} #:exists 'truncate (lambda (out) (display (syntax-line stx) out))) (datum->syntax stx '(or #f 42)))]) (m))`;
    const line = fragment(lineMarker), selection = fragment(selectionMarker);
    const untitled = await vscode.workspace.openTextDocument({ language: 'racket',
      content: `; first line\n${line}\n${selection}\n` });
    untitledDocument = untitled;
    await vscode.window.showTextDocument(untitled, { selection: new vscode.Range(1, 3, 1, 3) });
    terminal = await launch('racketdap.openMacroStepper');
    assert.ok(terminal, 'Untitled current-line command returns its owned terminal');
    await timeout(() => markerWritten(lineMarker, '2'), 'current line expands in its owned worker');
    assert.equal(fs.readFileSync(lineMarker, 'utf8'), '2');
    assert.equal(fs.existsSync(selectionMarker), false, 'Only the current line was expanded');
    // Launch a second independently owned selection before stopping the first.
    await vscode.window.showTextDocument(untitled, { selection: new vscode.Range(2, 0, 2, selection.length) });
    const second = await launch('racketdap.openMacroStepper');
    assert.ok(second);
    await timeout(() => markerWritten(selectionMarker, '3'), 'selected fragment expands in its owned worker');
    assert.equal(fs.readFileSync(selectionMarker, 'utf8'), '3');
    await closeTerminal();
    assert.equal(ended.has(second), false, 'Stopping one stepper preserves another terminal');
    terminal = second;
    await closeTerminal();
    return ['Macro stepper expands a dirty module with its imports without runtime effects',
      'Macro-stepper line and selection commands accept untitled buffers',
      'Macro-stepper terminals have independent lifetimes and terminate cleanly'];
  } finally {
    try {
      for (const ownedTerminal of active) ownedTerminal.dispose();
      await timeout(() => [...active].every(ownedTerminal => ended.has(ownedTerminal)), 'all owned stepper terminals end');
      subscription.dispose();
      // Restore only this fixture, without closing unrelated harness editors.
      if (sourceDocument && !sourceDocument.isClosed) {
        const restore = new vscode.WorkspaceEdit();
        restore.replace(sourceDocument.uri, new vscode.Range(sourceDocument.positionAt(0), sourceDocument.positionAt(sourceDocument.getText().length)), fs.readFileSync(source, 'utf8'));
        await vscode.workspace.applyEdit(restore);
        await sourceDocument.save();
      }
      if (untitledDocument && !untitledDocument.isClosed) {
        await vscode.window.showTextDocument(untitledDocument);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    } finally {
      await configuration.update('languageServer.enabled', previous, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('racketdap.restartLanguageServer');
      await extension.exports.languageServerReady();
    }
  }
};
