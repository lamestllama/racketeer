// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const hash = text => createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex');
async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function fixture(t, source, helper) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-coverage-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'main.rkt');
  await fs.writeFile(program, source);
  if (helper) await fs.writeFile(path.join(directory, 'helper.rkt'), helper);
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap', linesStartAt1: false, columnsStartAt1: false }));
  return { client, program, directory };
}
async function run(client, program, options = {}) {
  await ok(client.request('launch', { program, noDebug: true, testMode: true, coverage: true, ...options }));
  await client.event('initialized');
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 2 }] }));
  await ok(client.request('configurationDone'));
  await client.event('terminated');
  assert.equal(client.events.some(event => event.event === 'stopped'), false, 'coverage never pauses at debugger breakpoints');
  return client.events.filter(event => event.event === 'racketdap/coverage').map(event => event.body);
}
function expression(report, text, expected) {
  const lines = text.split(/\r?\n/);
  const matches = report.statements.filter(s => s.line === s.endLine && lines[s.line].slice(s.column, s.endColumn) === expected);
  assert.equal(matches.length, 1, `Expected one source expression: ${expected}`);
  return matches[0];
}

test('coverage records both taken and untaken expressions across files with CRLF and UTF-16 coordinates', async t => {
  const helper = '#lang racket/base\r\n(provide choose)\r\n' +
    '(define (choose x) (let ([😀 1]) (if (> x 0) (+ x 😀) (- x 😀))))\r\n' +
    '(define (unused) (displayln "unreached"))\r\n';
  const source = '#lang racket/base\n(require "helper.rkt" rackunit)\n(module+ test (test-case "positive" (check-equal? (choose 2) 3)))\n';
  const { client, program, directory } = await fixture(t, source, helper);
  const reports = await run(client, program);
  assert.equal(reports.length, 2);
  const report = reports.find(file => file.path === path.join(directory, 'helper.rkt'));
  assert.equal(report.sourceHash, hash(helper));
  assert.equal(expression(report, helper, '(+ x 😀)').executed, true);
  assert.equal(expression(report, helper, '(- x 😀)').executed, false);
  assert.equal(expression(report, helper, '(displayln "unreached")').executed, false);
  assert.equal(new Set(report.statements.map(s => `${s.line}:${s.column}:${s.endLine}:${s.endColumn}`)).size, report.statements.length);
  assert.ok(report.statements.every(s => typeof s.executed === 'boolean'));
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'passed');
});

test('coverage respects selected cases and remains available for assertion failures', async t => {
  const source = '#lang racket/base\n(require rackunit)\n(define (choose x) (if x (+ 1 2) (- 1 2)))\n' +
    '(module+ test\n(test-case "first" (check-equal? (choose #t) 3))\n(test-case "second" (check-equal? (choose #f) 0)))\n';
  const { client, program } = await fixture(t, source);
  const reports = await run(client, program, { testSelection: {
    sourceHash: hash(source), ids: [source.indexOf('(test-case "second"') + 1]
  } });
  assert.equal(expression(reports[0], source, '(+ 1 2)').executed, false);
  assert.equal(expression(reports[0], source, '(- 1 2)').executed, true);
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'failed');
});

test('coverage includes untaken literal and reference branches and unused constant function bodies', async t => {
  const source = '#lang racket/base\n(require rackunit)\n' +
    '(define (choose flag) (if flag \'left \'right))\n' +
    '(define (identity flag yes no) (if flag yes no))\n' +
    '(define (unused) 42)\n' +
    '(check-equal? (choose #t) \'left)\n(check-equal? (identity #t 1 2) 1)\n';
  const { client, program } = await fixture(t, source);
  const [report] = await run(client, program);
  assert.equal(expression(report, source, "'right").executed, false);
  assert.equal(expression(report, source, 'yes').executed, true);
  assert.equal(expression(report, source, 'no').executed, false);
  assert.equal(expression(report, source, '42').executed, false);
  assert.equal((await client.event('racketdap/test', e => e.body.kind === 'summary')).body.status, 'passed');
});

test('coverage preserves multiple values, quoted data, evaluation order and tail recursion', async t => {
  const source = '#lang racket/base\n(require rackunit)\n' +
    '(define count 0)\n(define (bump) (set! count (add1 count)) count)\n' +
    '(check-equal? (list (bump) (bump) (bump)) \'(1 2 3))\n' +
    '(check-equal? (call-with-values (lambda () (if #t (values 3 4) (values))) list) \'(3 4))\n' +
    '(check-equal? (call-with-values (lambda () (values)) list) \'())\n' +
    '(check-equal? (let loop ([n 2000]) (if (zero? n) \'done (loop (sub1 n)))) \'done)\n';
  const { client, program } = await fixture(t, source);
  await run(client, program);
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'passed', total: 4, failed: 0 });
});

// Coverage records only whether each expression ran. Recording a visit must not
// inspect the continuation, whose cost grows with the depth of the stack.
test('a range holding written code is covered only if that code ran, not generated code located at it', async t => {
  const source = '#lang racket/base\n(require rackunit (for-syntax racket/base))\n' +
    '(define-syntax (guarded stx)\n' +
    '  (syntax-case stx ()\n' +
    "    [(_ e) #`(begin #,(syntax/loc #'e (void)) (if #f e 0))]))\n" +
    '(define (use) (guarded (list 1)))\n' +
    '(check-equal? (use) 0)\n';
  const { client, program } = await fixture(t, source);
  const [report] = await run(client, program);
  assert.equal(expression(report, source, '(list 1)').executed, false);
});

test('coverage cost does not grow with recursion depth', { timeout: 30000 }, async t => {
  const source = '#lang racket/base\n(require rackunit)\n' +
    '(define (depth n) (if (zero? n) 0 (add1 (depth (sub1 n)))))\n' +
    '(check-equal? (depth 10000) 10000)\n';
  const { client, program } = await fixture(t, source);
  const [report] = await run(client, program);
  assert.equal(expression(report, source, '(add1 (depth (sub1 n)))').executed, true);
  assert.deepEqual((await client.event('racketdap/test', e => e.body.kind === 'summary')).body,
    { kind: 'summary', status: 'passed', total: 1, failed: 0 });
});

test('ordinary runs and incomplete test processes do not publish coverage', async t => {
  for (const [source, options] of [
    ['#lang racket/base\n(require rackunit)\n(check-true #t)\n', { coverage: false }],
    ['#lang racket/base\n(module+ test (exit 0))\n', {}],
    ['#lang racket/base\n(error "setup failed")\n', {}]
  ]) {
    const { client, program } = await fixture(t, source);
    assert.deepEqual(await run(client, program, options), []);
  }
});

test('coverage launch rejects incompatible modes before starting a worker', async t => {
  const { client, program } = await fixture(t, '#lang racket/base\n');
  for (const options of [{}, { testMode: true }, { noDebug: true }, { coverage: 'true', noDebug: true, testMode: true }]) {
    const result = await client.request('launch', { program, coverage: true, ...options });
    assert.equal(result.success, false);
    assert.match(result.message, /coverage requires/);
  }
});

test('coverage retains the executed snapshot when a test replaces its own source', async t => {
  const source = '#lang racket/base\n(require rackunit racket/runtime-path)\n' +
    '(define-runtime-path self "main.rkt")\n' +
    '(module+ test (test-case "replace"\n' +
    '  (call-with-output-file self #:exists \'truncate (lambda (out) (display "changed" out)))\n' +
    '  (check-equal? (+ 1 2) 3)))\n';
  const { client, program } = await fixture(t, source);
  const [report] = await run(client, program);
  assert.equal(await fs.readFile(program, 'utf8'), 'changed');
  assert.equal(report.sourceHash, hash(source));
  assert.equal(expression(report, source, '(+ 1 2)').executed, true);
});

async function coverageApi() {
  const documents = [], contents = new Map();
  const vscode = {
    Uri: { file: file => ({ fsPath: file, toString: () => file }) },
    Range: class { constructor(...positions) { this.positions = positions; } },
    StatementCoverage: class { constructor(executed, location) { Object.assign(this, { executed, location }); } },
    FileCoverage: class { constructor(uri, statementCoverage) { Object.assign(this, { uri, statementCoverage }); } },
    workspace: { textDocuments: documents, fs: { readFile: async uri => {
      if (!contents.has(uri.fsPath)) throw new Error('deleted');
      return Buffer.from(contents.get(uri.fsPath));
    } } }
  };
  const filename = path.resolve(__dirname, '../vscode/test-coverage.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, Buffer, require: name => name === 'vscode' ? vscode : localRequire(name)
  }, { filename });
  return { ...module.exports, contents, documents, vscode };
}
const statement = executed => ({ line: 1, column: 2, endLine: 1, endColumn: 9, executed });
const uncancelled = { isCancellationRequested: false };
function testRun() {
  return { files: [], messages: [], addCoverage(file) { this.files.push(file); }, appendOutput(message) { this.messages.push(message); } };
}

test('native coverage unions shared-file results and keeps completed runs independent', async () => {
  const api = await coverageApi(), result = new api.TestCoverage(), run = testRun();
  api.contents.set('/helper.rkt', 'source\r\n');
  const report = { path: '/helper.rkt', sourceHash: hash('source\n'), statements: [statement(false)] };
  result.add(report); result.add({ ...report, statements: [statement(true)] }); result.add(report);
  await result.publish(run, uncancelled);
  assert.deepEqual({ ...run.files[0].statementCoverage }, { covered: 1, total: 1 });
  const details = await api.loadDetailedCoverage(run, run.files[0], uncancelled);
  assert.equal(details.length, 1); assert.equal(details[0].executed, true);
  const next = new api.TestCoverage(), nextRun = testRun(); next.add(report); await next.publish(nextRun, uncancelled);
  assert.equal(nextRun.files[0].statementCoverage.covered, 0);
  assert.equal((await api.loadDetailedCoverage(run, run.files[0], uncancelled))[0].executed, true);
});

test('coverage omits mixed revisions, changed buffers and deleted sources, including delayed detail requests', async () => {
  const api = await coverageApi(), run = testRun(), result = new api.TestCoverage();
  for (const name of ['mixed', 'buffer', 'deleted', 'later']) {
    const file = `/${name}.rkt`; api.contents.set(file, 'original');
    result.add({ path: file, sourceHash: hash('original'), statements: [statement(true)] });
  }
  result.add({ path: '/mixed.rkt', sourceHash: hash('changed'), statements: [statement(false)] });
  result.add({ path: '/mixed.rkt', sourceHash: hash('original'), statements: [statement(true)] });
  api.documents.push({ uri: api.vscode.Uri.file('/buffer.rkt'), getText: () => 'unsaved' });
  api.contents.delete('/deleted.rkt');
  await result.publish(run, uncancelled);
  assert.equal(run.files.length, 1); assert.equal(run.files[0].uri.fsPath, '/later.rkt');
  assert.equal(run.messages.length, 3);
  api.contents.set('/later.rkt', 'changed');
  assert.equal((await api.loadDetailedCoverage(run, run.files[0], uncancelled)).length, 0);
});

test('cancellation during asynchronous source verification suppresses coverage publication', async () => {
  const api = await coverageApi(), result = new api.TestCoverage(), run = testRun();
  result.add({ path: '/file.rkt', sourceHash: hash('source'), statements: [statement(true)] });
  const token = { isCancellationRequested: false };
  api.vscode.workspace.fs.readFile = async () => { token.isCancellationRequested = true; return Buffer.from('source'); };
  await result.publish(run, token);
  assert.equal(run.files.length, 0);
});
