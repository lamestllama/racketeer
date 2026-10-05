'use strict';
const vscode = require('vscode');
const path = require('node:path');

function targetFor(uri) {
  if (uri.scheme !== 'file') throw new Error('Open and save a Racket source file first.');
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return {
    uri, folder, program: uri.fsPath,
    cwd: folder?.uri.fsPath || path.dirname(uri.fsPath),
    racketExecutable: vscode.workspace.getConfiguration('racketdap', uri).get('racketExecutable', 'racket')
  };
}

async function saveDocument(document) {
  if (document.isDirty && !await document.save()) throw new Error('The file could not be saved.');
  return targetFor(document.uri);
}

async function activeTarget({ allowWxme = false } = {}) {
  const tab = vscode.window.tabGroups?.activeTabGroup.activeTab;
  if (vscode.TabInputCustom && tab?.input instanceof vscode.TabInputCustom) {
    const wxmeTab = t => t.input instanceof vscode.TabInputCustom && ['racketeer.wxmeEditor', 'racketeer.wxme'].includes(t.input.viewType);
    if (!allowWxme || !wxmeTab(tab)) throw new Error('Open a Racket text editor for this command.');
    const target = targetFor(tab.input.uri);
    const dirtyViews = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .some(t => wxmeTab(t) && t.input.uri.toString() === target.uri.toString() && t.isDirty);
    if (vscode.workspace.textDocuments.some(d => d.uri.toString() === target.uri.toString() && d.isDirty))
      throw new Error('The text editor has unsaved changes. Save or revert them before running WXME.');
    if (tab.isDirty || dirtyViews()) {
      const saved = await vscode.workspace.save(target.uri);
      if (!saved || saved.toString() !== target.uri.toString() || tab.isDirty || dirtyViews()) throw new Error('The WXME document could not be saved.');
    }
    return { ...target, format: 'wxme' };
  }
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== 'racket') throw new Error('Open a Racket source file first.');
  return saveDocument(document);
}

function launchConfiguration(target, options = {}) {
  return {
    type: 'racketdap', request: 'launch', name: `Racket: ${path.basename(target.program)}`,
    program: target.program, cwd: target.cwd, sourceRoots: [target.cwd],
    racketExecutable: target.racketExecutable, interactive: false, ...options
  };
}

module.exports = { targetFor, saveDocument, activeTarget, launchConfiguration };
