'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { renderWxme } = require('./wxme-render');
const { decodeWxme } = require('./wxme-process');

const viewType = 'racketeer.wxme';
async function fileHash(file, signal) {
  const stream = fs.createReadStream(file, { signal }), hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('File exceeds the viewer limit.');
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally { stream.destroy(); }
}

function registerWxmeViewer(context) {
  const documents = new Set(), pending = new Set();
  const dirty = uri => vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
  const provider = {
    async openCustomDocument(uri, _openContext, token) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to view WXME files.');
      if (uri.scheme !== 'file') throw new Error('The WXME viewer requires a saved local file.');
      if (dirty(uri)) throw new Error('The text editor has unsaved changes. Save or revert them before viewing WXME.');
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const controller = new AbortController();
      let disposed = false, checking = false, checkAgain = false;
      const panels = new Set();
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(uri.fsPath), '*'));
      const document = { uri, stale: false, panels, dispose() {
        disposed = true; controller.abort(new vscode.CancellationError());
        for (const d of subscriptions) d.dispose();
        panels.clear(); documents.delete(document);
      } };
      const markStale = () => {
        if (disposed || document.stale) return;
        document.stale = true;
        for (const panel of panels) panel.webview.html = renderWxme(document.result, path.basename(uri.fsPath), true);
      };
      const checkFile = async () => {
        checkAgain = true;
        if (checking || disposed || document.stale || !document.result) return;
        checking = true;
        try {
          do {
            checkAgain = false;
            if (await fileHash(uri.fsPath, controller.signal) !== document.result.sourceHash) markStale();
          } while (checkAgain && !disposed && !document.stale);
        } catch { if (!controller.signal.aborted) markStale(); }
        finally { checking = false; }
      };
      const changed = changedUri => { if (changedUri.toString() === uri.toString()) void checkFile(); };
      const subscriptions = [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
        vscode.workspace.onDidChangeTextDocument(e => {
          if (e.document.uri.toString() === uri.toString() && e.contentChanges.length) markStale();
        })];
      pending.add(controller);
      const cancellation = token.onCancellationRequested(() => controller.abort(new vscode.CancellationError()));
      try {
        document.result = await decodeWxme(vscode.workspace.getConfiguration('racketdap', uri).get('racketExecutable', 'racket'),
          context.asAbsolutePath('runtime/racketdap/tools/wxme-view.rkt'), uri.fsPath, { signal: controller.signal });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (dirty(uri)) throw new Error('The text editor changed while opening WXME. Save or revert it before reopening.');
        await checkFile();
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) { document.dispose(); throw error;
      } finally { cancellation.dispose(); pending.delete(controller); }
      documents.add(document);
      return document;
    },
    resolveCustomEditor(document, panel, token) {
      if (token.isCancellationRequested) return;
      panel.webview.options = { enableScripts: false, localResourceRoots: [] };
      panel.webview.html = renderWxme(document.result, path.basename(document.uri.fsPath), document.stale);
      document.panels.add(panel);
      const listener = panel.onDidDispose(() => { document.panels.delete(panel); listener.dispose(); });
    }
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, provider, {
    supportsMultipleEditorsPerDocument: true, webviewOptions: { enableFindWidget: true }
  }), { dispose() {
    for (const controller of pending) controller.abort(new vscode.CancellationError());
    for (const document of documents) document.dispose();
  } });
}

module.exports = { registerWxmeViewer, renderWxme };
