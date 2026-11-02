// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { requestWxme } = require('./wxme-process');
const { debuggerArgs } = require('./language-process');
const { WxmeDocument, normalize, hash, limit } = require('./wxme-document');
const { renderEditor } = require('./wxme-editor-view');
const { readBytes, currentHash, replaceFile } = require('./wxme-storage');


function registerWxmeEditor(context) {
  const events = new vscode.EventEmitter(), documents = new Set(), pending = new Set();
  const dirty = uri => vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
  function guard(uri, token) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to edit WXME files.');
    if (uri.scheme !== 'file') throw new Error('WXME editing requires a saved local file.');
    if (dirty(uri)) throw new Error('The text editor has unsaved changes. Save or revert them before editing WXME.');
    if (token.isCancellationRequested) throw new vscode.CancellationError();
  }
  async function encode(document, token, request = document.request()) {
    guard(document.uri, token);
    const controller = new AbortController(); pending.add(controller); document.jobs.add(controller);
    const subscription = token.onCancellationRequested(() => controller.abort(new vscode.CancellationError()));
    try {
      const result = await requestWxme(vscode.workspace.getConfiguration('racketdap', document.uri).get('racketExecutable', 'racket'),
        debuggerArgs(context, 'tools/wxme-edit.rkt'), document.uri.fsPath,
        request, { signal: controller.signal, outputLimit: 96 * 1024 * 1024 });
      if (result.version !== 1) throw new Error('Unsupported WXME codec response version.');
      return result;
    } finally { subscription.dispose(); pending.delete(controller); document.jobs.delete(controller); }
  }
  function broadcast(document, id, except) {
    for (const panel of document.panels) if (panel !== except) void panel.webview.postMessage({ type: 'text', id, text: document.fields.get(id).part.text });
  }
  function publish(document, change, except) {
    if (change.structural) {
      document.generation = randomBytes(16).toString('hex');
      for (const panel of document.panels) panel.webview.html = renderEditor(document);
    } else broadcast(document, change.id, except);
  }
  function record(document, change, panel) {
    if (!change) return;
    publish(document, change, panel);
    events.fire({ document, label: change.label,
      undo() { document.applyState(change.before); publish(document, change); },
      redo() { document.applyState(change.after); publish(document, change); } });
  }
  async function save(document, destination, token) {
    const previous = document.saving;
    let finished;
    const completion = new Promise(resolve => { finished = resolve; });
    document.saving = completion;
    try {
      if (previous) await previous;
      guard(destination, token);
      if (document.disposed) throw new vscode.CancellationError();
      const same = destination.toString() === document.uri.toString();
      const expected = same ? document.diskHash : await currentHash(destination.fsPath);
      const revision = document.revision;
      let bytes = document.bytes;
      if (document.changed()) {
        const result = await encode(document, token);
        if (revision !== document.revision) throw new Error('The document changed during saving. Save again to include the latest edit.');
        if (!isDeepStrictEqual(normalize(result.parts), document.parts)) throw new Error('The codec did not preserve the edited content. The file has not been changed.');
        bytes = Buffer.from(result.bytes, 'base64');
        if (bytes.length > limit) throw new Error('Saved WXME exceeds 32 MiB.');
      }
      const check = () => {
        guard(document.uri, token); guard(destination, token);
        if (document.disposed) throw new vscode.CancellationError();
        if (revision !== document.revision) throw new Error('The document changed during saving. Save again to include the latest edit.');
      };
      await replaceFile(destination.fsPath, bytes, expected, check);
      if (same) document.diskHash = hash(bytes);
    } finally { finished(); if (document.saving === completion) document.saving = undefined; }
  }
  const provider = {
    onDidChangeCustomDocument: events.event,
    async openCustomDocument(uri, openContext, token) {
      guard(uri, token);
      let backup;
      if (openContext.backupId) backup = JSON.parse((await readBytes(vscode.Uri.parse(openContext.backupId).fsPath, 96 * 1024 * 1024)).toString('utf8'));
      const bytes = backup ? Buffer.from(backup.bytes, 'base64') : await readBytes(uri.fsPath);
      const provisional = { uri, jobs: new Set() };
      const result = await encode(provisional, token, { version: 1, bytes: bytes.toString('base64') });
      // A no-edit codec pass proves that this document can be saved on this host.
      const document = new WxmeDocument(uri, bytes, result);
      document.jobs = new Set(); document.panels = new Set(); document.generation = randomBytes(16).toString('hex');
      document.dispose = () => { document.disposed = true; for (const job of document.jobs) job.abort(new vscode.CancellationError()); document.panels.clear(); documents.delete(document); };
      if (backup) document.restore(backup);
      guard(uri, token);
      documents.add(document);
      return document;
    },
    resolveCustomEditor(document, panel, token) {
      if (token.isCancellationRequested) return;
      panel.webview.options = { enableScripts: true, localResourceRoots: [] };
      panel.webview.html = renderEditor(document); document.panels.add(panel);
      const messages = panel.webview.onDidReceiveMessage(async message => {
        try {
          if (document.disposed) return;
          if (!message || message.generation !== document.generation) throw new Error('The document structure changed. Try the action again.');
          guard(document.uri, token);
          if (message.type === 'edit') {
            const edit = document.edit(message.id, message.text, message.before);
            record(document, edit, panel);
          } else if (message.type === 'insert') {
            if (document.fields.get(message.id)?.part.text !== message.before) throw new Error('The selected text changed. Select it again.');
            let image;
            if (message.kind === 'image') {
              const revision = document.revision;
              const selected = await vscode.window.showOpenDialog({ title: 'Insert PNG image', canSelectMany: false, filters: { 'PNG images': ['png'] } });
              if (!selected?.length) return;
              if (selected[0].scheme !== 'file') throw new Error('Choose a local PNG image.');
              const bytes = await readBytes(selected[0].fsPath, 8 * 1024 * 1024);
              const imported = await encode(document, token, { version: 1, image: bytes.toString('base64') });
              if (document.disposed || revision !== document.revision) throw new Error('The document changed while choosing the image. Try again.');
              image = imported.parts[0];
            }
            guard(document.uri, token);
            const change = document.insert(message.id, message.start, message.end, message.kind, image);
            document.focus = change.focus;
            record(document, change);
          } else if (message.type === 'remove') {
            document.focus = undefined;
            record(document, document.remove(message.id));
          } else if (message.type === 'mode') {
            document.focus = undefined;
            record(document, document.changeMode(message.id, message.value));
          }
        } catch (error) {
          if (document.fields.has(message?.id)) broadcast(document, message.id);
          void vscode.window.showErrorMessage(error.message);
        }
      });
      let visible = panel.visible;
      const visibility = panel.onDidChangeViewState(() => {
        // Hidden webviews can be recreated from their initial HTML. The
        // document model remains authoritative across editor tab changes.
        if (panel.visible && !visible && !document.disposed) panel.webview.html = renderEditor(document);
        visible = panel.visible;
      });
      const closed = panel.onDidDispose(() => { document.panels.delete(panel); messages.dispose(); visibility.dispose(); closed.dispose(); });
    },
    saveCustomDocument: (document, token) => save(document, document.uri, token),
    saveCustomDocumentAs: save,
    async revertCustomDocument(document, token) {
      guard(document.uri, token);
      const revision = document.revision, bytes = await readBytes(document.uri.fsPath);
      const result = await encode({ uri: document.uri, jobs: document.jobs }, token, { version: 1, bytes: bytes.toString('base64') });
      guard(document.uri, token);
      if (document.disposed || revision !== document.revision) throw new Error('The document changed during revert. Try again.');
      Object.assign(document, new WxmeDocument(document.uri, bytes, result));
      document.generation = randomBytes(16).toString('hex'); document.focus = undefined;
      for (const panel of document.panels) panel.webview.html = renderEditor(document);
    },
    async backupCustomDocument(document, backupContext, token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      await vscode.workspace.fs.writeFile(backupContext.destination, document.backup());
      return { id: backupContext.destination.toString(), delete: () => { void vscode.workspace.fs.delete(backupContext.destination).then(undefined, () => {}); } };
    }
  };
  context.subscriptions.push(events, vscode.window.registerCustomEditorProvider('racketeer.wxmeEditor', provider, {
    supportsMultipleEditorsPerDocument: true
  }), { dispose() { for (const job of pending) job.abort(new vscode.CancellationError()); for (const document of documents) document.dispose(); } });
  return provider;
}

module.exports = { registerWxmeEditor, renderEditor, replaceFile };
