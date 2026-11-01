// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
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
    '#lang racket\n(require rackunit)\n(for ([i 3]) (test-case "dynamic" (check-true #t)))']) {
    assert.deepEqual(await discover(source), [], source);
  }
});

test('inline suite discovery uses the runner range and never evaluates names, fixtures or tests', async () => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(define setup (error "discovery must not evaluate setup"))\n' +
    '(module+ test\n (run-tests (test-suite "same λ😀"\n' +
    '  #:before (error "must not evaluate fixture")\n' +
    '  (test-case "inner" (error "must not run"))) \'quiet))\n' +
    '(module+ test (test-case "same λ😀" (check-true #t)))\n';
  const found = await discover(source);
  assert.deepEqual(found.map(item => item.name), ['same λ😀', 'same λ😀']);
  assert.notEqual(found[0].id, found[1].id);
  assert.equal(found[0].position, source.indexOf('(run-tests') + 1);
  assert.equal(found[0].line, 4);
  assert.equal(found[0].column, 1);
  assert.equal(found[0].endLine, 6);
  assert.equal(found[0].endColumn, source.split('\n')[6].length - 1);
  for (const body of ['(test-suite "unrun" (test-case "case" (error "no")))',
    '(run-tests (test-suite "suite")) (displayln "mixed")',
    '(custom-runner (test-suite "suite"))']) {
    assert.deepEqual(await discover('#lang racket/base\n' + body), [], body);
  }
});

test('bound and computed suites are discovered without evaluating their construction', async () => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(define suite (error "must not evaluate"))\n(run-tests suite)\n' +
    '(run-tests (test-suite (error "dynamic name") (check-true #t)))\n' +
    '(run-tests (build-tests))\n';
  assert.deepEqual((await discover(source)).map(item => item.name), ['suite', 'RackUnit tests', 'RackUnit tests']);
});

test('runtime suite results distinguish duplicate and generated cases and preserve selective fixtures', async t => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(define suite (test-suite "outer λ"\n' +
    ' #:before (lambda () (displayln "before")) #:after (lambda () (displayln "after"))\n' +
    ' (test-suite "same" (test-case "duplicate" (displayln "first") (check-true #f)))\n' +
    ' (test-suite "same" (test-case "duplicate" (displayln "second") (check-true #t)))\n' +
    ' (for ([n (in-range 2)]) (test-case (format "dynamic ~a" n) (check-equal? n n)))))\n' +
    '(run-tests suite \'quiet)\n';
  const found = await discover(source);
  const full = await launch(t, source);
  await ok(full.client.request('configurationDone'));
  assert.deepEqual((await full.client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'failed', failed: 1, total: 4 });
  await full.client.event('terminated');
  const cases = full.client.events.filter(e => e.event === 'racketdap/test' && e.body.path && e.body.status === 'started').map(e => e.body);
  assert.deepEqual(cases.map(item => item.name), ['duplicate', 'duplicate', 'dynamic 0', 'dynamic 1']);
  assert.notDeepEqual(cases[0].path, cases[1].path);
  const failure = full.client.events.find(e => e.event === 'racketdap/test' && e.body.kind === 'failure');
  assert.equal(failure.body.location.line, 5);
  for (const mode of [{}, { noDebug: false }, { coverage: true }]) {
    const selected = await launch(t, source, undefined, { ...mode, testSelection: {
      sourceHash: createHash('sha1').update(source).digest('hex'), ids: [found[0].id],
      cases: [{ id: found[0].id, path: cases[1].path }]
    } });
    await ok(selected.client.request('configurationDone'));
    assert.deepEqual((await selected.client.event('racketdap/test', e => e.body.kind === 'summary')).body,
      { kind: 'summary', status: 'passed', failed: 0, total: 1 });
    await selected.client.event('terminated');
    const output = selected.client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
    assert.deepEqual(output.match(/before|first|second|after/g), ['before', 'second', 'after']);
    const results = selected.client.events.filter(e => e.event === 'racketdap/test' && e.body.path && e.body.status !== 'started');
    assert.deepEqual(results.map(e => e.body.status), ['skipped', 'passed', 'skipped', 'skipped']);
  }
});

test('changed dynamic names and missing cases error without running another case', async t => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(run-tests (test-suite "suite" (test-case "current" (error "wrong case executed"))))\n';
  const [{ id }] = await discover(source);
  for (const target of [[[0, 'suite'], [0, 'old']], [[0, 'suite'], [1, 'current']]]) {
    const { client } = await launch(t, source, undefined, { testSelection: {
      sourceHash: createHash('sha1').update(source).digest('hex'), ids: [id], cases: [{ id, path: target }]
    } });
    await ok(client.request('configurationDone'));
    assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
      { kind: 'summary', status: 'errored', failed: 0, total: 0 });
    await client.event('terminated');
    const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
    assert.match(output, /Selected tests changed or disappeared/);
    assert.doesNotMatch(output, /wrong case executed/);
  }
});

test('public suite constructors and case errors preserve native logging', async t => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(define suite (make-test-suite "custom" (list\n' +
    ' (make-test-case "error" (lambda () (error "case error")))\n' +
    ' (make-test-case "passes" (lambda () (check-true #t))))))\n(run-tests suite)\n';
  const { client, program } = await launch(t, source);
  const native = await promisify(execFile)('racket', ['-e',
    `(require raco/testing) (dynamic-require (string->path ${JSON.stringify(program)}) #f) (displayln (test-report))`]);
  assert.match(native.stdout, /\(1 \. 3\)/);
  await ok(client.request('configurationDone'));
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'failed', failed: 1, total: 3 });
  await client.event('terminated');
  assert.deepEqual(client.events.filter(e => e.event === 'racketdap/test' && e.body.path && e.body.status !== 'started')
    .map(e => e.body.status), ['errored', 'passed']);
  assert.equal(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'failure').length, 1);
});

test('selected suites retain nested execution, fixtures, counts and continued execution after failure', async t => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(module+ test\n (define value 0)\n' +
    ' (run-tests (test-suite "same" #:before (lambda () (error "unselected suite ran"))))\n' +
    ' (test-case "skip" (error "unselected case ran"))\n' +
    ' (run-tests (test-suite "same"\n' +
    '  #:before (lambda () (set! value 7) (displayln "suite-before"))\n' +
    '  #:after (lambda () (displayln "suite-after"))\n' +
    '  (test-suite "nested"\n' +
    '   (test-case "fails" (check-equal? value 8))\n' +
    '   (test-case "passes" (check-equal? value 7) (displayln "suite-continued")))) \'quiet))\n';
  const found = await discover(source);
  assert.deepEqual(found.map(item => item.name), ['same', 'skip', 'same']);
  for (const noDebug of [true, false]) {
    const { client } = await launch(t, source, [found[2].id], { noDebug });
    await ok(client.request('configurationDone'));
    assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
      { kind: 'summary', status: 'failed', failed: 1, total: 2 });
    await client.event('terminated');
    assert.deepEqual(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case' && !e.body.path)
      .map(e => [e.body.id, e.body.status]), [[found[2].id, 'started'], [found[2].id, 'failed']]);
    const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
    assert.deepEqual(output.match(/suite-(?:before|continued|after)/g),
      ['suite-before', 'suite-continued', 'suite-after']);
    assert.doesNotMatch(output, /unselected .* ran/);
  }
});

test('suite selection validates the public runner binding before setup and preserves custom whole-file calls', async t => {
  for (const definition of [
    '(define (run-tests suite) (displayln "custom runner"))'
  ]) {
    const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' + definition + '\n' +
      '(define setup (begin (displayln "setup executed") 1))\n(run-tests (test-suite "suite"))\n';
    const found = await discover(source);
    assert.equal(found.length, 1);
    const { client } = await launch(t, source, [found[0].id]);
    await ok(client.request('configurationDone'));
    assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'errored');
    await client.event('terminated');
    const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
    assert.match(output, /not RackUnit run-tests/);
    assert.doesNotMatch(output, /setup executed|custom runner|custom suite/);
    const whole = await launch(t, source);
    await ok(whole.client.request('configurationDone'));
    assert.equal((await whole.client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'passed');
    await whole.client.event('terminated');
    assert.match(whole.client.events.filter(e => e.event === 'output').map(e => e.body.output).join(''), /setup executed/);
    assert.equal(whole.client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case' && !e.body.path).length, 0);
  }
});

test('suite output honors quiet mode and native summary streams without hiding Test Explorer failures', async t => {
  for (const mode of ['quiet', 'normal']) for (const failing of [false, true]) {
    const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
      '(run-tests (test-suite "generated cases"\n' +
      ' #:before (lambda () (displayln "before"))\n' +
      ' #:after (lambda () (displayln "after"))\n' +
      ' (for ([n (in-range 3)])\n' +
      `  (test-case (number->string n) (displayln n) (check-true (< n ${failing ? 2 : 3}))))) '${mode})\n`;
    const { client, program } = await launch(t, source);
    const native = await promisify(execFile)('racket', [program]);
    await ok(client.request('configurationDone'));
    assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
      { kind: 'summary', status: failing ? 'failed' : 'passed', failed: Number(failing), total: 3 });
    await client.event('terminated');
    const output = category => client.events.filter(e => e.event === 'output' && e.body.category === category)
      .map(e => e.body.output).join('');
    const stdout = output('stdout');
    const stderr = output('stderr');
    assert.deepEqual(stdout.match(/before|[012]\n|after/g), native.stdout.match(/before|[012]\n|after/g));
    assert.equal(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'failure').length,
      Number(failing));
    if (mode === 'quiet') {
      assert.equal(stdout, native.stdout);
      assert.equal(stderr, native.stderr);
    } else {
      const summary = /3 tests, [01] failures\./;
      assert.match(failing ? stderr : stdout, summary);
      assert.doesNotMatch(failing ? stdout : stderr, summary);
      assert.match(failing ? native.stderr : native.stdout, /3 test\(s\) run/);
      if (failing) assert.match(stderr, /FAILURE[\s\S]*check-true/);
      else assert.equal(stderr, native.stderr);
    }
  }
});

test('a failing suite fixture never reports a passing suite', async t => {
  const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
    '(run-tests (test-suite "fixture error" #:before (lambda () (error "fixture failed"))\n' +
    ' (test-case "never" (error "case ran"))))\n';
  const found = await discover(source);
  const { client } = await launch(t, source, [found[0].id]);
  await ok(client.request('configurationDone'));
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'errored');
  await client.event('terminated');
  assert.ok(!client.events.some(e => e.event === 'racketdap/test' && e.body.status === 'passed'));
  const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
  assert.match(output, /fixture failed/);
  assert.doesNotMatch(output, /case ran/);
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
  assert.deepEqual(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case' && !e.body.path)
    .map(e => [e.body.id, e.body.status]), [[cases[1].id, 'started'], [cases[1].id, 'passed']]);
});

test('individual Debug Test retains live source breakpoints and RackUnit failure reporting', async t => {
  for (const [selected, individual] of [
    ['(test-case "selected" (check-equal? (twice 7) 15))', true],
    ['(run-tests (test-suite "selected" (test-case "inner" (check-equal? (twice 7) 15))))', false]]) {
    const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n(define (twice x)\n (* x 2))\n(module+ test\n' +
      ' (test-case "skip" (error "not selected"))\n ' + selected + ')\n';
    const cases = await discover(source);
    const { client, program } = await launch(t, source, [cases[1].id], { noDebug: false });
    await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 4 }] }));
    await ok(client.request('configurationDone'));
    const stop = await client.event('stopped');
    const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
    assert.equal(stackFrames[0].line, 4);
    assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'x' }))).result, '7');
    await ok(client.request('continue', { threadId: stop.body.threadId }));
    if (individual) {
      const failure = await client.event('racketdap/test', e => e.body.kind === 'failure');
      assert.equal(failure.body.location.line, 7);
    }
    assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.failed, 1);
    await client.event('terminated');
    if (!individual) {
      const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
      assert.match(output, /FAILURE/);
      assert.match(output, /cases[.]rkt:7:/);
    }
    assert.equal(client.events.filter(e => e.event === 'racketdap/test' && e.body.status === 'failed' && e.body.kind === 'case' && !e.body.path).length, 1);
  }
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
  assert.deepEqual(client.events.filter(e => e.event === 'racketdap/test' && e.body.kind === 'case' && !e.body.path)
    .map(e => [e.body.name, e.body.status]), [['pass', 'started'], ['pass', 'passed'], ['fail', 'started'], ['fail', 'failed']]);
});
