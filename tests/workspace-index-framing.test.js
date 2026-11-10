// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { spawnSync } = require('node:child_process');
const { root, addon, rawServer } = require('./workspace-index-project');

test('concurrent index replies reach the client as whole messages', () => {
  const result = spawnSync('raco', ['test', '--timeout', '280', 'tests/fixtures/workspace-index-framing.rkt'], {
    cwd: root, env: { ...process.env, PLTADDONDIR: addon }, encoding: 'utf8', timeout: 240000
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 test passed/);
});

const embedded = JSON.stringify({ jsonrpc: '2.0', id: 'inside', method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
for (const body of [`! \r\n\r\n${embedded}`, '{} {}', '', '"é" trailing']) {
  test(`a bounded malformed JSON body preserves the following frame: ${JSON.stringify(body)}`, async t => {
    const server = rawServer(t);
    server.writeFrame(body);
    server.send({ id: 'init', method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
    assert.deepEqual(await server.next(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Malformed JSON' } });
    let timer;
    try {
      assert.equal((await Promise.race([server.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Following frame was lost')), 5000); })])).id, 'init');
    } finally { clearTimeout(timer); }
  });
}

test('frame lengths count UTF-8 bytes across partial writes', async t => {
  const server = rawServer(t);
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'é😀', method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } }));
  server.child.stdin.write(`Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`);
  for (const byte of body) server.child.stdin.write(Buffer.from([byte]));
  assert.equal((await server.next()).id, 'é😀');
});
