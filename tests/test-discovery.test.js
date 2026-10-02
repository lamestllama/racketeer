'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const { selectTests } = require('../vscode/test-selection');

function discover(text) {
  return new Promise((resolve, reject) => {
    const child = execFile('racket', [path.resolve(__dirname, '../racketdap/test-discovery.rkt')],
      { timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    child.stdin.on('error', reject);
    child.stdin.end(text);
  });
}
async function ok(request) {
  const result = await request;
  assert.equal(result.success, true, result.message);
  return result.body;
}
async function launch(t, text, ids, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-cases-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'cases.rkt');
  await fs.writeFile(program, text);
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, noDebug: true, testMode: true,
    ...(ids ? { testSelection: { sourceHash: createHash('sha1').update(text).digest('hex'), ids } } : {}), ...options }));
  await client.event('initialized');
  return { client, program };
}

test('source discovery handles comments, Unicode, duplicate names and merged test submodules without execution', async () => {
  const text = '#lang racket/base\r\n(require rackunit)\r\n(define setup (error "never evaluate discovery"))\r\n' +
    '(module+ test\r\n #;(test-case "comment" (error "no"))\r\n (test-case "same λ😀" (check-true #t)))\r\n' +
    '(module+ test (begin (test-case "same λ😀" (check-true #t))))\r\n';
  const cases = await discover(text);
  assert.deepEqual(cases.map(c => c.name), ['same λ😀', 'same λ😀']);
  assert.notEqual(cases[0].id, cases[1].id);
  assert.equal(cases[0].line, 5);
  assert.equal(cases[0].column, 1);
  assert.equal(cases[0].endColumn, ' (test-case "same λ😀" (check-true #t))'.length);
  for (const source of ['', '#lang unknown/reader\n(error "no")', '#lang racket\n#reader "missing.rkt"',
    '#lang racket\n(module+ test (test-case "unfinished"',
    '#lang racket\n(require rackunit)\n(for ([i 3]) (test-case "dynamic" (check-true #t)))',
    '#lang racket\n(require rackunit rackunit/text-ui)\n(run-tests (test-suite "suite" (test-case "case" (check-true #t))))']) {
    assert.deepEqual(await discover(source), [], source);
  }
});

test('individual runs preserve setup and skip other cases even when names coincide', async t => {
  const text = '#lang racket/base\n(require rackunit)\n(define value 42)\n' +
    '(module+ main (error "main must not run"))\n(module+ test\n' +
    ' (test-case "same" (error "unselected must not run"))\n' +
    ' (test-case "same" (check-equal? value 42)))\n';
  const cases = await discover(text);
  assert.equal(cases.length, 2);
  const { client } = await launch(t, text, [cases[1].id]);
  await ok(client.request('configurationDone'));
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'passed', failed: 0, total: 1 });
  await client.event('terminated');
  assert.deepEqual(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case')
    .map(e => [e.body.id, e.body.status]), [[cases[1].id, 'started'], [cases[1].id, 'passed']]);
});

test('individual Debug Test retains live source breakpoints and RackUnit failure reporting', async t => {
  const text = '#lang racket/base\n(require rackunit)\n(define (twice x)\n (* x 2))\n(module+ test\n' +
    ' (test-case "skip" (error "not selected"))\n (test-case "selected" (check-equal? (twice 7) 15)))\n';
  const cases = await discover(text);
  const { client, program } = await launch(t, text, [cases[1].id], { noDebug: false });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 4 }] }));
  await ok(client.request('configurationDone'));
  const stop = await client.event('stopped');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(stackFrames[0].line, 4);
  assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '7');
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  const failure = await client.event('racketdap/test', e => e.body.kind === 'failure');
  assert.equal(failure.body.location.line, 7);
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.failed, 1);
  await client.event('terminated');
  assert.equal(client.events.filter(e => e.event === 'racketdap/test' && e.body.status === 'failed' && e.body.kind === 'case').length, 1);
});

test('selection validates source and RackUnit binding before executing user code', async t => {
  const text = '#lang racket/base\n(require rackunit)\n(define setup (error "setup must not run"))\n(test-case "one" (check-true #t))\n';
  const cases = await discover(text);
  for (const [source, selection] of [
    [text, { sourceHash: 'stale', ids: [cases[0].id] }],
    [text, { sourceHash: createHash('sha1').update(text).digest('hex'), ids: [1] }],
    ['#lang racket/base\n(define (test-case name value) value)\n(test-case "one" (error "must not run"))\n', null]
  ]) {
    const found = await discover(source);
    const { client } = await launch(t, source, [found[0].id], selection ? { testSelection: selection } : {});
    await ok(client.request('configurationDone'));
    assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'errored');
    await client.event('terminated');
    const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
    assert.match(output, selection ? /out of date/ : /not RackUnit test-case/);
    assert.doesNotMatch(output, /setup must not run/);
  }
});

test('individual selection honors exclusions and overlapping file and case requests', () => {
  const file = { id: 'file', uri: {}, children: new Map() };
  const first = { id: 'first', uri: {}, parent: file, children: new Map() };
  const second = { id: 'second', uri: {}, parent: file, children: new Map() };
  file.children.set('first', first); file.children.set('second', second);
  assert.deepEqual(selectTests([file], { include: [first, file] }), [file]);
  assert.deepEqual(selectTests([file], { include: [file], exclude: [first] }), [second]);
  assert.deepEqual(selectTests([file], { include: [first], exclude: [file] }), []);
});

test('independent test modules and project bindings cannot capture the test wrapper', async t => {
  const text = '#lang racket/base\n(error "parent must not run")\n(module test racket/base\n(require rackunit)\n' +
    '(define let 1) (define local-require 2) (define only-in 3) (define file 4)\n' +
    '(test-case "skip" (error "not selected"))\n(test-case "selected" (check-equal? (+ let local-require only-in file) 10)))\n';
  const cases = await discover(text);
  assert.equal(cases.length, 2);
  for (const noDebug of [true, false]) {
    const { client } = await launch(t, text, [cases[1].id], { noDebug });
    await ok(client.request('configurationDone'));
    assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
      { kind: 'summary', status: 'passed', failed: 0, total: 1 });
    await client.event('terminated');
  }
});

test('whole-file runs report separate case outcomes and retain RackUnit check control flow', async t => {
  const text = '#lang racket/base\n(require rackunit)\n' +
    '(test-case "pass" (check-true #t))\n' +
    '(test-case "fail" (check-equal? 1 2) (error "must not reach"))\n';
  const { client } = await launch(t, text);
  await ok(client.request('configurationDone'));
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'failed', failed: 1, total: 2 });
  await client.event('terminated');
  assert.deepEqual(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case')
    .map(e => [e.body.name, e.body.status]), [['pass', 'started'], ['pass', 'passed'], ['fail', 'started'], ['fail', 'failed']]);
});
