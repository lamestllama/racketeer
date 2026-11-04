// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const treeRemoval = require('./support/tree-removal');
const test = require('./support/node-test');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');

async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function fixture(t, source, support) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-entry-'));
  deferCleanup(t, () => fs.rm(directory, treeRemoval));
  const program = path.join(directory, 'main.rkt');
  await fs.writeFile(program, source);
  if (support) await fs.writeFile(path.join(directory, 'support.rkt'), support);
  return program;
}
async function start(t, program, options = {}) {
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, stopOnEntry: true, ...options }));
  await client.event('initialized');
  return client;
}
async function stoppedAt(client, program, line, reason = 'entry') {
  const stop = await client.event('stopped');
  assert.equal(stop.body.reason, reason);
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(stackFrames[0].source.path, program);
  assert.equal(stackFrames[0].line, line);
  return stop;
}
async function finish(client, stop) {
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  assert.ok(!client.events.some(event => event.event === 'stopped'));
}
function outputOf(client) {
  return client.events.filter(event => event.event === 'output' && event.body.category === 'stdout')
    .map(event => event.body.output).join('');
}

for (const mode of ['entryPoint', 'firstExpression']) {
  for (const [name, source, line, options] of [
    ['module literal', '#lang racket/base\n73\n', 2, {}],
    ['module reference', '#lang racket/base\n(define selected 73)\nselected\n', 3, {}],
    ['main literal', '#lang racket/base\n(module+ main\n  73)\n', 3, {}],
    ['main reference', '#lang racket/base\n(define selected 73)\n(module+ main\n  selected)\n', 4, {}],
    ['plain literal', '73\n', 1, { language: 'racket/base' }],
    ['plain reference', '(define selected 73)\nselected\n', 2, { language: 'racket/base' }]
  ]) {
    test(`${mode} stops before a ${name} and exposes its completion value`, async t => {
      const program = await fixture(t, source);
      const client = await start(t, program, { stopOnEntryMode: mode, ...options });
      await ok(client.request('configurationDone'));
      let stop = await stoppedAt(client, program, line);
      assert.equal(stop.body.racketdapStopKind, 'before');
      await ok(client.request('next', { threadId: stop.body.threadId }));
      stop = await stoppedAt(client, program, line, 'step');
      assert.equal(stop.body.racketdapStopKind, 'after');
      const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
      const { scopes } = await ok(client.request('scopes', { frameId: stackFrames[0].id }));
      const result = scopes.find(scope => scope.name.startsWith('Return values'));
      assert.ok(result);
      const { variables } = await ok(client.request('variables', { variablesReference: result.variablesReference }));
      assert.deepEqual(variables.map(value => value.value), ['73']);
      await finish(client, stop);
    });
  }
}

test('literal arguments and definition initializers do not become separate steps', async t => {
  const program = await fixture(t, '#lang racket/base\n(define base 60)\n(+ base 13)\n');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  const stop = await stoppedAt(client, program, 3);
  await ok(client.request('stepIn', { threadId: stop.body.threadId }));
  const returned = await stoppedAt(client, program, 3, 'step');
  assert.equal(returned.body.racketdapStopKind, 'after');
  await finish(client, returned);
});

test('an explicit atomic-expression breakpoint remains independent of stop on entry', async t => {
  const program = await fixture(t, '#lang racket/base\n(define selected 73)\nselected\n');
  const client = await start(t, program, { stopOnEntry: false });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }));
  await ok(client.request('configurationDone'));
  await finish(client, await stoppedAt(client, program, 3, 'breakpoint'));
});

test('multi-file entry starts at the main call and Step Into reaches its body', async t => {
  const program = path.resolve(__dirname, '../examples/multi-file/main.rkt');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  let stop = await stoppedAt(client, program, 10);
  await ok(client.request('stepIn', { threadId: stop.body.threadId }));
  stop = await stoppedAt(client, program, 6, 'step');
  await finish(client, stop);
});

test('workflow entry still starts at show-price in main', async t => {
  const program = path.resolve(__dirname, '../examples/workflow/main.rkt');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  await finish(client, await stoppedAt(client, program, 9));
});

test('explicit entryPoint mode starts at main', async t => {
  const program = path.resolve(__dirname, '../examples/multi-file/main.rkt');
  const client = await start(t, program, { stopOnEntryMode: 'entryPoint' });
  await ok(client.request('configurationDone'));
  await finish(client, await stoppedAt(client, program, 10));
});

test('firstExpression mode stops at function setup and steps forward to main', async t => {
  const program = path.resolve(__dirname, '../examples/multi-file/main.rkt');
  const client = await start(t, program, { stopOnEntryMode: 'firstExpression' });
  await ok(client.request('configurationDone'));
  let stop = await stoppedAt(client, program, 5);
  await ok(client.request('next', { threadId: stop.body.threadId }));
  stop = await stoppedAt(client, program, 7, 'step');
  assert.equal(stop.body.racketdapStopKind, 'after');
  await ok(client.request('next', { threadId: stop.body.threadId }));
  stop = await stoppedAt(client, program, 10, 'step');
  assert.equal(stop.body.racketdapStopKind, 'before');
  await finish(client, stop);
});

for (const dependency of [false, true]) {
  test(`firstExpression mode pauses before ${dependency ? 'imported' : 'parent'} initialization effects`, async t => {
    const program = await fixture(t, '#lang racket/base\n(require "support.rkt")\n(displayln "parent")\n(module+ main (displayln "main"))\n',
      '#lang racket/base\n' + (dependency ? '(displayln "imported")\n' : ''));
    const source = dependency ? path.join(path.dirname(program), 'support.rkt') : program;
    const client = await start(t, program, { stopOnEntryMode: 'firstExpression' });
    await ok(client.request('configurationDone'));
    const stop = await stoppedAt(client, source, dependency ? 2 : 3);
    assert.equal(outputOf(client), '');
    await finish(client, stop);
    assert.equal(outputOf(client), (dependency ? 'imported\n' : '') + 'parent\nmain\n');
  });
}

for (const options of [{ stopOnEntry: false }, { noDebug: true }]) {
  test(`firstExpression mode respects ${Object.keys(options)[0]}`, async t => {
    const program = await fixture(t, '#lang racket/base\n(displayln "parent")\n(module+ main (displayln "main"))\n');
    const client = await start(t, program, { stopOnEntryMode: 'firstExpression', ...options });
    await ok(client.request('configurationDone'));
    await client.event('terminated');
    assert.equal((await client.event('exited')).body.exitCode, 0);
    assert.ok(!client.events.some(event => event.event === 'stopped'));
    assert.equal(outputOf(client), 'parent\nmain\n');
  });
}

test('invalid startup modes reject launch without consuming the session', async t => {
  const program = path.resolve(__dirname, '../examples/multi-file/main.rkt');
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  for (const mode of ['first', false, null, 1]) {
    const rejected = await client.request('launch', { program, stopOnEntry: true, stopOnEntryMode: mode });
    assert.equal(rejected.success, false);
    assert.match(rejected.message, /stopOnEntryMode must be entryPoint or firstExpression/);
  }
  await ok(client.request('launch', { program, stopOnEntry: true, stopOnEntryMode: 'firstExpression' }));
  await client.event('initialized');
  await ok(client.request('configurationDone'));
  await finish(client, await stoppedAt(client, program, 5));
});

test('main entry skips parent, imported and sibling initialization without repeating it', async t => {
  const program = await fixture(t, [
    '#lang racket/base',
    '(require (for-syntax racket/base))',
    '(begin-for-syntax (displayln "expanded"))',
    '(displayln "parent")',
    '(module sibling racket/base (displayln "sibling"))',
    '(module+ main',
    '  (require "support.rkt" (submod ".." sibling))',
    '  (displayln "main"))', ''
  ].join('\n'), '#lang racket/base\n(displayln "imported")\n');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  await finish(client, await stoppedAt(client, program, 8));
  const normal = await start(t, program, { noDebug: true });
  await ok(normal.request('configurationDone'));
  await normal.event('terminated');
  assert.equal((await normal.event('exited')).body.exitCode, 0);
  assert.equal(outputOf(client), outputOf(normal));
  assert.match(outputOf(client), /parent\nimported\nsibling\nmain\n$/);
});

for (const mode of ['entryPoint', 'firstExpression']) {
  for (const location of ['parent', 'import']) {
    test(`explicit ${location} initialization breakpoint is honored in ${mode} mode`, async t => {
      const program = await fixture(t, '#lang racket/base\n(require "support.rkt")\n(displayln "parent")\n(module+ main\n  (displayln "main"))\n',
        '#lang racket/base\n(displayln "imported")\n');
      const source = location === 'parent' ? program : path.join(path.dirname(program), 'support.rkt');
      const line = location === 'parent' ? 3 : 2;
      const client = await start(t, program, { stopOnEntryMode: mode });
      await ok(client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line }] }));
      await ok(client.request('configurationDone'));
      if (mode === 'firstExpression' && location === 'parent') {
        const stop = await stoppedAt(client, path.join(path.dirname(program), 'support.rkt'), 2);
        await ok(client.request('continue', { threadId: stop.body.threadId }));
      }
      await finish(client, await stoppedAt(client, source, line, 'breakpoint'));
    });
  }
}

for (const [name, source, options, line] of [
  ['no main', '#lang racket/base\n(require "support.rkt")\n(displayln "body")\n', {}, 3],
  ['explicit module body', '#lang racket/base\n(displayln "body")\n(module+ main (displayln "main"))\n', { submodule: [] }, 2],
  ['selected nested submodule', '#lang racket/base\n(displayln "parent")\n(module+ nested\n  (displayln "nested")\n  (module+ selected\n    (displayln "selected")))\n(module+ main (error "wrong entry"))\n', { submodule: ['nested', 'selected'] }, 6],
  ['test submodule', '#lang racket/base\n(displayln "parent")\n(module+ main (error "wrong entry"))\n(module+ test\n  (displayln "test"))\n', { testMode: true }, 5],
  ['independent main submodule', '#lang racket\n(displayln "parent")\n(module main racket/base\n  (displayln "main"))\n', {}, 4],
  ['plain file', '(displayln "plain")\n', { language: 'racket/base' }, 1]
]) {
  test(`entry selection supports ${name}`, async t => {
    const program = await fixture(t, source, '#lang racket/base\n(displayln "imported")\n');
    const client = await start(t, program, options);
    await ok(client.request('configurationDone'));
    await finish(client, await stoppedAt(client, program, line));
  });
}

for (const mode of ['entryPoint', 'firstExpression']) {
  test(`empty main does not move the ${mode} startup stop into later Debug Console calls`, async t => {
    const program = await fixture(t, '#lang racket/base\n(define (later) (+ 20 22))\n(module+ main)\n');
    const client = await start(t, program, { interactive: true, stopOnEntryMode: mode });
    await ok(client.request('configurationDone'));
    await client.event('racketdap/ready');
    assert.equal((await ok(client.request('evaluate', { expression: '(later)', context: 'repl' }))).result, '42');
    assert.ok(!client.events.some(event => event.event === 'stopped'));
  });
}
