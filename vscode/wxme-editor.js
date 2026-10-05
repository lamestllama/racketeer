'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { requestWxme } = require('./wxme-process');
const { WxmeDocument, normalize, hash, limit } = require('./wxme-document');
const { renderWxme } = require('./wxme-viewer');

async function readBytes(file, maximum = limit) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > maximum) throw new Error('WXME file exceeds its size limit.');
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximum) throw new Error('WXME file exceeds its size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

async function currentHash(file) {
  try { return hash(await readBytes(file)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function replaceFile(file, bytes, expected, check) {
  // Follow an existing symlink without replacing the link itself.
  const target = await fs.realpath(file).catch(error => { if (error.code === 'ENOENT') return file; throw error; });
  const mode = await fs.stat(target).then(s => s.mode, error => { if (error.code === 'ENOENT') return 0o666; throw error; });
  const temporary = path.join(path.dirname(target), `.racketeer-wxme-${randomBytes(12).toString('hex')}`);
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (await currentHash(file) !== expected) throw new Error('The file changed outside this editor. Revert to reload it, or use Save As to keep your edits.');
    check();
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

function renderEditor(document) {
  // Reuse the viewer's image validation, escaping and nested-object presentation.
  let html;
  const nonce = randomBytes(16).toString('hex');
  const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const replacements = [];
  const map = (parts, prefix = []) => parts.map((part, index) => {
    const address = [...prefix, index];
    if (part.kind === 'text') {
      const marker = `RACKETEER_${nonce}_${replacements.length}`;
      replacements.push([marker, `<textarea data-field="${address.join('/')}" aria-label="Source text ${address.join('.')}" spellcheck="false" wrap="off">\n${escape(part.text)}</textarea>`]);
      return { kind: 'text', text: marker };
    }
    return part.parts ? { ...part, parts: map(part.parts, address) } : part;
  });
  html = renderWxme({ parts: map(document.parts) }, path.basename(document.uri.fsPath));
  for (const [marker, text] of replacements) html = html.replace(marker, () => text);
  html = html.replace("default-src 'none';", `default-src 'none'; script-src 'nonce-${nonce}';`)
    .replace('Read-only view of the saved file.', 'Edit text around images and inside boxes. Embedded objects stay in place. Save and undo use VS Code.')
    .replace('</style>', `textarea { display: inline-block; vertical-align: middle; box-sizing: content-box; resize: none; overflow: hidden;
font: inherit; line-height: inherit; tab-size: inherit; color: inherit; background: transparent; border: 1px solid transparent; padding: 2px; }
textarea:focus { outline: 1px solid var(--vscode-focusBorder); } </style>`);
  return html.replace('</body>', `<script nonce="${nonce}">
const api = acquireVsCodeApi();
const fields = new Map();
function size(field) { const lines = field.value.split('\\n'); field.rows = Math.max(1, lines.length); field.cols = lines.reduce((n, line) => Math.max(n, [...line.replace(/\\t/g, '        ')].length), 2) + 1; }
for (const field of document.querySelectorAll('textarea')) {
  fields.set(field.dataset.field, field); field.previous = field.value; size(field);
  field.addEventListener('input', () => { api.postMessage({ type: 'edit', id: field.dataset.field, before: field.previous, text: field.value }); field.previous = field.value; size(field); });
  field.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      // VS Code forwards these keys to its command service. Suppress the
      // textarea's local undo history while keeping the event available to it.
      if (key === 'z' || key === 'y' || key === 's') event.preventDefault();
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault(); field.setRangeText('\\t', field.selectionStart, field.selectionEnd, 'end'); field.dispatchEvent(new Event('input'));
    }
  });
}
window.addEventListener('message', ({ data }) => {
  if (data.type !== 'text') return;
  const field = fields.get(data.id); if (!field) return;
  if (field.value !== data.text) field.value = data.text;
  field.previous = data.text; size(field);
});
</script></body>`);
}

function registerWxmeEditor(context) {
  const events = new vscode.EventEmitter(), documents = new Set(), pending = new Set();
  const dirty = uri => vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
  function guard(uri, token) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to edit WXME files.');
    if (uri.scheme !== 'file') throw new Error('WXME editing requires a saved local file.');
    if (dirty(uri)) throw new Error('The text editor has unsaved changes. Save or revert them before editing WXME.');
    if (token.isCancellationRequested) throw new vscode.CancellationError();
  }
  async function encode(document, token) {
    guard(document.uri, token);
    const controller = new AbortController(); pending.add(controller); document.jobs.add(controller);
    const subscription = token.onCancellationRequested(() => controller.abort(new vscode.CancellationError()));
    try {
      return await requestWxme(vscode.workspace.getConfiguration('racketdap', document.uri).get('racketExecutable', 'racket'),
        context.asAbsolutePath('runtime/racketdap/tools/wxme-edit.rkt'), document.uri.fsPath,
        { bytes: document.bytes.toString('base64'), edits: document.edits() }, { signal: controller.signal, outputLimit: 96 * 1024 * 1024 });
    } finally { subscription.dispose(); pending.delete(controller); document.jobs.delete(controller); }
  }
  function broadcast(document, id, except) {
    for (const panel of document.panels) if (panel !== except) void panel.webview.postMessage({ type: 'text', id, text: document.fields.get(id).part.text });
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
      if (document.edits().length) {
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
      const provisional = { uri, bytes, jobs: new Set(), edits: () => [] };
      const result = await encode(provisional, token);
      // A no-edit codec pass proves that this document can be saved on this host.
      const document = new WxmeDocument(uri, bytes, result);
      document.jobs = new Set(); document.panels = new Set();
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
          if (message.type === 'edit') {
            guard(document.uri, token);
            const edit = document.edit(message.id, message.text, message.before);
            if (!edit) return;
            broadcast(document, message.id, panel);
            events.fire({ document, label: 'Edit WXME text',
              undo() { document.edit(message.id, edit.old); broadcast(document, message.id); },
              redo() { document.edit(message.id, edit.text); broadcast(document, message.id); } });
          }
        } catch (error) {
          if (document.fields.has(message.id)) broadcast(document, message.id);
          void vscode.window.showErrorMessage(error.message);
        }
      });
      const closed = panel.onDidDispose(() => { document.panels.delete(panel); messages.dispose(); closed.dispose(); });
    },
    saveCustomDocument: (document, token) => save(document, document.uri, token),
    saveCustomDocumentAs: save,
    async revertCustomDocument(document, token) {
      guard(document.uri, token);
      const revision = document.revision, bytes = await readBytes(document.uri.fsPath);
      const result = await encode({ uri: document.uri, bytes, jobs: document.jobs, edits: () => [] }, token);
      guard(document.uri, token);
      if (document.disposed || revision !== document.revision) throw new Error('The document changed during revert. Try again.');
      Object.assign(document, new WxmeDocument(document.uri, bytes, result));
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
