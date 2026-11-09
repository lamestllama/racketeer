// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Captures expansion targets and computes snapshot identities.
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
function macroTarget(editor, wholeFile) {
  const document = editor?.document;
  if (!document || document.languageId !== 'racket') throw new Error('Open a Racket editor first.');
  if (!['file', 'untitled'].includes(document.uri.scheme)) {
    throw new Error('Open a local or untitled Racket document to step through its macros.');
  }
  const buffer = document.getText();
  const range = wholeFile ? undefined : editor.selection.isEmpty
    ? document.lineAt(editor.selection.active.line).range : editor.selection;
  const start = range ? document.offsetAt(range.start) : 0;
  const end = range ? document.offsetAt(range.end) : buffer.length;
  const text = buffer.slice(start, end);
  if (!text.trim()) throw new Error('The current line, selection, or file contains no Racket forms.');
  const file = document.uri.scheme === 'file';
  const folder = vscode.workspace.getWorkspaceFolder(document.uri) ||
    (!file ? vscode.workspace.workspaceFolders?.[0] : undefined);
  const settings = vscode.workspace.getConfiguration('racketdap', document.uri);
  const cwd = folder?.uri.fsPath || (file ? path.dirname(document.uri.fsPath) : os.homedir());
  const shared = {
    cwd, workspace: folder?.uri.fsPath || false,
    source: file ? document.uri.fsPath : document.uri.toString(), sourceIsFile: file,
    // Relative module imports belong to the source directory, independent
    // of the process cwd. Untitled sources use their workspace.
    directory: file ? path.dirname(document.uri.fsPath) : folder?.uri.fsPath || os.homedir()
  };
  return {
    executable: settings.get('racketExecutable', 'racket'), range,
    module: { ...shared, mode: 'module', text: buffer, prefix: '' },
    fragment: { ...shared, mode: 'fragment', text, prefix: buffer.slice(0, start) }
  };
}

module.exports = { macroTarget, hash };
