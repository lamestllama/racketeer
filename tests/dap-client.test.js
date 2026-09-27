'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DapClient } = require('./dap-client');

function fixture({ stuck = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let exited = false;
  const exit = (code = 0, signal = null) => {
    if (exited) return;
    exited = true;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.stdin.on('finish', () => { if (!stuck) exit(); });
  child.kill = signal => { child.killed = signal; exit(null, signal); };
  const client = new DapClient(undefined, { spawn: () => child, closeTimeout: 20 });
  const send = message => {
    const body = JSON.stringify(message);
    child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  return { client, child, exit, send };
}

test('a framing fault after the final successful response survives teardown', async () => {
  const { client, child, send, exit } = fixture();
  const response = client.request('threads');
  send({ seq: 1, type: 'response', request_seq: 1, success: true });
  assert.equal((await response).success, true);
  child.stdout.write('broken\r\n\r\n');
  exit(17);
  await assert.rejects(client.request('threads'), /Invalid DAP header/);
  await assert.rejects(client.event('stopped'), /Invalid DAP header/);
  await assert.rejects(client.close(), /Invalid DAP header/);
});

test('an unexpected clean exit between requests is still a failure', async () => {
  const { client, exit } = fixture();
  exit(0);
  await assert.rejects(client.close(), /exited unexpectedly \(0\)/);
});

test('requested orderly EOF shutdown succeeds and is idempotent', async () => {
  const { client } = fixture();
  const close = client.close();
  assert.equal(client.close(), close);
  await close;
});

test('trailing partial protocol data fails even an orderly shutdown', async () => {
  const { client, child } = fixture();
  child.stdout.write('Content-Length: 99\r\n\r\n{}');
  await assert.rejects(client.close(), /Truncated DAP message/);
});

test('forced cleanup is bounded and fails the test', async () => {
  const { client, child } = fixture({ stuck: true });
  await assert.rejects(client.close(), /forced SIGKILL cleanup/);
  assert.equal(child.killed, 'SIGKILL');
});
