'use strict';
const vscode = require('vscode');
const { createHash } = require('node:crypto');

function registerErrorSources(context) {
  const snapshots = new Map();
  let disposed = false;
  const normalize = text => text.replace(/\r\n/g, '\n');
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('racketeer-error', {
    provideTextDocumentContent(uri) {
      const snapshot = snapshots.get(uri.toString());
      if (snapshot === undefined) throw new Error('This error source has been released.');
      return snapshot;
    }
  }), vscode.workspace.onDidCloseTextDocument(document => { snapshots.delete(document.uri.toString()); }),
  new vscode.Disposable(() => { disposed = true; snapshots.clear(); }));
  return {
    async open(source, location) {
      if (disposed) return;
      const selection = new vscode.Range(location.line - 1, location.column - 1, location.endLine - 1, location.endColumn - 1);
      let document;
      if (source.path) {
        try {
          const uri = vscode.Uri.file(source.path);
          await vscode.workspace.fs.stat(uri);
          const current = await vscode.workspace.openTextDocument(uri);
          if (normalize(current.getText()) === source.content) document = current;
        } catch (_) { /* Deleted source remains available through its captured text. */ }
      }
      if (document && !disposed) {
        const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
        if (normalize(document.getText()) === source.content) {
          editor.selection = new vscode.Selection(selection.start, selection.end);
          editor.revealRange(selection); return document.uri;
        }
      }
      if (disposed) return;
      const id = createHash('sha256').update(source.path || '').update('\0').update(source.content).digest('hex');
      const uri = vscode.Uri.from({ scheme: 'racketeer-error', authority: id,
        path: `/Captured ${source.name.replace(/[\/\\]/g, '_')}${source.name.endsWith('.rkt') ? '' : '.rkt'}` });
      snapshots.set(uri.toString(), source.content);
      try {
        document = await vscode.workspace.openTextDocument(uri);
        if (disposed) return;
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection, preview: false });
        return uri;
      } catch (error) { snapshots.delete(uri.toString()); throw error; }
    }
  };
}
module.exports = { registerErrorSources };
