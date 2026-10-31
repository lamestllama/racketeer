'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { edited } = require('./text-edits');

exports.run = async (extension, workspace) => {
  const directory = path.join(workspace.uri.fsPath, 'import rename forms');
  fs.mkdirSync(directory, { recursive: true });
  const texts = {
    'provider.rkt': '#lang racket/base\n(provide square)\n(define (square x) (* x x))\n',
    'composed.rkt': '#lang racket/base\n(require (only-in (prefix-in p: "provider.rkt") p:square))\n(p:square 3)\n',
    'phase.rkt': '#lang racket/base\n(require (for-syntax racket/base (only-in "provider.rkt" square)))\n(define-syntax (answer stx) (datum->syntax stx (square 3)))\n(answer)\n',
    'nested-phase.rkt': '#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (require (prefix-in p: (only-in "provider.rkt" square))) (define value (p:square 3)))\n(define-syntax (answer stx) (datum->syntax stx value))\n(answer)\n',
    'alias.rkt': '#lang racket/base\n(require (prefix-in p: (rename-in "provider.rkt" [square sq])))\n(p:sq 3)\n',
    'relative.rkt': '#lang racket/base\n(module inner racket/base\n  (provide square)\n  (define (square x) (* x x)))\n(require (only-in (submod "." inner) square))\n(square 3)\n'
  };
  const uri = name => vscode.Uri.file(path.join(directory, name));
  for (const [name, text] of Object.entries(texts)) fs.writeFileSync(uri(name).fsPath, text);
  const config = vscode.workspace.getConfiguration('racket-langserver');
  const excluded = config.get('workspaceAnalysis.excludedDirectories');
  const opened = [];
  const rename = (document, position, name) => vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, name);
  async function open(name) {
    const document = await vscode.workspace.openTextDocument(uri(name));
    opened.push(document); await vscode.window.showTextDocument(document);
    await extension.exports.languageServerReady();
    return document;
  }
  try {
    await config.update('workspaceAnalysis.excludedDirectories', [...excluded, 'packages'], vscode.ConfigurationTarget.Workspace);
    const provider = await open('provider.rkt');
    const preview = await rename(provider, new vscode.Position(2, 10), 'squared');
    for (const name of ['provider.rkt', 'composed.rkt', 'phase.rkt', 'nested-phase.rkt', 'alias.rkt']) {
      assert.equal(edited(texts[name], preview.get(uri(name))), texts[name].replaceAll('square', 'squared'), name);
      assert.equal(fs.readFileSync(uri(name).fsPath, 'utf8'), texts[name]);
    }
    assert.equal(preview.get(uri('relative.rkt')).length, 0, 'A same-named submodule binding stays independent');
    assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === uri('composed.rkt').toString()));

    const alias = await open('alias.rkt');
    const local = await rename(alias, new vscode.Position(2, 4), 'area');
    assert.deepEqual(local.entries().map(([key]) => key.toString()), [alias.uri.toString()]);
    assert.equal(await vscode.workspace.applyEdit(local), true);
    assert.equal(alias.getText(), texts['alias.rkt'].replace('[square sq]', '[square area]').replace('p:sq', 'p:area'));
    assert.equal(provider.getText(), texts['provider.rkt']);
    assert.equal(fs.readFileSync(alias.uri.fsPath, 'utf8'), texts['alias.rkt']);

    const relative = await open('relative.rkt');
    const submodule = await rename(relative, new vscode.Position(3, 12), 'squared');
    assert.deepEqual(submodule.entries().map(([key]) => key.toString()), [relative.uri.toString()]);
    assert.equal(edited(texts['relative.rkt'], submodule.get(relative.uri)), texts['relative.rkt'].replaceAll('square', 'squared'));
    assert.equal(fs.readFileSync(relative.uri.fsPath, 'utf8'), texts['relative.rkt']);
  } finally {
    for (const document of opened) {
      if (!document.isClosed) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
    await config.update('workspaceAnalysis.excludedDirectories', excluded, vscode.ConfigurationTarget.Workspace);
  }
  return ['rename previews composed import selectors in unopened consumers',
    'rename previews phase-shifted imported uses',
    'local alias rename preserves prefixes and the exporting module',
    'relative submodule rename preserves independent bindings'];
};
