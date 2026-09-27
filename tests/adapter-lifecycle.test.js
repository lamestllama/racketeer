'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const program = path.resolve(__dirname, '../examples/demo.rkt');
async function ok(promise) {
  const response = await promise;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function clientFor(t) {
  const client = new DapClient(undefined, { timeout: 20000 });
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  return client;
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-lifecycle-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
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
    const start = Date.now();
    const response = await client.request('launch', { program });
    assert.equal(response.success, false);
    assert.match(response.message, /session has ended/);
    assert.ok(Date.now() - start < 1000);
    assert.ok(!client.events.some(event => event.event === 'initialized'));
  });
}

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
  const start = Date.now();
  const response = await client.request('launch', { program, racketExecutable: executable });
  assert.equal(response.success, false);
  assert.match(response.message, /exited before initialization/);
  assert.ok(Date.now() - start < 3000, 'early exit must not wait for startup deadline');
  await client.event('terminated');
});

test('terminate cancels a worker that has not connected', { skip: process.platform === 'win32' }, async t => {
  const executable = await peer(t, false);
  const client = await clientFor(t);
  const launched = client.request('launch', { program, racketExecutable: executable });
  await delay(100);
  const start = Date.now();
  await ok(client.request('terminate'));
  assert.equal((await launched).success, false);
  await client.event('terminated');
  assert.ok(Date.now() - start < 3000, 'terminate must remain responsive during startup');
  assert.ok(!client.events.some(event => event.event === 'initialized'));
});

test('terminate cancels a partially received handshake', { skip: process.platform === 'win32' }, async t => {
  const executable = await peer(t, true);
  const client = await clientFor(t);
  const launched = client.request('launch', { program, racketExecutable: executable });
  await client.event('output', event => event.body.output.includes('partial handshake ready'));
  const start = Date.now();
  await ok(client.request('terminate'));
  assert.equal((await launched).success, false);
  await client.event('terminated');
  assert.ok(Date.now() - start < 3000);
  assert.ok(!client.events.some(event => event.event === 'initialized'));
});

test('the startup deadline covers the entire framed handshake', { skip: process.platform === 'win32' }, async t => {
  const executable = await peer(t, true);
  const client = await clientFor(t);
  const start = Date.now();
  const launched = client.request('launch', { program, racketExecutable: executable });
  await client.event('output', event => event.body.output.includes('partial handshake ready'));
  assert.equal((await client.request('threads')).success, false);
  const response = await launched;
  assert.equal(response.success, false);
  assert.match(response.message, /initialization timed out/);
  assert.ok(Date.now() - start < 19000);
  await client.event('terminated');
});

async function running(pid) {
  try {
    // A zombie is already terminated; the host's init owns its reaping.
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (error) {
    // Linux can remove a process after /proc opens the file but before read.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error;
  }
}
async function waitGone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await running(pid)) return;
    await delay(20);
  }
  assert.fail(`Owned descendant ${pid} survived worker shutdown`);
}

for (const ending of ['worker crash', 'adapter EOF', 'adapter crash']) {
  test(`${ending} terminates all owned descendants`, { skip: process.platform !== 'linux' }, async t => {
  const directory = await temporary(t);
  const target = path.join(directory, 'owned-processes.rkt');
  await fs.writeFile(target, `#lang racket/base
(require ffi/unsafe)
(define getpid (get-ffi-obj "getpid" (ffi-lib #f) (_fun -> _int)))
(define-values (child out in err) (subprocess #f #f #f (find-executable-path "sleep") "120"))
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
  let match;
  while (!(match = /owned-pids (\d+) (\d+)/.exec(output))) {
    output += (await client.event('output', event => event.body.category === 'stdout')).body.output;
  }
  const worker = Number(match[1]), descendant = Number(match[2]);
  deferCleanup(t, async () => { if (await running(descendant)) process.kill(descendant, 'SIGKILL'); });
  assert.ok(await running(descendant));
  if (ending === 'worker crash') {
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
  await waitGone(descendant);
  });
}
