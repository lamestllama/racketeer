// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');


exports.run = async (extension, workspace) => {
  const analysis = vscode.workspace.getConfiguration('racket-langserver');
  const excluded = analysis.get('workspaceAnalysis.excludedDirectories');
  const opened = [];
  const source = '#lang racket/base\n(define (square x) (* x x))\n(square 3)\n';
  async function replace(document, text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  const error = document => vscode.languages.getDiagnostics(document.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error);
  const definition = (document, position) => vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
  const locationUri = location => (location.targetUri || location.uri).toString();
  try {
    // The package-management fixture is deliberately uninstalled at this stage.
    await analysis.update('workspaceAnalysis.excludedDirectories', [...excluded, 'packages'], vscode.ConfigurationTarget.Workspace);
    const document = await vscode.workspace.openTextDocument({ language: 'racket', content: source });
    opened.push(document);
    await vscode.window.showTextDocument(document);
    await extension.exports.languageServerReady();
    const position = new vscode.Position(2, 3);
    await until(async () => (await definition(document, position))?.some(item => locationUri(item) === document.uri.toString()), 'untitled local definition');
    const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
    assert.ok(completion.items.some(item => (item.label.label || item.label) === 'square'));
    const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, position);
    assert.ok(references.length >= 1);
    assert.ok(references.every(item => item.uri.toString() === document.uri.toString()));
    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, 'squared');
    assert.deepEqual(rename.entries().map(([uri]) => uri.toString()), [document.uri.toString()]);
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    assert.equal(document.getText(), source.replaceAll('square', 'squared'));
    await replace(document, source.replace('(square 3)', '(missing 3)'));
    await until(() => error(document), 'untitled diagnostic');
    await replace(document, source);
    await until(() => !error(document), 'untitled diagnostic repair');
    // A workspace folder is not an import base: only a save location is.
    await replace(document, '#lang racket/base\n(require "dependency.rkt")\n');
    await until(() => vscode.languages.getDiagnostics(document.uri).some(d => /save location/.test(d.message)), 'relative import without a save location is refused');
    await replace(document, source);
    await until(() => !error(document), 'untitled diagnostic repair after the refusal');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await until(() => document.isClosed, 'discarding an untitled document closes its lifetime');
    await until(() => vscode.languages.getDiagnostics(document.uri).length === 0, 'closed untitled diagnostics clear');

    const directory = path.join(workspace.uri.fsPath, 'untitled documents λ');
    fs.mkdirSync(directory, { recursive: true });
    const dependency = vscode.Uri.file(path.join(directory, 'dependency.rkt'));
    fs.writeFileSync(dependency.fsPath, '#lang racket/base\n(provide inc)\n(define (inc x) (+ x 1))\n');
    const savedUri = vscode.Uri.file(path.join(directory, 'saved draft.rkt'));
    const draft = await vscode.workspace.openTextDocument(savedUri.with({ scheme: 'untitled' }));
    opened.push(draft);
    await vscode.languages.setTextDocumentLanguage(draft, 'racket');
    await vscode.window.showTextDocument(draft);
    await replace(draft, '#lang racket/base\n(require "missing.rkt")\n');
    await until(() => error(draft), 'a missing relative import beside the save location');
    await replace(draft, '#lang racket/base\n(require "dependency.rkt")\n(define answer (inc 3))\nanswer\n');
    await until(() => !error(draft), 'relative import uses the associated save location');
    assert.equal(fs.existsSync(savedUri.fsPath), false);
    const use = new vscode.Position(3, 2);
    await until(async () => (await definition(draft, use))?.some(item => locationUri(item) === draft.uri.toString()), 'draft definition keeps its untitled URI');
    assert.equal(await draft.save(), true);
    await until(() => draft.isClosed, 'Save As retires the untitled document');
    const saved = await vscode.workspace.openTextDocument(savedUri);
    opened.push(saved);
    await vscode.window.showTextDocument(saved);
    await until(async () => (await definition(saved, use))?.some(item => locationUri(item) === savedUri.toString()), 'saved definition uses the file URI');
    const savedReferences = await vscode.commands.executeCommand('vscode.executeReferenceProvider', savedUri, use);
    assert.ok(savedReferences.length >= 1);
    assert.ok(savedReferences.every(item => item.uri.toString() === savedUri.toString()));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await until(() => saved.isClosed, 'saved document closes');
    const reopened = await vscode.workspace.openTextDocument(savedUri);
    opened.push(reopened);
    await vscode.window.showTextDocument(reopened);
    await until(async () => (await definition(reopened, use))?.some(item => locationUri(item) === savedUri.toString()), 'reopened document has current definitions');
    assert.equal(fs.readFileSync(savedUri.fsPath, 'utf8'), reopened.getText());
  } finally {
    for (const document of opened) {
      if (!document.isClosed) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
    await analysis.update('workspaceAnalysis.excludedDirectories', excluded, vscode.ConfigurationTarget.Workspace);
  }
  return ['untitled completion, definitions, references and rename',
    'untitled diagnostics repair and close cleanup',
    'untitled relative imports without a save location are refused',
    'untitled relative imports use the associated save location',
    'Save As and reopen replace untitled locations with file locations'];
};
