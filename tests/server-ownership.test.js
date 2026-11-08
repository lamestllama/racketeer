// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { removeQuietly } = require('./cleanup');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function descendants(pid) {
  const children = new Map();
  const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid=']);
  for (const line of stdout.trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  for (let queue = [pid]; queue.length;) for (const child of children.get(queue.shift()) || []) { found.push(child); queue.push(child); }
  return found;
}

// Start each real server in turn, within the memory budget. Kill the extension
// host without warning; the index is analysing compile-time code with a child
// that ignores breaks.
for (const kind of ['language', 'workspace-index']) test(`the ${kind} server ends with an extension host that is killed`, {
  skip: process.platform === 'win32' && 'POSIX process listing; Windows uses a job object'
}, async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer servers ')));
  const pids = path.join(directory, 'pids');
  let tree = [];
  t.after(() => {
    for (const pid of tree) if (alive(pid)) process.kill(pid, 'SIGKILL');
    removeQuietly(directory);
  });
  fs.writeFileSync(path.join(directory, 'busy.rkt'), `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (define racket (path->string (find-executable-path (find-system-path 'exec-file))))
  ;; Analysis workers have no file-stream ports, so the child gets pipes.
  (subprocess #f #f #f racket "-e"
    (format "~s" \`(begin (break-enabled #f)
      (with-output-to-file ,${JSON.stringify(pids)} #:exists 'truncate (lambda () (write 'started)))
      (sync never-evt))))
  (sync never-evt))
`);
  const host = spawn(process.execPath, ['-e', `
    const { createLanguageProcess, ownedArgs } = require(${JSON.stringify(path.join(root, 'vscode/language-process.js'))});
    const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [${JSON.stringify(path.join(root, 'vscode'))}] }));
    const env = { ...process.env, PLTADDONDIR: ${JSON.stringify(path.join(directory, 'addon'))} };
    const context = { asAbsolutePath: file => ${JSON.stringify(path.join(root, 'vscode'))} + '/' + file };
    const server = file => createLanguageProcess('racket', ownedArgs(context, [context.asAbsolutePath(file)]),
      { cwd: ${JSON.stringify(directory)}, env }, { owned: true });
    (async () => {
      const index = await server(${JSON.stringify(kind + '-server.rkt')}).start();
      const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(index.stdout), new rpc.StreamMessageWriter(index.stdin));
      connection.onRequest('workspace/configuration', () => [{ enabled: true, timeoutSeconds: 120 }]);
      connection.listen();
      await connection.sendRequest('initialize', { processId: null, rootUri: null, rootPath: null,
        workspaceFolders: [{ uri: ${JSON.stringify(pathToFileURL(directory).href)}, name: 'servers' }],
        capabilities: { workspace: { configuration: true } } });
      await connection.sendNotification('initialized', {});
      if (${JSON.stringify(kind)} === 'language') { require('node:fs').writeSync(1, JSON.stringify([index.pid]) + '\\n'); return; }
      // A pass runs for a request, and this one stays waiting for it.
      const busy = ${JSON.stringify(pathToFileURL(path.join(directory, 'busy.rkt')).href)};
      await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: busy, languageId: 'racket', version: 1,
        text: require('node:fs').readFileSync(${JSON.stringify(path.join(directory, 'busy.rkt'))}, 'utf8') } });
      void connection.sendRequest('textDocument/references', { textDocument: { uri: busy },
        position: { line: 0, character: 0 }, context: { includeDeclaration: false } }).catch(() => {});
      require('node:fs').writeSync(1, JSON.stringify([index.pid]) + '\\n');
    })();`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const servers = await new Promise((resolve, reject) => {
    host.stdout.once('data', data => resolve(JSON.parse(data)));
    host.once('exit', code => reject(new Error(`Host exited with ${code}`)));
  });
  // A fresh addon directory compiles the server first.
  if (kind === 'workspace-index') await until(() => fs.existsSync(pids), 'The index started analysing the busy module');
  for (const pid of servers) tree.push(pid, ...await descendants(pid));
  assert.ok(tree.length >= 3, `The server and its guards are running: ${tree}`);
  if (kind === 'workspace-index') assert.ok(tree.length >= 5, `The analysis worker and compile-time child are running: ${tree}`);
  const exited = new Promise(resolve => host.once('exit', resolve));
  host.kill('SIGKILL');
  await exited;
  await until(() => !(tree.some(alive)));
  assert.deepEqual(tree.filter(alive), [], 'No server process outlives the extension host');
});
