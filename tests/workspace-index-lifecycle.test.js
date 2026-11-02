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
async function initialize(server, capabilities = {}, directory) {
  server.send({ id: 'init', method: 'initialize', params: { processId: null, rootUri: null,
    workspaceFolders: directory ? [{ uri: uri(directory), name: 'project' }] : null, capabilities } });
  const { result } = await server.next();
  server.send({ method: 'initialized', params: {} });
  return result;
}
const open = (server, directory) => server.send({ method: 'textDocument/didOpen', params: { textDocument: {
  uri: uri(path.join(directory, 'definition.rkt')), languageId: 'racket', version: 1, text: definition } } });
const references = (directory, id) => ({ id, method: 'textDocument/references', params: {
  textDocument: { uri: uri(path.join(directory, 'definition.rkt')) },
  position: { line: 2, character: 10 }, context: { includeDeclaration: false } } });

test('initialize answers the standard capabilities and the private extensions', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  const { capabilities } = await initialize(server, asking);
  assert.equal(capabilities.positionEncoding, 'utf-16');
  assert.deepEqual(capabilities.textDocumentSync, { openClose: true, change: 1 });
  assert.deepEqual(capabilities.executeCommandProvider.commands, ['racketeer.refreshWorkspaceIndex']);
  assert.equal(capabilities.referencesProvider, true);
  assert.equal(capabilities.renameProvider, true, 'This client did not offer prepareSupport');
  assert.deepEqual(capabilities.workspace.workspaceFolders, { supported: true, changeNotifications: true });
  assert.deepEqual(capabilities.experimental.racketeer, { version: 1, indexStatus: true, sourceReferences: true });
});

test('prepareProvider is offered only to a client with prepareSupport', { timeout: 120000 }, async t => {
  const server = rawServer(t);
  const { capabilities } = await initialize(server, { textDocument: { rename: { prepareSupport: true } } });
  assert.deepEqual(capabilities.renameProvider, { prepareProvider: true });
});

test('requests before initialize answer ServerNotInitialized and notifications are dropped', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  open(server, directory);
  server.send({ id: 1, method: 'shutdown' });
  assert.equal((await server.next()).error.code, serverNotInitialized);
  await initialize(server, {}, directory);
  server.send(references(directory, 2));
  const answer = await server.next();
  assert.equal(answer.id, 2);
  assert.equal(answer.error.code, -32801, 'The dropped open left no document to answer for');
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
  open(server, directory);
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
  await initialize(server, {}, directory);
  open(server, directory);
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

test('a captured source answers references privately while its text is the file\'s', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  await initialize(server, {}, directory);
  const request = (id, text) => ({ id, method: 'racketeer/sourceReferences', params: {
    textDocument: { uri: uri(path.join(directory, 'definition.rkt')) },
    position: { line: 2, character: 10 }, context: { includeDeclaration: true }, text } });
  server.send(request(1, definition));
  const same = await server.next();
  assert.ok(same.result.length, 'The file holds this text');
  server.send(request(2, definition + '; changed\n'));
  assert.equal((await server.next()).error.code, -32801);
});

test('index status is sent only to a client that asked for it', { timeout: 120000 }, async t => {
  const directory = workspace(t);
  const plain = rawServer(t);
  await initialize(plain, {}, directory);
  open(plain, directory); plain.send(references(directory, 1));
  assert.equal((await plain.next()).id, 1, 'The first message is the answer');
  const asked = rawServer(t);
  await initialize(asked, asking, directory);
  const status = await asked.next();
  assert.equal(status.method, 'racketeer/indexStatus');
  assert.equal(status.params.state, 'indexing');
});

const settingsAnd = { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } } };
// Answers the server's requests with `answer`, returning what it asked.
function answering(server, answer) {
  const asked = [];
  void (async () => {
    for (;;) {
      const message = await server.next();
      if (message.method && message.id !== undefined) {
        asked.push(message);
        await answer(message);
      } else server.others.push(message);
    }
  })();
  return asked;
}

test('settings are pulled after initialized and again when they change, and each folder is watched', { timeout: 120000 }, async t => {
  const directory = workspace(t), other = workspace(t), server = rawServer(t);
  server.others = [];
  await initialize(server, settingsAnd, directory);
  const asked = answering(server, message => server.send({ id: message.id,
    result: message.method === 'workspace/configuration' ? [{ enabled: false }] : null }));
  const until = async condition => { while (!condition()) await new Promise(resolve => setTimeout(resolve, 10)); };
  await until(() => asked.length === 2);
  assert.deepEqual(asked.map(message => message.method), ['client/registerCapability', 'workspace/configuration']);
  assert.deepEqual(asked[0].params.registrations.map(item => item.registerOptions.watchers[0].globPattern),
    [{ baseUri: uri(directory), pattern: '**/*' }]);
  assert.equal(asked[1].params.items[0].section, 'racket-langserver.workspaceAnalysis');
  server.send({ method: 'workspace/didChangeConfiguration', params: { settings: null } });
  await until(() => asked.length === 3);
  assert.equal(asked[2].method, 'workspace/configuration');
  server.send({ method: 'workspace/didChangeWorkspaceFolders', params: { event: {
    added: [{ uri: uri(other), name: 'other' }], removed: [{ uri: uri(directory), name: 'project' }] } } });
  await until(() => asked.length === 5);
  assert.deepEqual(asked[3].params.unregisterations.map(item => item.id), [uri(directory)]);
  assert.deepEqual(asked[4].params.registrations.map(item => item.id), [uri(other)]);
});

test('a request waits for settings already asked for', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  server.others = [];
  await initialize(server, settingsAnd, directory);
  open(server, directory);
  let pulls = 0;
  const asked = answering(server, async message => {
    if (message.method !== 'workspace/configuration') return server.send({ id: message.id, result: null });
    // The second answer disables analysis, which a later request must see.
    if (++pulls === 2) await new Promise(resolve => setTimeout(resolve, 300));
    server.send({ id: message.id, result: [{ enabled: pulls === 1 }] });
  });
  server.send(references(directory, 'first'));
  const answer = async id => {
    for (;;) {
      const found = server.others.find(message => message.id === id);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  assert.ok((await answer('first')).result, 'The first pass answers');
  server.send({ method: 'workspace/didChangeConfiguration', params: { settings: null } });
  server.send({ id: 'rename', method: 'textDocument/prepareRename', params: {
    textDocument: { uri: uri(path.join(directory, 'definition.rkt')) }, position: { line: 2, character: 10 } } });
  assert.match((await answer('rename')).error.message, /Enable workspace analysis/);
  assert.equal(asked.filter(message => message.method === 'workspace/configuration').length, 2);
});

test('the refresh command starts a pass and an unknown command is refused', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  await initialize(server, asking, directory);
  server.send({ id: 'unknown', method: 'workspace/executeCommand', params: { command: 'no.such.command' } });
  server.send({ id: 'refresh', method: 'workspace/executeCommand', params: { command: 'racketeer.refreshWorkspaceIndex' } });
  const seen = new Map();
  let indexing = 0;
  while (!seen.has('refresh') || indexing < 2) {
    const message = await server.next();
    if (message.id) seen.set(message.id, message);
    if (message.params?.state === 'indexing' && message.params.indexed === 0) indexing++;
  }
  assert.equal(seen.get('unknown').error.code, -32602);
  assert.equal(seen.get('refresh').result, null);
});
