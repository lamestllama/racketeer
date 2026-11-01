// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }));
const { root, uri, addon } = require('./workspace-index-project');

async function until(check, description, diagnostics = () => '', timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`${description}: ${diagnostics()}`);
}

async function languageServer(t, { workspace = true, folders } = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-imports-')));
  const child = spawn('racket', [path.join(root, 'vscode/language-server.rkt')], {
    cwd: directory, stdio: 'pipe', env: { ...process.env, PLTADDONDIR: addon }
  });
  const closed = once(child, 'close');
  let errors = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  connection.onClose(() => connection.dispose());
  const diagnostics = new Map();
  connection.onNotification('textDocument/publishDiagnostics', params => diagnostics.set(params.uri, params.diagnostics));
  connection.listen();
  t.after(async () => {
    connection.dispose(); child.kill('SIGKILL');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await closed; fs.rmSync(directory, { recursive: true, force: true });
  });
  await connection.sendRequest('initialize', { processId: process.pid, rootPath: workspace ? directory : null, rootUri: workspace ? uri(directory) : null, capabilities: {}, ...(folders ? { workspaceFolders: folders.map(file => ({ uri: uri(file), name: path.basename(file) })) } : {}) });
  await connection.sendNotification('initialized', {});
  const filename = name => path.join(directory, name);
  const address = name => /^(untitled|file):/.test(name) ? name : uri(filename(name));
  const request = (method, name, extra = {}) => connection.sendRequest(`textDocument/${method}`, {
    textDocument: { uri: address(name) }, ...extra
  });
  const open = (name, text, version = 1) => connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: address(name), languageId: 'racket', text, version }
  });
  const change = (name, text, version) => connection.sendNotification('textDocument/didChange', {
    textDocument: { uri: address(name), version }, contentChanges: [{ text }]
  });
  const close = name => connection.sendNotification('textDocument/didClose', { textDocument: { uri: address(name) } });
  const expectDiagnostics = async (name, hasError) => {
    const key = address(name);
    await until(() => diagnostics.has(key) && diagnostics.get(key).some(d => d.severity === 1) === hasError,
      `${name} diagnostics ${hasError ? 'report' : 'clear'} an error`, () => JSON.stringify([...diagnostics]) + errors);
    await request('semanticTokens/full', name);
  };
  return { directory, connection, diagnostics, errors: () => errors, filename, request, open, change, close, expectDiagnostics,
    forget: name => diagnostics.delete(address(name)),
    write: (name, text) => fs.writeFileSync(filename(name), text) };
}

module.exports = { languageServer, until };
