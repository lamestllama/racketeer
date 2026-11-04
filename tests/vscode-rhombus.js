// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');


// Run only in the harness's private Rhombus package environment. This exercises
// the installed extension and real racket-langserver, including unsaved edits.
exports.run = async (extension, workspace) => {
  const directory = path.join(workspace.uri.fsPath, 'rhombus checks');
  fs.mkdirSync(directory, { recursive: true });
  const program = path.join(directory, 'editing λ.rhm');
  const source = [
    '#lang rhombus',
    'fun square(x):',
    '  x * x',
    'def answer = square(7)',
    'println(answer)',
    'def flag = #true',
    'def fraction = 2/7',
    'def bytes = #"plain bytes"',
    'def text = "// is text"',
    '/* outside /* inside */ still comment */',
    '// a line comment', ''
  ].join('\n');
  fs.writeFileSync(program, source);
  const document = await vscode.workspace.openTextDocument(program);
  assert.equal(document.languageId, 'rhombus', '.rhm files select the installed Rhombus language');
  const editor = await vscode.window.showTextDocument(document);
  assert.equal(editor.options.tabSize, 2);
  assert.equal(editor.options.insertSpaces, true);
  await extension.exports.languageServerReady();
  const call = new vscode.Position(3, 15);
  const definition = async () => {
    const results = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, call);
    return results?.find(item => (item.targetUri || item.uri).fsPath === program &&
      (item.targetSelectionRange || item.range).start.line === 1);
  };
  assert.ok(await until(definition, 'Rhombus local-function definition'));
  const hovers = await until(async () => {
    const results = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, call);
    return results?.some(item => item.contents.some(content => /square/.test(content.value || content))) && results;
  }, 'Rhombus source hover');
  assert.ok(hovers.length, 'Real language-server hover includes the local function source');
  assert.equal(vscode.languages.getDiagnostics(document.uri).filter(item => item.severity === vscode.DiagnosticSeverity.Error).length, 0);

  const syntax = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', document.uri);
  for (const [text, scope] of [['#true', 'constant.language.boolean.rhombus'], ['2/7', 'constant.numeric.rhombus'],
    ['plain bytes', 'string.quoted.double.byte.rhombus'], ['// is text', 'string.quoted.double.rhombus'],
    ['still comment', 'comment.block.rhombus']]) {
    assert.ok(syntax.some(token => token.c.includes(text) && token.t.includes(scope)), `${text} has installed ${scope} syntax coloring`);
  }
  // Formatting with the shared server's S-expression default must never change
  // shrubbery. Keep testing this even if other language-server defaults change.
  const options = { tabSize: 2, insertSpaces: true };
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
  for (const [command, args] of [
    ['vscode.executeFormatDocumentProvider', [document.uri, options]],
    ['vscode.executeFormatRangeProvider', [document.uri, whole, options]],
    ['vscode.executeFormatOnTypeProvider', [document.uri, new vscode.Position(2, 7), '\n', options]]
  ]) {
    assert.equal((await vscode.commands.executeCommand(command, ...args))?.length || 0, 0, `${command} preserves Rhombus source`);
  }
  assert.equal(document.getText(), source);

  async function replace(text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  try {
    await replace(source + 'missing_rhombus_binding\n');
    const diagnostic = await until(() => vscode.languages.getDiagnostics(document.uri)
      .find(item => item.severity === vscode.DiagnosticSeverity.Error && /missing_rhombus_binding/.test(item.message)),
    'Rhombus diagnostic after unsaved edit');
    assert.equal(diagnostic.range.start.line, 11);
    await replace(source);
    await until(() => !vscode.languages.getDiagnostics(document.uri).some(item => /missing_rhombus_binding/.test(item.message)),
      'Rhombus diagnostic cleared after unsaved repair');
    await document.save();

    editor.selection = new vscode.Selection(4, 0, 4, document.lineAt(4).text.length);
    await vscode.commands.executeCommand('editor.action.commentLine');
    assert.match(document.lineAt(4).text, /^\s*\/\/\s*println\(answer\)/, 'Toggle comment uses shrubbery line comments');
    await vscode.commands.executeCommand('editor.action.commentLine');
    assert.equal(document.getText(), source, 'Toggle comment round trip preserves source');
    await document.save();

    await vscode.commands.executeCommand('racketdap.restartLanguageServer');
    assert.ok(await until(definition, 'Rhombus definition after language-server restart'));
    const settings = vscode.workspace.getConfiguration('racketdap');
    const previous = settings.inspect('languageServer.enabled').workspaceValue;
    try {
      await settings.update('languageServer.enabled', false, vscode.ConfigurationTarget.Workspace);
      await extension.exports.languageServerReady();
      assert.equal((await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, call)).length, 0);
      await settings.update('languageServer.enabled', true, vscode.ConfigurationTarget.Workspace);
      await extension.exports.languageServerReady();
      assert.ok(await until(definition, 'Rhombus definition after language-server re-enable'));
    } finally {
      await settings.update('languageServer.enabled', previous, vscode.ConfigurationTarget.Workspace);
      await extension.exports.languageServerReady();
    }
  } finally {
    await replace(source);
    await document.save();
  }
  return ['Rhombus .rhm association and indentation defaults', 'Rhombus real language-server definition',
    'Rhombus real language-server source hover', 'Rhombus installed TextMate highlighting',
    'Rhombus document/range/on-type formatting protection', 'Rhombus unsaved diagnostic and repair',
    'Rhombus line-comment round trip', 'Rhombus language-server restart', 'Rhombus language-server disable/enable'];
};
