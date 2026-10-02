'use strict';
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const rpc = require('../vscode/node_modules/vscode-jsonrpc/node');
const root = path.resolve(__dirname, '..');
const definition = '#lang racket/base\n(provide square)\n(define (square x) (* x x))\n';
const uses = '#lang racket/base\n(require "definition.rkt")\n(square 3)\n';
const uri = file => pathToFileURL(file).href;
const addon = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-index-addon-'));
test.after(() => fs.rmSync(addon, { recursive: true, force: true }));

async function project(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-index-')));
  const documents = new Map(), notifications = [];
  let revision = 0, identity = 0, diagnostics = '';
  const child = spawn('racket', [path.join(root, 'vscode/workspace-index-server.rkt')], {
    cwd: directory, stdio: 'pipe', env: { ...process.env, PLTADDONDIR: addon }
  });
  const closed = once(child, 'close');
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { diagnostics += text; });
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  connection.onClose(() => connection.dispose());
  connection.onNotification('status', status => notifications.push(status));
  connection.listen();
  t.after(async () => {
    connection.dispose(); child.kill('SIGKILL');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = name => path.join(directory, name);
  const write = (name, text) => fs.writeFileSync(filename(name), text);
  const open = (name, text, version = 1) => {
    const key = name.startsWith('file:') ? name : uri(filename(name));
    documents.set(key, { uri: key, text, version, identity: ++identity });
    return key;
  };
  const settings = { enabled: true, timeoutSeconds: 20 };
  const snapshot = () => ({ revision: ++revision, roots: [uri(directory)], documents: [...documents.values()], settings });
  const update = () => connection.sendNotification('update', snapshot());
  const references = (key, position = { line: 2, character: 10 }, includeDeclaration = false, token = rpc.CancellationToken.None) => {
    const document = documents.get(key);
    return connection.sendRequest('references', { uri: key, identity: document.identity,
      version: document.version, position, includeDeclaration }, token);
  };
  const rename = (key, newName, position = { line: 2, character: 10 }, token = rpc.CancellationToken.None) => {
    const document = documents.get(key);
    return connection.sendRequest(newName === undefined ? 'prepareRename' : 'rename', {
      uri: key, identity: document.identity, version: document.version, position,
      ...(newName === undefined ? {} : { newName })
    }, token).then(response => response.result);
  };
  write('definition.rkt', definition); write('uses.rkt', uses);
  const origin = open('definition.rkt', definition);
  await connection.sendRequest('initialize', snapshot());
  return { directory, documents, notifications, filename, write, open, origin, update, references, rename, settings,
    diagnostics: () => diagnostics };
}

module.exports = { root, definition, uses, uri, addon, project };
