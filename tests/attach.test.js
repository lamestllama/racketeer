// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const treeRemoval = require('./support/tree-removal');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const net = require('node:net');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const root = path.resolve(__dirname, '..');
async function ok(result) {
  const response = await result;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function host(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-attach-'));
  deferCleanup(t, () => fs.rm(dir, treeRemoval));
  const program = path.join(dir, 'sample.rkt');
  await fs.writeFile(program, '#lang racket/base\n(provide run)\n(define (run)\n  (define answer (+ 20 22))\n  (+ answer 1))\n');
  const child = spawn('racket', [path.join(root, 'tests/support/attach-host.rkt'), program]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  deferCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  const hello = await Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    closed.then(() => { throw new Error(`Host exited before listening: ${stderr}`); })
  ]);
  return { ...hello, program, dir, child, closed, output: () => stdout, errors: () => stderr };
}
async function client(t) {
  const dap = new DapClient();
  deferCleanup(t, () => dap.close());
  await ok(dap.request('initialize', { adapterID: 'racketdap' }));
  return dap;
}
async function attach(dap, h) {
  await ok(dap.request('attach', { port: h.port, token: h.token, sourceRoots: [h.dir] }));
  await dap.event('initialized');
}

test('attach refuses a wrong token, then authenticates and forwards breakpoints and stops', async t => {
  const h = await host(t);
  const wrong = await client(t);
  const refusal = await wrong.request('attach', { port: h.port, token: 'wrong' });
  assert.equal(refusal.success, false);
  assert.ok(!JSON.stringify(refusal).includes(h.token));
  const dap = await client(t);
  await attach(dap, h);
  const breaks = await ok(dap.request('setBreakpoints', { source: { path: h.program }, breakpoints: [{ line: 5 }] }));
  assert.equal(breaks.breakpoints.length, 1);
  await ok(dap.request('configurationDone'));
  const stop = await dap.event('stopped');
  const verified = await dap.event('breakpoint', e => e.body.breakpoint.verified);
  assert.equal(verified.body.breakpoint.verified, true);
  const frames = await ok(dap.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(frames.stackFrames[0].source.path, h.program);
  const interrupt = await dap.request('racketdap/interrupt');
  assert.equal(interrupt.success, false);
  await ok(dap.request('continue', { threadId: stop.body.threadId }));
  const breakpoint = await dap.event('stopped', e => e.body.reason === 'breakpoint');
  assert.equal(breakpoint.body.reason, 'breakpoint');
  await ok(dap.request('setBreakpoints', { source: { path: h.program }, breakpoints: [] }));
  await ok(dap.request('continue', { threadId: breakpoint.body.threadId }));
  await dap.event('terminated');
  assert.equal(dap.events.some(e => e.event === 'exited'), false);
  assert.deepEqual(await h.closed, [0, null]);
  assert.match(h.output(), /43/);
});

for (const action of ['disconnect', 'terminate', 'eof']) {
  test(`${action} releases a stopped attachment and leaves the host alive`, async t => {
    const h = await host(t), dap = await client(t);
    await attach(dap, h);
    await ok(dap.request('configurationDone'));
    await dap.event('stopped');
    if (action === 'eof') await dap.close();
    else {
      await ok(dap.request(action, { terminateDebuggee: true }));
      await dap.event('terminated');
      assert.equal(dap.events.some(e => e.event === 'exited'), false);
    }
    assert.deepEqual(await h.closed, [0, null], h.errors());
    assert.match(h.output(), /43/);
  });
}

test('attach refuses a listener that does not answer with the version 1 hello', async t => {
  const sockets = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    socket.once('data', () => {
      const body = JSON.stringify({ type: 'hello', version: 2 });
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  deferCleanup(t, () => { sockets.forEach(socket => socket.destroy()); return new Promise(done => server.close(done)); });
  const dap = await client(t);
  const reply = await dap.request('attach', { port: server.address().port, token: 'private' });
  assert.equal(reply.success, false);
  assert.equal(dap.events.some(e => e.event === 'initialized'), false);
});

test('attach validates initialization, port and token before connecting', async t => {
  const dap = new DapClient();
  deferCleanup(t, () => dap.close());
  let reply = await dap.request('attach', { port: 12345, token: 'private' });
  assert.equal(reply.success, false);
  assert.match(reply.message, /Initialize/);
  await ok(dap.request('initialize', { adapterID: 'racketdap' }));
  for (const port of [undefined, 0, 65536, '12345']) {
    reply = await dap.request('attach', { port, token: 'private' });
    assert.equal(reply.success, false);
    assert.match(reply.message, /port/);
  }
  reply = await dap.request('attach', { port: 12345 });
  assert.equal(reply.success, false);
  assert.match(reply.message, /token/);
});
