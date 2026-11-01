// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DapClient } = require('./dap-client');
async function ok(p) { const r = await p; assert.equal(r.success, true, r.message); return r.body; }
async function prepare(t, lines, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-parity-'));
  const program = path.join(dir, 'target.rkt');
  await fs.writeFile(program, lines.join('\n') + '\n');
  const client = new DapClient();
  t.after(async () => { await client.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await ok(client.request('initialize', { linesStartAt1: true, columnsStartAt1: true }));
  await ok(client.request('launch', { program, cwd: dir, ...config }));
  await client.event('initialized');
  return { client, program };
}
async function stopped(client) {
  const event = await client.event('stopped');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: event.body.threadId }));
  return { ...event.body, frame: stackFrames[0] };
}
async function results(client, frame) {
  const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
  const scope = scopes.find(s => s.name.startsWith('Return values'));
  assert.ok(scope);
  return { name: scope.name, reference: scope.variablesReference, values: (await ok(client.request('variables', { variablesReference: scope.variablesReference }))).variables.map(v => v.value) };
}
async function finished(client) {
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  return client.events.filter(e => e.event === 'output' && e.body.category === 'stdout').map(e => e.body.output).join('');
}

test('skip and replace preserve multiple values, skipped effects, live Return values, and failed-edit recovery', async t => {
  const lines = ['#lang racket/base', '(define effects 0)',
    '(define-values (a b) (begin (set! effects (add1 effects)) (values 1 2)))',
    '(displayln (list effects a b))'];
  const { client, program } = await prepare(t, lines);
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3, column: lines[2].indexOf('(begin') + 1 }] }));
  await ok(client.request('configurationDone'));
  let s = await stopped(client);
  assert.equal(s.racketdapStopKind, 'before');
  assert.ok(s.racketdapActions.includes('racketdap/skipExpression'));
  assert.ok(s.racketdapActions.includes('racketdap/continueToLocation'));
  assert.ok(!s.racketdapActions.includes('racketdap/replaceResults'));
  assert.ok(!s.racketdapActions.includes('racketdap/printResults'));
  for (const command of ['unknownRequest', 'internalContinue']) {
    const rejected = await client.request(command, { threadId: s.threadId });
    assert.equal(rejected.success, false);
    assert.match(rejected.message, /Unsupported request/);
  }
  assert.equal((await client.request('racketdap/replaceResults', { threadId: s.threadId, expression: '0' })).success, false);
  assert.equal((await ok(client.request('racketdap/skipExpression', { frameId: s.frame.id, expression: '(values 8 9)' }))).result, '8\n9');
  await ok(client.request('next', { threadId: s.threadId }));
  s = await stopped(client);
  assert.equal(s.racketdapStopKind, 'after');
  assert.ok(!s.racketdapActions.includes('racketdap/skipExpression'));
  assert.ok(s.racketdapActions.includes('racketdap/replaceResults'));
  assert.ok(s.racketdapActions.includes('racketdap/printResults'));
  const original = await results(client, s.frame); assert.deepEqual(original.values, ['8', '9']);
  assert.equal(original.name, 'Return values (2)');
  assert.equal((await client.request('racketdap/skipExpression', { threadId: s.threadId, expression: '0' })).success, false);
  await ok(client.request('racketdap/replaceResults', { threadId: s.threadId, expression: '(values)' }));
  const invalidated = await client.event('invalidated', event => event.body.areas.includes('stacks'));
  assert.equal(invalidated.body.threadId, s.threadId);
  const refreshed = await ok(client.request('stackTrace', { threadId: s.threadId }));
  assert.match(refreshed.stackFrames[0].name, /^Returned 0 values at /);
  const noValues = await results(client, refreshed.stackFrames[0]);
  assert.equal(noValues.name, 'Return values (0)');
  assert.deepEqual(noValues.values, []);
  await ok(client.request('racketdap/replaceResults', { threadId: s.threadId, expression: '(values 40 50)' }));
  assert.equal((await client.request('racketdap/replaceResults', { threadId: s.threadId, expression: '(error "bad edit")' })).success, false);
  assert.deepEqual((await ok(client.request('variables', { variablesReference: original.reference }))).variables.map(v => v.value), ['40', '50']);
  await ok(client.request('racketdap/printResults', { threadId: s.threadId }));
  await client.event('output', e => e.body.category === 'console' && e.body.output === '40\n50\n');
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '(0 40 50)\n');
});

test('closing-parenthesis breakpoints stop at completion and expose replaceable results', async t => {
  const lines = ['#lang racket/base', '(define x (+ 1 2))', '(displayln x)'];
  const { client, program } = await prepare(t, lines);
  const end = lines[1].indexOf(')') + 1;
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 2, column: end }] }));
  await ok(client.request('configurationDone'));
  const s = await stopped(client); assert.equal(s.racketdapStopKind, 'after');
  assert.equal(s.frame.column, end);
  assert.equal(s.frame.endColumn, end + 1);
  const returned = await results(client, s.frame);
  assert.equal(returned.name, 'Return values (1)');
  assert.deepEqual(returned.values, ['3']);
  const locations = await ok(client.request('breakpointLocations', { source: { path: program }, line: 2 }));
  assert.ok(locations.breakpoints.some(b => b.column === end && b.racketdapPhase === 'after'));
  await ok(client.request('racketdap/replaceResults', { threadId: s.threadId, expression: '7' }));
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '7\n');
});

test('continue-to is one-time, preserves ordinary breakpoints, and can target completion', async t => {
  const lines = ['#lang racket/base', '(define marker (+ 0 0))',
    '(for ([i (in-range 2)])', '  (displayln (+ i 10)))'];
  const { client, program } = await prepare(t, lines, { stopOnEntry: true });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 4, column: lines[3].indexOf('(+') + 1, condition: '(= i 1)' }] }));
  await ok(client.request('configurationDone'));
  let s = await stopped(client);
  const invalid = await client.request('racketdap/continueToLocation', { threadId: s.threadId, source: { path: program }, line: 99 });
  assert.equal(invalid.success, false);
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, expression: '42' }))).result, '42');
  await ok(client.request('racketdap/continueToLocation', { threadId: s.threadId, source: { path: program }, line: 4, column: lines[3].indexOf(')') + 1 }));
  s = await stopped(client); assert.equal(s.reason, 'goto'); assert.equal(s.racketdapStopKind, 'after');
  assert.deepEqual((await results(client, s.frame)).values, ['10']);
  await ok(client.request('continue', { threadId: s.threadId }));
  s = await stopped(client); assert.equal(s.reason, 'breakpoint');
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, expression: 'i' }))).result, '1');
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '10\n11\n');
});

test('single expression steps include completion stops', async t => {
  const lines = ['#lang racket/base', '(define x (+ 1 2))', '(displayln x)'];
  const { client } = await prepare(t, lines, { stopOnEntry: true });
  await ok(client.request('configurationDone'));
  let s = await stopped(client); assert.equal(s.racketdapStopKind, 'before');
  await ok(client.request('stepIn', { threadId: s.threadId }));
  s = await stopped(client); assert.equal(s.racketdapStopKind, 'after');
  assert.deepEqual((await results(client, s.frame)).values, ['3']);
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '3\n');
});

test('Pause interrupts a blocked primitive, keeps live locals, and resumes without unwinding', async t => {
  const lines = ['#lang racket/base', '(define gate (make-semaphore))',
    '(define enters 0)', '(define leaves 0)',
    '(define (run x)', '  (dynamic-wind',
    '    (lambda () (set! enters (add1 enters)))',
    '    (lambda ()', '      (displayln "waiting") (flush-output)',
    '      (semaphore-wait gate)', '      (displayln x))',
    '    (lambda () (set! leaves (add1 leaves)))))',
    '(run 7)', '(displayln (list enters leaves))'];
  const { client } = await prepare(t, lines);
  await ok(client.request('configurationDone'));
  await client.event('output', e => e.body.output.includes('waiting'));
  const { threads } = await ok(client.request('threads'));
  await ok(client.request('pause', { threadId: threads[0].id }));
  const s = await stopped(client);
  assert.equal(s.reason, 'pause');
  assert.equal(s.racketdapStopKind, 'pause');
  assert.equal(s.racketdapApproximate, true);
  assert.deepEqual(s.racketdapActions, ['racketdap/continueToLocation', 'racketdap/printBinding', 'racketdap/setBinding']);
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, expression: '(format "~s" (list x enters leaves))' }))).result, '"(7 1 0)"');
  assert.equal((await client.request('racketdap/skipExpression', { threadId: s.threadId, expression: '0' })).success, false);
  await ok(client.request('evaluate', { frameId: s.frame.id, expression: '(begin (set! x 19) (semaphore-post gate))' }));
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '19\n(1 1)\n');
});

test('non-module launch retains source breakpoints and the interaction namespace', async t => {
  const lines = ['(define (answer x) (+ x 1))', '(displayln (answer 4))'];
  const { client, program } = await prepare(t, lines, { language: 'racket/base', interactive: true });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 1, column: 20 }] }));
  await ok(client.request('configurationDone'));
  const s = await stopped(client);
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, expression: 'x' }))).result, '4');
  await ok(client.request('continue', { threadId: s.threadId }));
  await client.event('racketdap/ready');
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [] }));
  assert.equal((await ok(client.request('evaluate', { expression: '(answer 9)' }))).result, '10');
  await ok(client.request('terminate'));
  await client.event('terminated');
});

test('Pause can interrupt and resume an interactive call into instrumented code', async t => {
  const lines = ['#lang racket/base', '(define gate (make-semaphore))',
    '(define (wait x) (displayln "waiting") (flush-output) (semaphore-wait gate) x)'];
  const { client } = await prepare(t, lines, { interactive: true });
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  const pending = ok(client.request('evaluate', { expression: '(wait 7)' }));
  await client.event('output', e => e.body.output.includes('waiting'));
  const { threads } = await ok(client.request('threads'));
  await ok(client.request('pause', { threadId: threads[0].id }));
  const s = await stopped(client); assert.equal(s.racketdapStopKind, 'pause');
  await ok(client.request('evaluate', { frameId: s.frame.id, expression: '(begin (set! x 13) (semaphore-post gate))' }));
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal((await pending).result, '13');
  await ok(client.request('terminate'));
  await client.event('terminated');
});

test('module variable hover, printing, and assignment use the selected live binding', async t => {
  const lines = ['#lang racket/base', '(require (for-syntax racket/base))', '(define hidden 3)',
    '(define-syntax (danger stx) (error "hover ran a macro"))',
    '(define (run x) (+ x 1))', '(displayln (run 4))', '(displayln hidden)'];
  const { client, program } = await prepare(t, lines);
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 5, column: 17 }] }));
  await ok(client.request('configurationDone'));
  const s = await stopped(client);
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, context: 'hover', expression: 'hidden' }))).result, '3');
  const { scopes } = await ok(client.request('scopes', { frameId: s.frame.id }));
  const locals = scopes.find(scope => scope.name === 'Locals').variablesReference;
  const invalidLocal = await client.request('setVariable', {
    variablesReference: locals, name: 'hidden', value: '(begin (set! hidden 99) 0)'
  });
  assert.equal(invalidLocal.success, false);
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, context: 'hover', expression: 'hidden' }))).result, '3');
  assert.equal((await ok(client.request('setVariable', { variablesReference: locals, name: 'x', value: '8' }))).value, '8');
  const rejected = await client.request('evaluate', { frameId: s.frame.id, context: 'hover', expression: 'danger' });
  assert.equal(rejected.success, false); assert.doesNotMatch(rejected.message, /hover ran a macro/);
  await ok(client.request('racketdap/printBinding', { frameId: s.frame.id, name: 'hidden' }));
  await client.event('output', e => e.body.category === 'console' && e.body.output === '3\n');
  assert.equal((await ok(client.request('racketdap/setBinding', { frameId: s.frame.id, name: 'hidden', expression: '(+ x 20)' }))).result, '28');
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '9\n28\n');
});

test('cancelling an expression action keeps its pending result and live frame usable', async t => {
  const lines = ['#lang racket/base', '(define x (+ 1 2))', '(displayln x)'];
  const { client } = await prepare(t, lines, { stopOnEntry: true });
  await ok(client.request('configurationDone'));
  let s = await stopped(client);
  await ok(client.request('next', { threadId: s.threadId }));
  s = await stopped(client);
  const pending = client.request('racketdap/replaceResults', {
    threadId: s.threadId, expression: '(begin (displayln "editing") (flush-output) (sync never-evt))'
  });
  const requestId = client.sequence;
  await client.event('output', e => e.body.output.includes('editing'));
  await ok(client.request('cancel', { requestId }));
  const cancelled = await pending;
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.message, 'cancelled');
  assert.deepEqual((await results(client, s.frame)).values, ['3']);
  assert.equal((await ok(client.request('evaluate', { frameId: s.frame.id, expression: '42' }))).result, '42');
  await ok(client.request('continue', { threadId: s.threadId }));
  assert.equal(await finished(client), '3\n');
});
