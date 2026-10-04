'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes, createHash } = require('node:crypto');
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
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function renderWxme(result, name, stale = false) {
  const nonce = randomBytes(16).toString('hex');
  const renderParts = (parts, depth = 0) => parts.map(part => {
    if (part.kind === 'text') return escape(part.text);
    if (part.kind === 'unsupported') return `<span class="unsupported">[${escape(part.label)}]</span>`;
    if (part.kind === 'editor' || part.kind === 'comment') {
      if (depth >= 32) throw new Error('Nested editors exceed the viewer limit (32 levels).');
      const label = part.kind === 'comment' ? 'Comment box' : 'Nested editor';
      return `<span class="embedded" role="group" aria-label="${label}"><span class="box-label" aria-hidden="true">${label}</span><span>${renderParts(part.parts, depth + 1)}</span></span>`;
    }
    if (part.kind !== 'image' || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data) ||
        !Buffer.from(part.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        ![part.width, part.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) {
      throw new Error('Invalid embedded image.');
    }
    return `<img src="data:image/png;base64,${part.data}" width="${part.width}" height="${part.height}" alt="Embedded image (${part.width} × ${part.height})">`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escape(name)}</title>
<style nonce="${nonce}">
body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 16px; }
p { font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); }
pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre; tab-size: 8; line-height: 1.5; }
img { vertical-align: middle; } .unsupported { color: var(--vscode-editorWarning-foreground); border: 1px solid; padding: 2px; }
.embedded { display: inline-block; vertical-align: middle; border: 1px solid var(--vscode-editorWidget-border, currentColor); padding: 4px 8px; margin: 2px; }
.box-label { display: block; font-family: var(--vscode-font-family); font-size: 0.85em; color: var(--vscode-descriptionForeground); }
</style></head><body><p role="status">${stale ? 'The file has changed. Close and reopen this view to refresh.' : 'Read-only view of the saved file.'}</p><pre aria-label="WXME source"><span>${renderParts(result.parts)}</span></pre></body></html>`;
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
