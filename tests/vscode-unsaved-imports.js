// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');


exports.run = async (extension, workspace) => {
  const directory = path.join(workspace.uri.fsPath, 'unsaved imports');
  fs.mkdirSync(directory, { recursive: true });
  const definitionPath = path.join(directory, 'definition.rkt');
  const consumerPath = path.join(directory, 'consumer.rkt');
  const original = '#lang racket/base\n(provide original)\n(define (original x) (+ x 1))\n';
  const changed = '#lang racket/base\n\n\n(provide shifted)\n(define (shifted x) (+ x 1))\n';
  const consumer = name => `#lang racket/base\n(require "definition.rkt")\n(${name} 3)\n`;
  fs.writeFileSync(definitionPath, original);
  fs.writeFileSync(consumerPath, consumer('original'));
  const dependency = await vscode.workspace.openTextDocument(definitionPath);
  const document = await vscode.workspace.openTextDocument(consumerPath);
  await vscode.window.showTextDocument(document);
  await extension.exports.languageServerReady();
  const position = new vscode.Position(2, 3);
  const analysis = vscode.workspace.getConfiguration('racket-langserver');
  const excluded = analysis.get('workspaceAnalysis.excludedDirectories');
  const hasError = () => vscode.languages.getDiagnostics(document.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error);
  async function replace(doc, text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  try {
    // The integration workspace includes a package app whose dependency is
    // deliberately absent until the package-management checks install it.
    await analysis.update('workspaceAnalysis.excludedDirectories', [...excluded, 'packages'], vscode.ConfigurationTarget.Workspace);
    await replace(document, consumer('shifted'));
    await until(hasError, 'unsaved consumer initially has a missing import');
    await replace(dependency, changed);
    await until(() => !hasError(), 'unsaved dependency clears consumer diagnostics');
    const definitions = await until(async () => {
      const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
      return locations?.find(location => (location.targetUri || location.uri).toString() === dependency.uri.toString()
        && (location.targetSelectionRange || location.range).start.line === 4);
    }, 'definition uses the unsaved source and its current line positions');
    assert.ok(definitions);
    const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', dependency.uri, new vscode.Position(4, 10));
    assert.ok(references.some(location => location.uri.toString() === document.uri.toString() && location.range.start.line === 2));
    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, 'translated');
    assert.ok(rename.get(dependency.uri).length >= 2);
    assert.ok(rename.get(document.uri).length >= 1);
    assert.equal(dependency.isDirty, true);
    assert.equal(document.isDirty, true);
    assert.equal(fs.readFileSync(definitionPath, 'utf8'), original);
    assert.equal(fs.readFileSync(consumerPath, 'utf8'), consumer('original'));
    await replace(dependency, original);
    await until(hasError, 'reverting the dependency refreshes its consumer');
    await replace(dependency, changed);
    await until(() => !hasError(), 'repairing the dependency clears diagnostics again');
  } finally {
    await replace(dependency, original);
    await replace(document, consumer('original'));
    await analysis.update('workspaceAnalysis.excludedDirectories', excluded, vscode.ConfigurationTarget.Workspace);
  }
  return ['unsaved imports refresh diagnostics and definitions',
    'unsaved imports support workspace references and rename previews',
    'dependency revert and repair refresh consumers without saving'];
};
