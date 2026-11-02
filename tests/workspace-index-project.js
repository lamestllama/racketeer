// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { edited } = require('./text-edits');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }));
const root = path.resolve(__dirname, '..');
const definition = '#lang racket/base\n(provide square)\n(define (square x) (* x x))\n';
const uses = '#lang racket/base\n(require "definition.rkt")\n(square 3)\n';
const uri = file => pathToFileURL(file).href;
const addon = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-index-addon-'));
test.after(() => fs.rmSync(addon, { recursive: true, force: true }));


// `shared` gives another server's `directory`, `documents` and `settings`, for a
// server that starts with nothing over the same files and buffers.
async function project(t, env = {}, shared) {
  const directory = shared ? shared.directory : fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-index-')));
  const documents = new Map(), notifications = [], progress = [];
  let identity = 0, diagnostics = '';
  const child = spawn('racket', [path.join(root, 'vscode/workspace-index-server.rkt')], {
    cwd: directory, stdio: 'pipe', env: { ...process.env, PLTADDONDIR: addon, ...env }
  });
  const closed = once(child, 'close');
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { diagnostics += text; });
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  connection.onClose(() => connection.dispose());
  connection.onNotification('racketeer/indexStatus', status => notifications.push(status));
  connection.onRequest('window/workDoneProgress/create', () => null);
  connection.onUnhandledProgress(({ value }) => progress.push(value));
  connection.listen();
  t.after(async () => {
    connection.dispose(); child.kill('SIGKILL');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await closed;
    if (!shared) fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = name => path.join(directory, name);
  const write = (name, text) => fs.writeFileSync(filename(name), text);
  const open = (name, text, version = 1) => {
    const key = /^(file|untitled):/.test(name) ? name : uri(filename(name));
    documents.set(key, { uri: key, text, version, identity: ++identity });
    return key;
  };
  const settings = { enabled: true, timeoutSeconds: 20, ...shared?.settings };
  const roots = [uri(directory)];
  connection.onRequest('workspace/configuration', ({ items }) => items.map(() => settings));
  connection.onRequest('client/registerCapability', () => null);
  const notify = (method, params) => connection.sendNotification(method, params);
  const didOpen = document => notify('textDocument/didOpen', { textDocument: { uri: document.uri,
    languageId: 'racket', version: document.version, text: document.text } });
  const didClose = key => notify('textDocument/didClose', { textDocument: { uri: key } });
  // What a test changed reaches the server as an editor would send it. Without
  // `documentsOnly`, the test has also changed something on disk.
  const held = new Map();
  let configuration = JSON.stringify(settings);
  const update = async (documentsOnly = false) => {
    const sent = [];
    for (const [key, document] of held) {
      if (documents.get(key)?.identity !== document.identity) { sent.push(didClose(key)); held.delete(key); }
    }
    for (const [key, document] of documents) {
      const previous = held.get(key);
      if (!previous) sent.push(didOpen(document));
      else if (previous.version !== document.version || previous.text !== document.text) {
        sent.push(notify('textDocument/didChange', { textDocument: { uri: key, version: document.version },
          contentChanges: [{ text: document.text }] }));
      }
      held.set(key, { ...document });
    }
    if (JSON.stringify(settings) !== configuration) {
      configuration = JSON.stringify(settings);
      sent.push(notify('workspace/didChangeConfiguration', { settings: null }));
    }
    if (!documentsOnly) {
      sent.push(notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(filename('changed-on-disk')), type: 2 }] }));
    } else if (!sent.length) {
      // An unchanged document reopening is what asks for the disk to be verified.
      const [document] = documents.values();
      sent.push(didClose(document.uri), didOpen(document));
    }
    await Promise.all(sent);
  };
  const references = (key, position = { line: 2, character: 10 }, includeDeclaration = false, token = rpc.CancellationToken.None) =>
    connection.sendRequest('textDocument/references', { textDocument: { uri: key }, position,
      context: { includeDeclaration } }, token);
  const rename = (key, newName, position = { line: 2, character: 10 }, token = rpc.CancellationToken.None) =>
    connection.sendRequest(newName === undefined ? 'textDocument/prepareRename' : 'textDocument/rename', {
      textDocument: { uri: key }, position, ...(newName === undefined ? {} : { newName })
    }, token).then(result => !result.documentChanges ? result : { ...result,
      changes: Object.fromEntries(result.documentChanges.map(({ textDocument, edits }) => [textDocument.uri, edits])) });
  if (shared) for (const [key, document] of shared.documents) documents.set(key, { ...document });
  else { write('definition.rkt', definition); write('uses.rkt', uses); open('definition.rkt', definition); }
  const origin = uri(filename('definition.rkt'));
  await connection.sendRequest('initialize', { processId: null, rootUri: null, workspaceFolders: roots.map(root => ({ uri: root, name: root })),
    capabilities: { window: { workDoneProgress: true }, textDocument: { rename: { prepareSupport: true } },
      workspace: { configuration: true, workspaceEdit: { documentChanges: true },
        didChangeWatchedFiles: { dynamicRegistration: true } },
      experimental: { racketeer: { indexStatus: true, sourceReferences: true } } } });
  await notify('initialized', {});
  await update();
  return { child, directory, documents, notifications, progress, filename, write, open, origin, update, references, rename, settings, roots,
    request: (method, params) => connection.sendRequest(method, params),
    diskChange: name => notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(filename(name)), type: 2 }] }),
    diagnostics: () => diagnostics };
}

// The server with no JSON-RPC library in between, for frames a library would
// refuse to send or to match to a request.
function rawServer(t, env = {}) {
  const child = spawn('racket', [path.join(root, 'vscode/workspace-index-server.rkt')], {
    stdio: 'pipe', env: { ...process.env, PLTADDONDIR: addon, ...env }
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const received = [], waiting = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const start = end + 4, length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end))[1]);
      if (buffer.length < start + length) return;
      const message = JSON.parse(buffer.subarray(start, start + length));
      buffer = buffer.subarray(start + length);
      if (waiting.length) waiting.shift()(message); else received.push(message);
    }
  });
  const writeFrame = text => child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  return { child, closed, writeFrame, send: message => writeFrame(JSON.stringify({ jsonrpc: '2.0', ...message })),
    next: () => received.length ? Promise.resolve(received.shift()) : new Promise(resolve => waiting.push(resolve)) };
}

module.exports = { root, definition, uses, uri, addon, edited, project, rawServer };
