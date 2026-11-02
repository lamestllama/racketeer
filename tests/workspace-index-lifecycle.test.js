// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { definition, uri, rawServer } = require('./workspace-index-project');

const invalidRequest = -32600, serverNotInitialized = -32002;
const exitCode = async server => (await server.closed)[0];
const asking = { experimental: { racketeer: { indexStatus: true, sourceReferences: true } } };

function workspace(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-lifecycle-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'definition.rkt'), definition);
  return directory;
}
async function initialize(server, capabilities = {}) {
  server.send({ id: 'init', method: 'initialize', params: { processId: null, rootUri: null, workspaceFolders: null, capabilities } });
  const { result } = await server.next();
  server.send({ method: 'initialized', params: {} });
  return result;
}
function update(server, directory) {
  server.send({ method: 'racketeer/update', params: { revision: 1, documentsOnly: false, settings: { enabled: true },
    roots: [uri(directory)], documents: [{ uri: uri(path.join(directory, 'definition.rkt')), identity: 1, version: 1, text: definition }] } });
}
const references = (directory, id) => ({ id, method: 'racketeer/references', params: {
  uri: uri(path.join(directory, 'definition.rkt')), identity: 1, version: 1,
  position: { line: 2, character: 10 }, includeDeclaration: false } });

test('initialize answers the standard capabilities and the private extensions', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  const { capabilities } = await initialize(server, asking);
  assert.equal(capabilities.positionEncoding, 'utf-16');
  assert.deepEqual(capabilities.experimental.racketeer, { version: 1, indexStatus: true, sourceReferences: true });
});

test('requests before initialize answer ServerNotInitialized and notifications are dropped', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  update(server, directory);
  server.send({ id: 1, method: 'shutdown' });
  assert.equal((await server.next()).error.code, serverNotInitialized);
  await initialize(server, asking);
  server.send(references(directory, 2));
  const answer = await server.next();
  assert.equal(answer.id, 2);
  assert.equal(answer.error.code, -32801, 'The dropped update left no document to answer for');
});

test('a second initialize answers InvalidRequest', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  await initialize(server);
  server.send({ id: 1, method: 'initialize', params: { capabilities: {} } });
  assert.equal((await server.next()).error.code, invalidRequest);
});

test('after shutdown requests answer InvalidRequest and exit ends the process with code 0', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  await initialize(server);
  server.send({ id: 1, method: 'shutdown' });
  const shutdown = await server.next();
  assert.equal(shutdown.id, 1);
  assert.equal(shutdown.result, null);
  update(server, directory);
  server.send(references(directory, 2));
  assert.equal((await server.next()).error.code, invalidRequest);
  server.send({ method: 'exit' });
  assert.equal(await exitCode(server), 0);
});

test('exit without shutdown ends the process with code 1', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  await initialize(server);
  server.send({ method: 'exit' });
  assert.equal(await exitCode(server), 1);
});

test('the end of its input still ends the process', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  await initialize(server);
  server.child.stdin.end();
  assert.equal(await exitCode(server), 0);
});

test('shutdown answers a request it interrupts with InvalidRequest, not a cancellation', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  const entered = path.join(directory, 'entered');
  fs.writeFileSync(path.join(directory, 'blocked.rkt'), `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate
    (lambda (out) (display "entered" out)))
  (sync never-evt))\n`);
  await initialize(server);
  update(server, directory);
  server.send(references(directory, 1));
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(entered)) {
    assert.ok(Date.now() < deadline, 'Index enters blocked expansion');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  server.send({ id: 2, method: 'shutdown' });
  const answers = [await server.next(), await server.next()];
  assert.equal(answers.find(answer => answer.id === 1).error.code, invalidRequest);
  assert.equal(answers.find(answer => answer.id === 2).result, null);
});

test('index status is sent only to a client that asked for it', { timeout: 120000 }, async t => {
  const directory = workspace(t);
  const plain = rawServer(t);
  await initialize(plain);
  update(plain, directory); plain.send(references(directory, 1));
  assert.equal((await plain.next()).id, 1, 'The first message is the answer');
  const asked = rawServer(t);
  await initialize(asked, asking);
  update(asked, directory);
  const status = await asked.next();
  assert.equal(status.method, 'racketeer/indexStatus');
  assert.equal(status.params.state, 'indexing');
});
