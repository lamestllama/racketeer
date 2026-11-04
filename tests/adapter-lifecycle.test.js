// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const program = path.resolve(__dirname, '../examples/demo.rkt');
const execute = promisify(execFile);
async function ok(promise) {
  const response = await promise;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function clientFor(t) {
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  return client;
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-lifecycle-'));
  return directory;
}
async function peer(t, partial) {
  const directory = await temporary(t);
  const executable = path.join(directory, 'worker');
  await fs.writeFile(executable, `#!${process.execPath}\n` + (partial ? `
const net = require('node:net');
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const bootstrap = JSON.parse(input.subarray(input.indexOf('\\r\\n\\r\\n') + 4));
  const socket = net.connect(bootstrap.port, '127.0.0.1', () => {
    socket.write('Content-Length: 100\\r\\n\\r\\n{');
    process.stdout.write('partial handshake ready\\n');
  });
});
` : "setInterval(() => {}, 1000);\n"), { mode: 0o755 });
  return executable;
}

for (const command of ['terminate', 'disconnect']) {
  test(`${command} before launch closes the session permanently`, async t => {
    const client = await clientFor(t);
    await ok(client.request(command));
    await client.event('terminated');
    const response = await client.request('launch', { program });
    assert.equal(response.success, false);
    assert.match(response.message, /session has ended/);
    assert.ok(!client.events.some(event => event.event === 'initialized'));
  });
}

test('terminate during real worker startup closes the session promptly', async t => {
  const client = await clientFor(t);
  const launched = client.request('launch', { program });
  await ok(client.request('terminate'));
  await launched;
  await client.event('terminated');
  assert.deepEqual((await ok(client.request('threads'))).threads, []);
});

test('an unavailable process-group executable reports the missing command', { skip: process.platform === 'win32' }, async t => {
  const missing = path.join(await temporary(t), 'missing-racket');
  const module = path.resolve(__dirname, '../racketdap/process-group.rkt');
  const expression = `(begin (require (file ${JSON.stringify(module)})) (start-process-group ${JSON.stringify(missing)}))`;
  await assert.rejects(execute('racket', ['-e', expression], { timeout: 240000 }), error => {
    assert.ok(error.stderr.includes(`Cannot resolve the Racket executable: ${missing}`), error.stderr);
    return true;
  });
});

test('a closed Windows job cannot be joined', { skip: process.platform !== 'win32' }, async () => {
  const module = path.resolve(__dirname, '../racketdap/process-group.rkt');
  const expression = `(begin (require (file ${JSON.stringify(module)}))
    (define-values (owner group) (start-process-group))
    (define name (process-group-name owner))
    (stop-process-group! owner)
    (stop-process-group! owner)
    (join-process-group! name)
    (displayln "must not run"))`;
  await assert.rejects(execute('racket', ['-e', expression], { timeout: 240000 }), error => {
    assert.match(error.stderr, /OpenJobObjectW: Windows error/);
    assert.doesNotMatch(error.stdout, /must not run/);
    return true;
  });
});

test('worker bootstrap preserves a source path with spaces and Unicode in another directory', async t => {
  const directory = await temporary(t);
  const source = path.join(directory, 'space λ.rkt');
  await fs.writeFile(source, '#lang racket/base\n(displayln "worker ready")\n');
  const client = await clientFor(t);
  const launched = await client.request('launch', { program: source, cwd: directory });
  if (!launched.success) {
    await client.event('terminated');
    const output = client.events.filter(event => event.event === 'output').map(event => event.body.output).join('');
    assert.fail(`${launched.message}\n${output}`);
  }
  await client.event('initialized');
  await ok(client.request('configurationDone'));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  const output = client.events.filter(event => event.event === 'output' && event.body.category === 'stdout')
    .map(event => event.body.output).join('');
  assert.equal(output.replace(/\r\n/g, '\n'), 'worker ready\n');
});

test('an early worker exit fails launch promptly', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t);
  const executable = path.join(directory, 'worker-exit');
  await fs.writeFile(executable, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const client = await clientFor(t);
  const response = await client.request('launch', { program, racketExecutable: executable });
  assert.equal(response.success, false);
  assert.match(response.message, /exited before initialization/);
  await client.event('terminated');
});

const workerPrograms = {
  // Expansion runs while the debugger loads the program, before it starts.
  loading: '#lang racket/base\n(require (for-syntax racket/base racket/os))\n' +
    '(begin-for-syntax (printf "worker ~a\\n" (getpid)) (flush-output) (sync never-evt))\n',
  running: '#lang racket/base\n(require racket/os)\n(printf "worker ~a\\n" (getpid))\n(flush-output)\n(sync never-evt)\n'
};
for (const [moment, source] of Object.entries(workerPrograms)) {
  test(`a debug worker killed while ${moment} names its ending and the session terminates`, { skip: process.platform === 'win32' }, async t => {
    const directory = await temporary(t);
    const target = path.join(directory, 'killed-worker.rkt');
    await fs.writeFile(target, source);
    const client = await clientFor(t);
    await ok(client.request('launch', { program: target }));
    await client.event('initialized');
    await ok(client.request('configurationDone'));
    const started = await client.event('output', event => /worker \d+/.test(event.body.output));
    process.kill(Number(/worker (\d+)/.exec(started.body.output)[1]), 'SIGKILL');
    const report = await client.event('output', event => event.body.category === 'stderr');
    assert.match(report.body.output, /Racket worker was killed by signal 9 before the program finished\. .*memory runs out/);
    assert.equal((await client.event('exited')).body.exitCode, 137);
    await client.event('terminated');
  });
}

test('terminate cancels a worker that has not connected', { skip: process.platform === 'win32' }, async t => {
  const executable = await peer(t, false);
  const client = await clientFor(t);
  const launched = client.request('launch', { program, racketExecutable: executable });
  await delay(100);
  await ok(client.request('terminate'));
  const response = await launched;
  assert.equal(response.success, false);
  assert.doesNotMatch(response.message, /timed out/, 'terminate must not wait for the startup deadline');
  await client.event('terminated');
  assert.ok(!client.events.some(event => event.event === 'initialized'));
});

test('terminate cancels a partially received handshake', { skip: process.platform === 'win32' }, async t => {
  const executable = await peer(t, true);
  const client = await clientFor(t);
  const launched = client.request('launch', { program, racketExecutable: executable });
  await client.event('output', event => event.body.output.includes('partial handshake ready'));
  await ok(client.request('terminate'));
  const response = await launched;
  assert.equal(response.success, false);
  assert.doesNotMatch(response.message, /timed out/);
  await client.event('terminated');
  assert.ok(!client.events.some(event => event.event === 'initialized'));
});

test('the startup deadline covers the entire framed handshake', { skip: process.platform === 'win32' }, async t => {
  const executable = await peer(t, true);
  const client = await clientFor(t);
  const launched = client.request('launch', { program, racketExecutable: executable });
  await client.event('output', event => event.body.output.includes('partial handshake ready'));
  assert.equal((await client.request('threads')).success, false);
  const response = await launched;
  assert.equal(response.success, false);
  assert.match(response.message, /initialization timed out/);
  await client.event('terminated');
});

async function running(pid) {
  try {
    if (process.platform === 'win32') { process.kill(pid, 0); return true; }
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'stat=']);
        return !!stdout.trim() && !stdout.trim().startsWith('Z');
      } catch (error) { if (error.code === 1) return false; throw error; }
    }
    // A zombie is already terminated; the host's init owns its reaping.
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (error) {
    // Linux can remove a process after /proc opens the file but before read.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error;
  }
}
const waitGone = pid => until(async () => !await running(pid), `Owned descendant ${pid} survived worker shutdown`);

for (const ending of ['terminate', 'disconnect', 'worker crash', 'adapter EOF', 'adapter crash']) {
  test(`${ending} terminates all owned descendants`, async t => {
  const directory = await temporary(t);
  const target = path.join(directory, 'owned-processes.rkt');
  const childProgram = path.join(directory, 'child.rkt');
  await fs.writeFile(childProgram, `#lang racket/base
(define-values (child out in err)
  (subprocess #f #f #f (find-system-path 'exec-file) "-e" "(sync never-evt)"))
(printf "owned-grandchild ~a\\n" (subprocess-pid child))
(flush-output)
(sync never-evt)
`);
  await fs.writeFile(target, `#lang racket/base
(require racket/os)
(define-values (child out in err)
  (subprocess (current-output-port) #f (current-error-port)
              (find-system-path 'exec-file) ${JSON.stringify(childProgram)}))
(printf "owned-pids ~a ~a\\n" (getpid) (subprocess-pid child))
(flush-output)
(sync never-evt)
`);
  const client = ending === 'adapter crash' ? new DapClient() : await clientFor(t);
  if (ending === 'adapter crash') {
    deferCleanup(t, () => assert.rejects(client.close(), /Adapter exited unexpectedly/));
    await ok(client.request('initialize', { adapterID: 'racketdap' }));
  }
  await ok(client.request('launch', { program: target, noDebug: true }));
  await client.event('initialized');
  await ok(client.request('configurationDone'));
  let output = '';
  let match, grandchildMatch;
  while (!(match = /owned-pids (\d+) (\d+)/.exec(output)) ||
         !(grandchildMatch = /owned-grandchild (\d+)/.exec(output))) {
    output += (await client.event('output', event => event.body.category === 'stdout')).body.output;
  }
  const worker = Number(match[1]), descendants = [Number(match[2]), Number(grandchildMatch[1])];
  deferCleanup(t, async () => {
    for (const pid of descendants.reverse()) if (await running(pid)) process.kill(pid, 'SIGKILL');
  });
  for (const pid of descendants) assert.ok(await running(pid));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const unrelatedClosed = once(unrelated, 'close');
  deferCleanup(t, async () => { unrelated.kill('SIGKILL'); await unrelatedClosed; });
  if (ending === 'terminate' || ending === 'disconnect') {
    await ok(client.request(ending));
    await client.event('terminated');
  } else if (ending === 'worker crash') {
    process.kill(worker, 'SIGKILL');
    await client.event('terminated');
    assert.equal((await client.request('threads')).success, true);
  } else if (ending === 'adapter EOF') {
    await client.close();
  } else {
    client.child.kill('SIGKILL');
    await client.closed;
  }
  await waitGone(worker);
  for (const pid of descendants) await waitGone(pid);
  assert.ok(await running(unrelated.pid), 'Other processes must survive session cleanup');
  });
}
