// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const treeRemoval = require('./support/tree-removal');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DapClient } = require('./dap-client');
async function ok(p) { const r = await p; assert.equal(r.success, true, r.message); return r.body; }
for (const interactive of [false, true]) test(`GUI callback debugging with interactive=${interactive}`, { skip: process.platform === 'linux' && !process.env.DISPLAY }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-gui-parity-'));
  const program = path.join(dir, 'gui.rkt');
  await fs.writeFile(program, ['#lang racket/gui',
    '(define window (new frame% [label "Debugger GUI regression"]))',
    '(send window show #t)', '(queue-callback', ' (lambda ()',
    '   (define x 5)', '   (displayln (+ x 1))', '   (send window show #f)))', ''].join('\n'));
  const client = new DapClient();
  t.after(async () => { await client.close(); await fs.rm(dir, treeRemoval); });
  await ok(client.request('initialize'));
  await ok(client.request('launch', { program, cwd: dir, interactive }));
  await client.event('initialized');
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 7, column: 15 }] }));
  await ok(client.request('configurationDone'));
  const stop = (await client.event('stopped')).body;
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.threadId }));
  assert.equal(stackFrames[0].line, 7);
  assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '5');
  await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: '(set! x 20)' }));
  await ok(client.request('continue', { threadId: stop.threadId }));
  await client.event('output', e => e.body.output === '21\n');
  if (interactive) {
    assert.equal((await ok(client.request('evaluate', { expression: '(send window is-shown?)' }))).result, '#f');
    await ok(client.request('terminate'));
  }
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});

test('unhandled GUI callback exceptions expose live frames before unwinding', { skip: process.platform === 'linux' && !process.env.DISPLAY }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-gui-exception-'));
  const program = path.join(dir, 'gui.rkt');
  await fs.writeFile(program, ['#lang racket/gui',
    '(define window (new frame% [label "Debugger GUI exception regression"]))',
    '(send window show #t)', '(queue-callback', ' (lambda ()',
    '   (define x 5)', '   (error "callback boom")', '   (displayln x)))', ''].join('\n'));
  const client = new DapClient();
  t.after(async () => { await client.close(); await fs.rm(dir, treeRemoval); });
  await ok(client.request('initialize'));
  await ok(client.request('launch', { program, cwd: dir }));
  await client.event('initialized');
  await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
  await ok(client.request('configurationDone'));
  const stop = (await client.event('stopped')).body;
  assert.equal(stop.reason, 'exception');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.threadId }));
  assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '5');
  await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: '(send window show #f)' }));
  await ok(client.request('continue', { threadId: stop.threadId }));
  await client.event('terminated');
});
