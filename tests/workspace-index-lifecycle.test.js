// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { root, definition, uri, rawServer } = require('./workspace-index-project');

const invalidRequest = -32600, serverNotInitialized = -32002, requestFailed = -32803;
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

test('the design document states each capability and private message the server has', { timeout: 120000 }, async t => {
  const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');
  const server = rawServer(t);
  const { capabilities } = await initialize(server, asking);
  for (const name of Object.keys(capabilities)) assert.ok(design.includes(`\`${name}`), name);
  for (const name of ['racketeer/indexStatus', 'racketeer/sourceReferences', 'racketeer.refreshWorkspaceIndex',
    'racket-langserver.workspaceAnalysis', capabilities.positionEncoding]) assert.ok(design.includes(`\`${name}\``), name);
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

test('a client without documentChanges receives a plain WorkspaceEdit', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  await initialize(server, {}, directory);
  open(server, directory);
  server.send({ id: 1, method: 'textDocument/rename', params: { newName: 'squared',
    textDocument: { uri: uri(path.join(directory, 'definition.rkt')) }, position: { line: 2, character: 10 } } });
  const { result } = await server.next();
  assert.equal(result.documentChanges, undefined);
  assert.equal(result.changes[uri(path.join(directory, 'definition.rkt'))].length, 2);
});

test('index status is sent only to a client that asked for it', { timeout: 120000 }, async t => {
  const directory = workspace(t);
  const plain = rawServer(t);
  await initialize(plain, {}, directory);
  open(plain, directory); plain.send(references(directory, 1));
  assert.equal((await plain.next()).id, 1, 'The first message is the answer');
  const asked = rawServer(t);
  await initialize(asked, asking, directory);
  open(asked, directory); asked.send(references(directory, 1));
  const status = await asked.next();
  assert.equal(status.method, 'racketeer/indexStatus');
  assert.equal(status.params.state, 'ready', 'Status reports only the final state');
});

test('a pass reports progress only to a client that offers it, and only once its token is accepted', { timeout: 120000 }, async t => {
  const directory = workspace(t), plain = rawServer(t);
  await initialize(plain, asking, directory);
  open(plain, directory); plain.send(references(directory, 1));
  assert.equal((await plain.next()).method, 'racketeer/indexStatus', 'No progress without the offer');
  const server = rawServer(t);
  await initialize(server, { ...asking, window: { workDoneProgress: true } }, directory);
  open(server, directory); server.send(references(directory, 1));
  const create = await server.next();
  assert.equal(create.method, 'window/workDoneProgress/create');
  const following = server.next();
  const held = await Promise.race([following, new Promise(resolve => setTimeout(resolve, 300, 'nothing'))]);
  assert.equal(held, 'nothing', 'Nothing is sent on a token the client has not accepted');
  server.send({ id: create.id, result: null });
  const seen = [];
  let last;
  for (let message = await following; !seen.includes('status'); message = await server.next()) {
    if (message.method === '$/progress') {
      const { value } = message.params;
      assert.equal(message.params.token, create.params.token);
      seen.push(value.kind);
      if (value.kind === 'begin') {
        assert.equal(value.title, 'Analysing workspace');
        assert.equal(value.percentage, 0, 'A percentage only counts when begin carries one');
      }
      if (value.kind === 'report') last = value;
    } else if (message.method === 'racketeer/indexStatus') {
      assert.equal(message.params.state, 'ready');
      seen.push('status');
      break;
    }
  }
  assert.equal(seen[0], 'begin');
  assert.deepEqual(seen.slice(-2), ['end', 'status']);
  assert.deepEqual(last, { kind: 'report', percentage: 100, message: '1/1' });
});

test('a pass that ends before its token is accepted still begins and ends', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  await initialize(server, { ...asking, window: { workDoneProgress: true } }, directory);
  open(server, directory); server.send(references(directory, 1));
  const create = await server.next();
  assert.equal((await server.next()).params.state, 'ready', 'The final state does not wait for the token');
  assert.equal((await server.next()).id, 1, 'Nor does the answer');
  server.send({ id: create.id, result: null });
  assert.equal((await server.next()).params.value.kind, 'begin');
  assert.equal((await server.next()).params.value.kind, 'end');
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

test('the refresh command makes the next request start a pass and an unknown command is refused', { timeout: 120000 }, async t => {
  const directory = workspace(t), server = rawServer(t);
  await initialize(server, asking, directory);
  open(server, directory);
  server.send(references(directory, 'first'));
  server.send({ id: 'unknown', method: 'workspace/executeCommand', params: { command: 'no.such.command' } });
  const seen = new Map();
  let passes = 0;
  const until = async done => {
    while (!done()) {
      const message = await server.next();
      if (message.id) seen.set(message.id, message);
      if (message.params?.state === 'ready') passes++;
    }
  };
  await until(() => seen.has('first') && seen.has('unknown') && passes === 1);
  server.send({ id: 'refresh', method: 'workspace/executeCommand', params: { command: 'racketeer.refreshWorkspaceIndex' } });
  await until(() => seen.has('refresh'));
  assert.equal(passes, 1, 'The refresh itself starts no pass');
  server.send(references(directory, 'second'));
  await until(() => seen.has('second') && passes === 2);
  assert.equal(seen.get('unknown').error.code, -32602);
  assert.equal(seen.get('refresh').result, null);
});

test('a rename waiting for the writer refuses after a change read meanwhile', { timeout: 180000 }, async t => {
  const directory = workspace(t), origin = path.join(directory, 'definition.rkt'), consumer = path.join(directory, 'uses.rkt');
  // Enough references to fill the pipe, so that a reply behind them waits to be written.
  const text = '#lang racket/base\n(require "definition.rkt")\n' + '(square 3)\n'.repeat(6000);
  fs.writeFileSync(consumer, text);
  const server = rawServer(t, { RACKETEER_INDEX_TRACE: '1' });
  let logged = '';
  server.child.stderr.on('data', bytes => { logged += bytes; });
  await initialize(server, { workspace: { workspaceEdit: { documentChanges: true } } }, directory);
  open(server, directory);
  server.send(references(directory, 'warm'));
  await server.next();
  server.child.stdout.pause();
  server.send(references(directory, 'fill'));
  await delay(2000);
  server.send({ id: 'rename', method: 'textDocument/rename', params: { textDocument: { uri: uri(origin) },
    position: { line: 2, character: 10 }, newName: 'squared' } });
  const deadline = Date.now() + 90000;
  while (!/rename [^\n]*: reaped/.test(logged)) {
    assert.ok(Date.now() < deadline, logged);
    await delay(50);
  }
  await delay(100);
  // The old answer's ranges would now address other text.
  fs.writeFileSync(consumer, `; a new first line\n${text}`);
  server.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [{ uri: uri(consumer), type: 2 }] } });
  await delay(500);
  server.child.stdout.resume();
  let answer;
  while (!answer) {
    const message = await server.next();
    if (message.id === 'rename') answer = message;
  }
  assert.equal(answer.error?.code, requestFailed);
  assert.equal(answer.error?.message, 'Workspace changed during rename. Try Rename again.');
});
