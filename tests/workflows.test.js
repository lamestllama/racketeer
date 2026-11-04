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
const { selectTests } = require('../vscode/test-selection');

test('test selection honors excluded ancestors and overlapping selections', () => {
  const parent = { id: 'workspace', children: [] };
  const first = { id: 'first', uri: {}, parent };
  const second = { id: 'second', uri: {}, parent };
  parent.children.push(first, second);
  assert.deepEqual(selectTests([parent], { include: [first], exclude: [parent] }), []);
  assert.deepEqual(selectTests([parent], { include: [parent, first], exclude: [second] }), [first]);
  assert.deepEqual(selectTests([parent], {}), [first, second]);
  assert.deepEqual(selectTests([parent], { include: [] }), []);
});

async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function fixture(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-workflow-'));
  deferCleanup(t, () => fs.rm(directory, treeRemoval));
  const program = path.join(directory, 'tests λ😀.rkt');
  await fs.writeFile(program, source);
  return program;
}
async function start(t, program, options = {}) {
  const client = new DapClient(); deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, testMode: true, noDebug: true, ...options }));
  await client.event('initialized');
  return client;
}

test('test mode selects the test submodule, logs failures, preserves RackUnit control flow and Unicode locations', async t => {
  const program = await fixture(t, [
    '#lang racket/base', '(module+ main (error "main must not run"))',
    '(module+ test', '  (require rackunit)',
    '  (check-equal? (+ 1 1) 2)',
    '  (define 😀 "λ") (check-equal? 1 2 "expected failure")',
    '  (test-case "case failure" (check-equal? 3 4) (error "must not reach"))',
    '  (check-exn exn:fail? (lambda () (error "expected")))',
    '  (displayln "finished"))', ''
  ].join('\n'));
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  const summary = await client.event('racketdap/test', e => e.body.kind === 'summary');
  assert.deepEqual(summary.body, { kind: 'summary', status: 'failed', failed: 2, total: 4 });
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 1);
  const failures = client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'failure');
  assert.equal(failures.length, 2);
  assert.match(failures[0].body.message, /expected failure/);
  assert.deepEqual(failures[0].body.location, { path: program, line: 6, column: 19 });
  assert.match(failures[1].body.message, /case failure/);
  assert.ok(!client.events.some(e => e.event === 'stopped'));
  assert.ok(client.events.some(e => e.event === 'output' && e.body.output.includes('finished')));
});

test('test mode uses module body when absent and counts explicitly run suites', async t => {
  const program = await fixture(t, '#lang racket/base\n(require rackunit rackunit/text-ui)\n(run-tests (test-suite "suite" (test-case "pass" (check-equal? 2 2)) (test-case "fail" (check-equal? 1 2))))\n');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'failed', failed: 1, total: 2 });
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 1);
});

test('test mode does not instantiate the parent of an independent test submodule', async t => {
  const program = await fixture(t, '#lang racket/base\n(error "parent must not run")\n(module test racket/base (require rackunit) (check-true #t))\n');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'passed');
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});

test('module load errors produce structured error results', async t => {
  const program = await fixture(t, '#lang racket/base\n(module+ test (error "load error"))\n');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'errored');
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 1);
});

test('debug tests enter required source, expose locals and retain test reporting', async t => {
  const program = await fixture(t, '#lang racket/base\n(require "support.rkt")\n(module+ test (require rackunit) (check-equal? (twice 6) 12))\n');
  const support = path.join(path.dirname(program), 'support.rkt');
  await fs.writeFile(support, '#lang racket/base\n(provide twice)\n(define (twice x)\n  (* x 2))\n');
  const client = await start(t, program, { noDebug: false, sourceRoots: [path.dirname(program)] });
  await ok(client.request('setBreakpoints', { source: { path: support }, breakpoints: [{ line: 4 }] }));
  await ok(client.request('configurationDone'));
  const stop = await client.event('stopped');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(stackFrames[0].source.path, support);
  assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '6');
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'passed');
  await client.event('terminated');
});

test('normal noDebug launch ignores breakpoints and runs main', async t => {
  const program = await fixture(t, '#lang racket/base\n(module+ main (displayln "main ran"))\n');
  const client = await start(t, program, { testMode: false, stopOnEntry: true });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 2 }] }));
  await ok(client.request('configurationDone'));
  await client.event('terminated');
  assert.ok(!client.events.some(e => e.event === 'stopped'));
  assert.ok(client.events.some(e => e.event === 'output' && e.body.output.includes('main ran')));
});

test('debug test errors retain live exception frames before unwinding', async t => {
  const program = await fixture(t, '#lang racket/base\n(define (explode x) (error "broken"))\n(module+ test (explode 42))\n');
  const client = await start(t, program, { noDebug: false });
  await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
  await ok(client.request('configurationDone'));
  const stop = await client.event('stopped');
  assert.equal(stop.body.reason, 'exception');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '42');
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 1);
  assert.ok(client.events.some(e => e.event === 'output' && e.body.category === 'stderr' && e.body.output.includes('broken')));
});

test('test failure locations retain captured Unicode coordinates after saved edits', async t => {
  const checkLine = '  (define 😀 (identity 1)) (check-equal? 😀 2))';
  const program = await fixture(t, `#lang racket/base\n(define (identity x)\n  (+ x 0))\n(module+ test (require rackunit)\n${checkLine}\n`);
  const client = await start(t, program, { noDebug: false });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }));
  await ok(client.request('configurationDone'));
  const stop = await client.event('stopped');
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [] }));
  await fs.writeFile(program, '#lang racket/base\n; edited while paused\n');
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  const failure = await client.event('racketdap/test', e => e.body.kind === 'failure');
  assert.deepEqual(failure.body.location, { path: program, line: 5, column: checkLine.indexOf('(check-equal?') + 1 });
  await client.event('terminated');
});

test('cancel a blocked test without affecting another interactive session', async t => {
  const program = await fixture(t, '#lang racket/base\n(module+ test (displayln "waiting") (flush-output) (sync never-evt))\n');
  const interactive = await start(t, program, { testMode: false, noDebug: false, interactive: true, submodule: [] });
  await ok(interactive.request('configurationDone'));
  await interactive.event('racketdap/ready');
  const client = await start(t, program);
  await ok(client.request('configurationDone'));
  await client.event('output', e => e.body.output.includes('waiting'));
  await ok(client.request('terminate'));
  await client.event('terminated');
  assert.equal((await ok(interactive.request('evaluate', { expression: '(+ 20 22)', context: 'repl', racketdapEcho: true }))).result, '42');
  await interactive.event('output', e => e.body.category === 'console' && e.body.output === '42\n');
});
