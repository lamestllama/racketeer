// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const treeRemoval = require('./support/tree-removal');
const test = require('./support/node-test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');

async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function fixture(t, source, files = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-runtime-'));
  deferCleanup(t, () => fs.rm(directory, treeRemoval));
  for (const [name, text] of Object.entries({ 'program.rkt': source, ...files })) {
    await fs.writeFile(path.join(directory, name), text);
  }
  return path.join(directory, 'program.rkt');
}
async function start(t, program, options = {}) {
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, ...options }));
  await client.event('initialized');
  await ok(client.request('configurationDone'));
  return client;
}
function stdout(client) {
  return client.events.filter(e => e.event === 'output' && e.body.category === 'stdout')
    .map(e => e.body.output).join('');
}
async function finish(client, exitCode = 0) {
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, exitCode);
}

const configuration = '(module configure-runtime racket/base\n' +
  ' (displayln "configured") (print-as-expression #f))\n';

test('Run and Debug configure only the entry program before dependencies, body and main', async t => {
  const program = await fixture(t, '#lang racket/base\n' + configuration +
    '(require "dependency.rkt")\n(displayln (list \'body (print-as-expression)))\n' +
    '(module+ main (displayln (list \'main (print-as-expression))))\n', {
    'dependency.rkt': '#lang racket/base\n(module configure-runtime racket/base (error "dependency configuration ran"))\n' +
      '(displayln (list \'dependency (print-as-expression)))\n'
  });
  const expected = execFileSync('racket', [program], { encoding: 'utf8', timeout: 10000 });
  assert.equal(expected, 'configured\n(dependency #f)\n(body #f)\n(main #f)\n');
  for (const noDebug of [true, false]) {
    const client = await start(t, program, { noDebug });
    await finish(client);
    assert.equal(stdout(client), expected);
  }
});

test('Debug REPL retains runtime parameters and startup runs once per session', async t => {
  const program = await fixture(t, '#lang racket/base\n' + configuration + '(define answer 42)\n');
  const client = await start(t, program, { interactive: true, submodule: [] });
  await client.event('racketdap/ready');
  for (let i = 0; i < 2; i++) {
    assert.equal((await ok(client.request('evaluate', { context: 'repl', expression: '(print-as-expression)' }))).result, '#f');
    assert.equal((await ok(client.request('evaluate', { context: 'repl', expression: 'answer' }))).result, '42');
  }
  assert.equal(stdout(client), 'configured\n');
  await ok(client.request('terminate'));
  await client.event('terminated');
});

test('runtime configuration does not consume the automatic main entry stop', async t => {
  const program = await fixture(t, '#lang racket/base\n' + configuration +
    '(module+ main\n (displayln "main"))\n');
  const client = await start(t, program, { stopOnEntry: true });
  const stop = await client.event('stopped');
  assert.equal(stop.body.reason, 'entry');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(stackFrames[0].line, 5);
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  await finish(client);
  assert.equal(stdout(client), 'configured\nmain\n');
});

test('configuration failures stop startup before the program body runs', async t => {
  const program = await fixture(t, '#lang racket/base\n' +
    '(module configure-runtime racket/base (error "configuration failed"))\n(displayln "body ran")\n');
  for (const noDebug of [true, false]) {
    const client = await start(t, program, { noDebug });
    await finish(client, 1);
    assert.equal(stdout(client), '');
    assert.match(client.events.filter(e => e.event === 'output').map(e => e.body.output).join(''), /configuration failed/);
  }
});

test('plain files still use their chosen top-level language without module startup', async t => {
  const program = await fixture(t, '(define answer 42)\n(displayln answer)\n');
  const client = await start(t, program, { language: 'racket/base' });
  await finish(client);
  assert.equal(stdout(client), '42\n');
});

test('explicit nested submodules configure their own language without instantiating the parent', async t => {
  const program = await fixture(t, '#lang racket/base\n' +
    '(module configure-runtime racket/base (error "parent configuration ran"))\n(error "parent body ran")\n' +
    '(module outer racket/base\n (module inner racket/base\n' + configuration +
    '  (displayln (print-as-expression))))\n');
  for (const noDebug of [true, false]) {
    const client = await start(t, program, { submodule: ['outer', 'inner'], noDebug });
    await finish(client);
    assert.equal(stdout(client), 'configured\n#f\n');
  }
});

test('legacy language configuration follows the submodule protocol and remains separate from raco test', async t => {
  const program = await fixture(t, '#lang reader "reader.rkt"\n' +
    '(module configure-runtime racket/base (displayln "submodule") (print-as-expression #t))\n' +
    '(displayln (list \'body (print-as-expression)))\n');
  const directory = path.dirname(program);
  // Absolute file module paths keep the public metadata independent of cwd.
  const infoPath = JSON.stringify(path.join(directory, 'language-info.rkt'));
  await fs.writeFile(path.join(directory, 'reader.rkt'), '#lang s-exp syntax/module-reader\nracket/base\n' +
    `#:language-info '#((file ${infoPath}) get-info #f)\n`);
  await fs.writeFile(path.join(directory, 'language-info.rkt'), '#lang racket/base\n(provide get-info configure)\n' +
    `(define (get-info data) (lambda (key default) (if (eq? key 'configure-runtime)\n` +
    ` (list (vector '(file ${infoPath}) 'configure #f)) default)))\n` +
    '(define (configure data) (displayln "legacy") (print-as-expression #f))\n');
  const expected = execFileSync('racket', [program], { encoding: 'utf8', timeout: 10000 });
  assert.equal(expected, 'submodule\nlegacy\n(body #f)\n');
  for (const noDebug of [true, false]) {
    const client = await start(t, program, { noDebug });
    await finish(client);
    assert.equal(stdout(client), expected);
  }
  const tests = await start(t, program, { testMode: true, noDebug: true });
  await finish(tests);
  assert.equal(stdout(tests), 'submodule\n(body #t)\n');
});
