// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [path.join(__dirname, '../vscode')] }));
const { definition, uses, uri, root, addon, project } = require('./workspace-index-project');

const windows = process.platform === 'win32';
// Above what these tests' own small files need, and quick for a macro to pass.
const lowLimit = '64';
const low = { RACKETEER_INDEX_WORKER_MEGABYTES: lowLimit };
const unset = { RACKETEER_INDEX_WORKER_MEGABYTES: undefined };
const from = (locations, source) => locations.filter(location => location.uri === source);
const quoted = text => JSON.stringify(text);

// Compile-time programs. A file's macro runs in whichever worker analyses it.
const compileTime = (body, requires = '') =>
  `#lang racket/base\n(require (for-syntax racket/base ${requires}))\n(begin-for-syntax\n${body})\n`;
const keepAllocating = '(let keep ([kept (quote ())]) (keep (cons (make-vector 100000 0) kept)))';
const library = windows ? '(ffi-lib "msvcrt")' : '#f';
const blockInC = seconds => windows
  ? `((get-ffi-obj "Sleep" (ffi-lib "kernel32") (_fun _uint32 -> _void)) ${seconds * 1000})`
  : `((get-ffi-obj "sleep" #f (_fun _uint -> _uint)) ${seconds})`;
const endProcess = status => `((get-ffi-obj "_exit" ${library} (_fun _int -> _void)) ${status})`;
const writePid = file => `(call-with-output-file ${quoted(file)} #:exists 'truncate (lambda (out)
  (write ((get-ffi-obj ${windows ? '"_getpid"' : '"getpid"'} ${library} (_fun -> _int))) out)))`;

async function eventually(check, seconds, describe) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, describe());
    await delay(50);
  }
}
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = file => eventually(() => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return /^\d+$/.test(text) && Number(text);
}, 60, () => `No process id appeared in ${file}`);

test('a file that needs more memory than the former 256 MB limit is analysed', { timeout: 120000 }, async t => {
  const p = await project(t, unset);
  // A collection is when the limit is checked, so it runs while all of this is held.
  p.write('large.rkt', compileTime(`(let ([kept (for/list ([i 320]) (make-vector 125000 i))])
  (collect-garbage)
  (void (length kept)))`));
  await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
});

test('a worker over the memory limit says so in words, names its file, and the index carries on', { timeout: 120000 }, async t => {
  const p = await project(t, low);
  p.write('greedy.rkt', compileTime(keepAllocating));
  await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.equal(p.notifications.at(-1).failures, 1);
  assert.match(p.diagnostics(), new RegExp(`greedy\\.rkt \\(analysis of \\S*greedy\\.rkt went over the ${lowLimit} MB memory limit for one worker\\)`));
  assert.doesNotMatch(p.diagnostics(), /analysis worker exited/);
  fs.unlinkSync(p.filename('greedy.rkt')); await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready');
});

test('a rename stopped by the memory limit says why and names the file, and a later partial index does too', { timeout: 180000 }, async t => {
  const p = await project(t, low);
  const marker = p.filename('now');
  // Analysed normally until the marker appears, so that the index is ready first.
  p.write('later.rkt', compileTime(`(when (file-exists? ${quoted(marker)}) ${keepAllocating})`));
  await p.update();
  await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  fs.writeFileSync(marker, '');
  await assert.rejects(p.rename(p.origin, 'squared'), error => {
    assert.match(error.message, new RegExp(`^Rename could not finish: analysis of \\S*later\\.rkt went over the ${lowLimit} MB memory limit for one worker\\.$`));
    return true;
  });
  // The marker is a file the macro read without registering it, so only a refresh sees it.
  await p.request('workspace/executeCommand', { command: 'racketeer.refreshWorkspaceIndex' });
  await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'partial', p.diagnostics());
  await assert.rejects(p.rename(p.origin, 'squared'), error => {
    assert.match(error.message, new RegExp(`^Workspace analysis is incomplete, so Rename cannot run: analysis of \\S*later\\.rkt went over the ${lowLimit} MB memory limit for one worker\\.$`));
    return true;
  });
});

test('a worker in a blocking C call is stopped at its time limit, and the index carries on', { timeout: 120000 }, async t => {
  const p = await project(t, {});
  p.settings.timeoutSeconds = 3;
  p.write('stuck.rkt', compileTime(blockInC(70), 'ffi/unsafe'));
  await p.update();
  const asking = p.references(p.origin);
  // Before workers were processes, the stop waited for the whole C call.
  await eventually(() => p.notifications.at(-1)?.state === 'partial', 40, () => p.diagnostics());
  assert.match(p.diagnostics(), /stuck\.rkt \(analysis exceeded its 3 second time limit\)/);
  assert.equal(from(await asking, uri(p.filename('uses.rkt'))).length, 1);
});

test('cancelling a rename whose worker is in a blocking C call frees the index at once', { timeout: 120000 }, async t => {
  const p = await project(t, {});
  const marker = p.filename('now'), entered = p.filename('entered');
  p.write('later.rkt', compileTime(`(when (file-exists? ${quoted(marker)})
  (call-with-output-file ${quoted(entered)} #:exists 'truncate void)
  ${blockInC(70)})`, 'ffi/unsafe'));
  await p.update();
  await p.references(p.origin);
  fs.writeFileSync(marker, '');
  const cancel = new rpc.CancellationTokenSource();
  const rejected = assert.rejects(p.rename(p.origin, 'squared', undefined, cancel.token), error => error.code === -32800);
  await eventually(() => fs.existsSync(entered), 40, () => p.diagnostics());
  const started = Date.now();
  cancel.cancel(); await rejected; cancel.dispose();
  fs.unlinkSync(marker);
  // The next worker cannot start until this one has stopped.
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  // Before workers were processes, the stop waited for the whole C call.
  assert.ok(Date.now() - started < 30000, p.diagnostics());
});

test('compile-time code that ends its process loses only its file, and the status is reported', { timeout: 120000 }, async t => {
  const p = await project(t, {});
  p.write('ended.rkt', compileTime(endProcess(7), 'ffi/unsafe'));
  await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.match(p.diagnostics(), /ended\.rkt \(analysis worker exited with status 7\)/);
});

test('a worker killed by a signal is reported as that, with what it means', { timeout: 120000, skip: windows }, async t => {
  const p = await project(t, {});
  p.write('killed.rkt', compileTime(`((get-ffi-obj "kill" #f (_fun _int _int -> _int))
  ((get-ffi-obj "getpid" #f (_fun -> _int))) 9)
  (sync never-evt)`, 'ffi/unsafe'));
  await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.match(p.diagnostics(), /killed\.rkt \(analysis worker was killed by signal 9, which is how the system ends a process when memory runs out\)/);
});

test('what a dying worker writes to its own error output is part of the reason', { timeout: 120000, skip: windows }, async t => {
  const p = await project(t, {});
  p.write('noisy.rkt', compileTime(`(call-with-output-file "/dev/stderr" #:exists 'append
  (lambda (out) (write-string "fatal: the runtime gave up\\n" out)))
  ${endProcess(3)}`, 'ffi/unsafe'));
  await p.update();
  await p.references(p.origin);
  assert.match(p.diagnostics(), /noisy\.rkt \(analysis worker exited with status 3: fatal: the runtime gave up\)/);
});

test('compile-time code that finds the real output reaches only its own worker', { timeout: 120000, skip: windows }, async t => {
  const p = await project(t, {});
  p.write('forged.rkt', compileTime(`(call-with-output-file "/dev/stdout" #:exists 'append
  (lambda (out) (write-string "Content-Length: 2\\r\\n\\r\\n{}not a reply" out)))
  (sync never-evt)`));
  await p.update();
  assert.equal(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.match(p.diagnostics(), /forged\.rkt \(analysis worker sent a reply that could not be read\)/);
});

// A server with a project of its own, to end in ways the shared helper does not.
async function server(t, command, body) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-worker-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'pid');
  fs.writeFileSync(path.join(directory, 'definition.rkt'), definition);
  fs.writeFileSync(path.join(directory, 'uses.rkt'), uses);
  fs.writeFileSync(path.join(directory, 'stuck.rkt'), compileTime(`${writePid(pidFile)}\n${body}`, 'ffi/unsafe'));
  const child = spawn('racket', command, { cwd: directory, stdio: 'pipe', env: { ...process.env, PLTADDONDIR: addon } });
  const closed = once(child, 'close');
  child.stderr.resume();
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  connection.onError(() => {}); connection.onClose(() => connection.dispose());
  connection.onRequest('workspace/configuration', ({ items }) => items.map(() => ({ enabled: true, timeoutSeconds: 90 })));
  connection.onRequest('client/registerCapability', () => null);
  connection.listen();
  t.after(async () => { connection.dispose(); child.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); await closed; });
  await connection.sendRequest('initialize', { processId: null, rootUri: null,
    workspaceFolders: [{ uri: uri(directory), name: 'project' }],
    capabilities: { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } } } });
  await connection.sendNotification('initialized', {});
  // A pass runs for a request, and this one stays waiting for it.
  const asked = uri(path.join(directory, 'definition.rkt'));
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: asked, languageId: 'racket', version: 1, text: definition } });
  void connection.sendRequest('textDocument/references', { textDocument: { uri: asked }, position: { line: 2, character: 10 },
    context: { includeDeclaration: false } }).catch(() => {});
  return { child, closed, connection, pid: await pidIn(pidFile) };
}
const plain = () => [path.join(root, 'vscode/workspace-index-server.rkt')];
const owned = () => [path.join(root, 'racketdap/tools/owned-command.rkt'), ...plain()];
const stops = (pid, describe) => eventually(() => !running(pid), 20, () => `Worker ${pid} is still running ${describe}`);

const residentBytes = pid => Number(/^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) * 1024;
test('a truncated reply declaring a large graph allocates nothing like it in the server', { timeout: 120000, skip: process.platform !== 'linux' }, async t => {
  const p = await project(t, low);
  await p.references(p.origin);
  const before = residentBytes(p.child.pid);
  // Reaches the worker's reply pipe from compile-time code: a header naming sixteen
  // million shared objects, and then nothing more.
  p.write('forged.rkt', compileTime(`(call-with-output-file "/dev/stdout" #:exists 'append
  (lambda (out)
    (write-bytes (bytes 114 97 99 107 101 116 47 102 97 115 108 58 129 0 0 0 1) out)
    (flush-output out)))
(sync never-evt)`));
  await p.update();
  const cancel = new rpc.CancellationTokenSource();
  const request = p.references(p.origin, undefined, false, cancel.token).catch(error => error);
  let peak = before;
  for (let n = 0; n < 100 && peak - before < 100 * 1024 * 1024; n++) {
    peak = Math.max(peak, residentBytes(p.child.pid));
    await delay(50);
  }
  cancel.cancel();
  await request;
  cancel.dispose();
  assert.ok(peak - before < 80 * 1024 * 1024, `The server grew ${(peak - before) / 1024 / 1024} MiB`);
});

test('a reply nested too deeply to read stops at a limit in the server', { timeout: 120000, skip: process.platform !== 'linux' }, async t => {
  const p = await project(t);
  await p.references(p.origin);
  const before = residentBytes(p.child.pid);
  // Under the limit on a message's size, and far more to read than to send.
  const size = 64 * 1024 * 1024;
  p.write('nested.rkt', compileTime(`(call-with-output-file "/dev/stdout" #:exists 'append
  (lambda (out)
    (write ${size} out)
    (newline out)
    (write-bytes (make-bytes ${size} 91) out)
    (flush-output out)))
(sync never-evt)`));
  await p.update();
  const cancel = new rpc.CancellationTokenSource();
  let settled = false;
  const request = p.references(p.origin, undefined, false, cancel.token).then(found => { settled = true; return found; });
  let peak = before;
  for (let n = 0; n < 1200 && !settled && peak - before < 2048 * 1024 * 1024; n++) {
    peak = Math.max(peak, residentBytes(p.child.pid));
    await delay(50);
  }
  cancel.cancel();
  await request.catch(() => {});
  cancel.dispose();
  assert.ok(peak - before < 2048 * 1024 * 1024, `The server grew ${(peak - before) / 1024 / 1024} MiB`);
  assert.ok(settled, p.diagnostics());
  assert.match(p.diagnostics(), /nested\.rkt \(analysis worker sent a reply that could not be read\)/);
});

test('each worker is a process of its own, and ends when the server is killed', { timeout: 120000 }, async t => {
  const s = await server(t, plain(), '(sync never-evt)');
  assert.notEqual(s.pid, s.child.pid, 'The worker runs in a separate process');
  assert.ok(running(s.pid));
  s.child.kill('SIGKILL');
  await stops(s.pid, 'after its server was killed');
});

test('a worker in a blocking C call ends when the server exits', { timeout: 120000 }, async t => {
  const s = await server(t, plain(), blockInC(70));
  assert.notEqual(s.pid, s.child.pid, 'The worker runs in a separate process');
  await s.connection.sendRequest('shutdown');
  await s.connection.sendNotification('exit');
  await s.closed;
  await stops(s.pid, 'after its server exited');
});

test('a worker in a blocking C call ends with the owned process tree', { timeout: 120000 }, async t => {
  const s = await server(t, owned(), blockInC(70));
  assert.notEqual(s.pid, s.child.pid, 'The worker runs in a separate process');
  s.child.kill('SIGKILL');
  await stops(s.pid, 'after the owner of its tree was killed');
});
