'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
function descendants(pid) {
  const children = new Map();
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  for (let queue = [pid]; queue.length;) for (const child of children.get(queue.shift()) || []) { found.push(child); queue.push(child); }
  return found;
}

// The extension host starts both servers as the extension does and is then
// killed without warning, while the index analyses a module whose
// compile-time code holds a child that ignores breaks.
test('the language and workspace index servers end with an extension host that is killed', {
  skip: process.platform === 'win32' && 'POSIX process listing; Windows uses a job object', timeout: 300000
}, async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer servers ')));
  const pids = path.join(directory, 'pids');
  let tree = [];
  t.after(() => {
    for (const pid of tree) if (alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
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
      { cwd: ${JSON.stringify(directory)}, env });
    (async () => {
      const language = await server('language-server.rkt').start();
      const index = await server('workspace-index-server.rkt').start();
      const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(index.stdout), new rpc.StreamMessageWriter(index.stdin));
      connection.listen();
      await connection.sendRequest('initialize', { revision: 1, roots: [${JSON.stringify(pathToFileURL(directory).href)}],
        documents: [], settings: { enabled: true, timeoutSeconds: 90 } });
      console.log(JSON.stringify([language.pid, index.pid]));
    })();`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const servers = await new Promise((resolve, reject) => {
    host.stdout.once('data', data => resolve(JSON.parse(data)));
    host.once('exit', code => reject(new Error(`Host exited with ${code}`)));
  });
  // A fresh addon directory compiles both servers first.
  const deadline = Date.now() + 240000;
  while (!fs.existsSync(pids)) {
    assert.ok(Date.now() < deadline, 'The index started analysing the busy module');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  tree = servers.flatMap(pid => [pid, ...descendants(pid)]);
  assert.ok(tree.length >= 3, `The servers and the compile-time child are running: ${tree}`);
  const exited = new Promise(resolve => host.once('exit', resolve));
  host.kill('SIGKILL');
  await exited;
  const settled = Date.now() + 20000;
  while (tree.some(alive) && Date.now() < settled) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(tree.filter(alive), [], 'No server process outlives the extension host');
});
