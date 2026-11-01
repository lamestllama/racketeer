// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function launch(t, text, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-teaching-tests-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'checks.rkt');
  await fs.writeFile(program, text);
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, testMode: true, noDebug: true, ...options }));
  await client.event('initialized');
  return { client, program };
}
async function finish(client) {
  await ok(client.request('configurationDone'));
  const summary = (await client.event('racketdap/test', e => e.body.kind === 'summary')).body;
  await client.event('terminated');
  const exit = (await client.event('exited')).body.exitCode;
  const failures = client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'failure').map(e => e.body);
  const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
  return { summary, exit, failures, output };
}

test('teaching languages report failed check-expect results and clickable locations instead of passing zero checks', async t => {
  for (const language of ['htdp/bsl', 'htdp/bsl+', 'htdp/isl', 'htdp/isl+', 'htdp/asl']) {
    const { client, program } = await launch(t, `#lang ${language}\n(define (price count) (+ 7 count))\n` +
      '(check-expect (price 2) 9)\n(check-expect (price 4) 10)\n');
    const result = await finish(client);
    assert.deepEqual(result.summary, { kind: 'summary', status: 'failed', total: 2, failed: 1 }, language);
    assert.equal(result.exit, 1);
    assert.equal(result.failures.length, 1);
    assert.deepEqual(result.failures[0].location, { path: program, line: 4, column: 1 });
    assert.match(result.output, /1 of the 2 tests failed/);
  }
});

test('all standard teaching checks retain their framework semantics and counts', async t => {
  const { client } = await launch(t, '#lang htdp/isl+\n' +
    '(check-expect (+ 2 3) 5)\n(check-within (/ 1 3) 0.33 0.01)\n' +
    '(check-random (random 20) (random 20))\n(check-error (/ 1 0))\n' +
    '(check-satisfied 5 odd?)\n(check-member-of 3 1 2 3)\n(check-range 5 3 8)\n');
  const result = await finish(client);
  assert.deepEqual(result.summary, { kind: 'summary', status: 'passed', total: 7, failed: 0 });
  assert.equal(result.exit, 0);
  assert.equal(result.failures.length, 0);
});

test('RackUnit and teaching checks combine without rerunning side effects', async t => {
  const { client } = await launch(t, '#lang racket/base\n(require (only-in rackunit check-equal?) test-engine/racket-tests)\n' +
    '(define attempts 0)\n(check-expect (begin (set! attempts (add1 attempts)) attempts) 1)\n' +
    '(check-expect (begin (set! attempts (add1 attempts)) attempts) 99)\n' +
    '(module+ test (check-equal? (+ 2 2) 4) (test) (printf "ATTEMPTS=~a\\n" attempts))\n');
  const result = await finish(client);
  assert.deepEqual(result.summary, { kind: 'summary', status: 'failed', total: 3, failed: 1 });
  assert.match(result.output, /ATTEMPTS=2/);
  assert.equal(result.failures.length, 1);
});

test('registered checks that were never run cannot make a test file pass', async t => {
  const { client } = await launch(t, '#lang racket/base\n(require test-engine/racket-tests)\n(check-expect (+ 2 3) 5)\n');
  const result = await finish(client);
  assert.equal(result.summary.status, 'errored');
  assert.equal(result.summary.total, 1);
  assert.equal(result.exit, 1);
  assert.match(result.failures[0].message, /did not all run/);
});

test('disabled teaching checks are reported as incomplete instead of being run by the adapter', async t => {
  const { client } = await launch(t, '#lang racket/base\n(require test-engine/racket-tests)\n' +
    '(check-expect (error "disabled check ran") 5)\n(test-execute #f)\n(test)\n');
  const result = await finish(client);
  assert.equal(result.summary.status, 'errored');
  assert.equal(result.summary.total, 1);
  assert.doesNotMatch(result.output, /disabled check ran/);
});

test('teaching signature violations fail the file even when its checks pass', async t => {
  const { client } = await launch(t, '#lang htdp/bsl\n(: seats Integer)\n' +
    '(define seats "six")\n(check-expect 1 1)\n');
  const result = await finish(client);
  assert.deepEqual(result.summary, { kind: 'summary', status: 'failed', total: 2, failed: 1 });
  assert.equal(result.exit, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /signature violation/);
  assert.match(result.output, /1 signature violation/);
  assert.match(result.output, /line 2, column 9/);
});

test('discovered RackUnit cases invoking teaching checks reflect failures even when the engine resets its results', async t => {
  const { client } = await launch(t, '#lang racket/base\n' +
    '(module checks racket/base (require test-engine/racket-tests) (check-expect 1 2))\n' +
    '(require \'checks (only-in rackunit test-case) test-engine/racket-tests)\n' +
    '(module+ test (test-case "first run" (test)) (test-case "second run" (test)))\n');
  const result = await finish(client);
  assert.equal(result.summary.status, 'failed');
  const finished = client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case' && e.body.status !== 'started');
  assert.deepEqual(finished.map(e => e.body.status), ['failed', 'failed']);
});

test('test runtime configuration precedes an independent submodule without executing its parent', async t => {
  for (const options of [{}, { noDebug: false }, { coverage: true }]) {
    const { client } = await launch(t, '#lang racket/base\n' +
      '(error "parent must not run")\n' +
      '(module configure-runtime racket/base (print-as-expression #f))\n' +
      '(module test racket/base (require rackunit) (check-false (print-as-expression)))\n', options);
    const result = await finish(client);
    assert.deepEqual(result.summary, { kind: 'summary', status: 'passed', total: 1, failed: 0 }, result.output);
  }
});

test('teaching failures preserve CRLF and UTF-16 locations in coverage runs', async t => {
  const text = '#lang htdp/bsl\r\n(define 😀 4) (check-expect (+ 😀 1) 6)\r\n';
  const { client, program } = await launch(t, text, { coverage: true });
  const result = await finish(client);
  assert.deepEqual(result.failures[0].location, { path: program, line: 2, column: '(define 😀 4) '.length + 1 });
  assert.ok(client.events.some(event => event.event === 'racketdap/coverage'));
  assert.equal(result.summary.failed, 1);
});

test('Debug Test reaches a live teaching-language frame and reports the eventual check failure', async t => {
  const { client, program } = await launch(t, '#lang htdp/bsl\n(define (price count)\n  (+ 7 count))\n(check-expect (price 4) 10)\n', { noDebug: false });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }));
  await ok(client.request('configurationDone'));
  const stop = (await client.event('stopped')).body;
  const stack = await ok(client.request('stackTrace', { threadId: stop.threadId }));
  assert.equal(stack.stackFrames[0].line, 3);
  assert.equal((await ok(client.request('evaluate', { frameId: stack.stackFrames[0].id, expression: 'count' }))).result, '4');
  await ok(client.request('continue', { threadId: stop.threadId }));
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'failed', total: 1, failed: 1 });
  await client.event('terminated');
});
