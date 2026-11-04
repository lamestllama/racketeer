// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const treeRemoval = require('./support/tree-removal');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-package-'));
  deferCleanup(t, () => fs.rm(root, treeRemoval));
  const directory = path.join(root, 'racketdap-test-library');
  const workspace = path.join(root, 'workspace');
  const addon = path.join(root, 'addon');
  await fs.mkdir(directory); await fs.mkdir(workspace);
  const helper = path.join(directory, 'main.rkt');
  const program = path.join(workspace, 'main.rkt');
  await fs.writeFile(path.join(directory, 'info.rkt'), '#lang info\n(define collection "dogfood-library")\n(define deps \'("base"))\n');
  await fs.writeFile(helper, '#lang racket/base\n(provide twice)\n(define (twice x)\n  (+ x x))\n');
  await fs.writeFile(program, '#lang racket/base\n(require dogfood-library)\n(define result (twice 21))\n(displayln result)\n');
  const env = { ...process.env, PLTADDONDIR: addon };
  await execute('racket', ['-l', 'raco', '--', 'pkg', 'install', '--scope', 'user', '--no-setup', '--deps', 'fail', '--link', '--', directory],
    { env, timeout: 30000 });
  return { directory, program, helper, workspace, addon, env };
}
async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function start(t, fixture, options = {}) {
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize'));
  await ok(client.request('launch', {
    program: fixture.program, cwd: fixture.workspace, sourceRoots: [fixture.workspace],
    env: { PLTADDONDIR: fixture.addon }, debugPackages: ['racketdap-test-library'], ...options
  }));
  await client.event('initialized');
  return client;
}

test('step into a named linked package outside the workspace without a package breakpoint', async t => {
  const fixtureData = await fixture(t);
  const { stdout } = await execute('racket', [path.join(root, 'racketdap/packages.rkt'), 'list'], { env: fixtureData.env });
  const pkg = JSON.parse(stdout).find(pkg => pkg.name === 'racketdap-test-library');
  assert.equal(pkg.directory, fixtureData.directory);
  assert.equal(pkg.scope, 'user'); assert.equal(pkg.linked, true);
  const client = await start(t, fixtureData, { stopOnEntry: true });
  await ok(client.request('configurationDone'));
  let found = false;
  for (let i = 0; i < 12; i++) {
    const stop = await client.event('stopped');
    const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
    if (stackFrames[0].source.path === fixtureData.helper) {
      assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '21');
      await ok(client.request('continue', { threadId: stop.body.threadId }));
      found = true; break;
    }
    await ok(client.request('stepIn', { threadId: stop.body.threadId }));
  }
  assert.ok(found, 'Step In enters the package selected by its package name, not collection name');
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});

test('Debug REPL can add a package breakpoint after loading and evaluate its lexical binding', async t => {
  const fixtureData = await fixture(t);
  const client = await start(t, fixtureData, { interactive: true, submodule: [] });
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  const result = await ok(client.request('setBreakpoints', { source: { path: fixtureData.helper }, breakpoints: [{ line: 4 }] }));
  assert.equal(result.breakpoints[0].verified, true);
  const evaluated = ok(client.request('evaluate', { context: 'repl', expression: '(twice 7)' }));
  const stop = await client.event('stopped');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(stackFrames[0].source.path, fixtureData.helper);
  assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '7');
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  assert.equal((await evaluated).result, '14');
});

test('missing debug packages fail explicitly and noDebug does not resolve optional debug roots', async t => {
  const fixtureData = await fixture(t);
  const missing = ['racketdap-package-does-not-exist'];
  const client = await start(t, fixtureData, { debugPackages: missing });
  await ok(client.request('configurationDone'));
  await client.event('output', e => e.body.output.includes('is not installed'));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 1);
  const normal = await start(t, fixtureData, { debugPackages: missing, noDebug: true });
  await ok(normal.request('configurationDone'));
  await normal.event('terminated');
  assert.equal((await normal.event('exited')).body.exitCode, 0);
});

test('launch rejects malformed package selections before starting a worker', async t => {
  const client = new DapClient(); deferCleanup(t, () => client.close());
  await ok(client.request('initialize'));
  const response = await client.request('launch', { program: path.join(root, 'examples/demo.rkt'), debugPackages: [42] });
  assert.equal(response.success, false);
  assert.match(response.message, /debugPackages/);
});
