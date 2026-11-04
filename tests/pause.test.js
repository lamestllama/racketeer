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
async function ok(promise) {
  const response = await promise;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function prepare(t, lines, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-pause-'));
  const program = path.join(dir, 'main.rkt');
  await fs.writeFile(program, lines.join('\n') + '\n');
  const client = new DapClient();
  t.after(async () => { await client.close(); await fs.rm(dir, treeRemoval); });
  await ok(client.request('initialize'));
  await ok(client.request('launch', { program, cwd: dir, stopOnEntry: true, ...config }));
  await client.event('initialized');
  await ok(client.request('configurationDone'));
  const entry = await client.event('stopped');
  await ok(client.request('continue', { threadId: entry.body.threadId }));
  return { client, program, dir, threadId: entry.body.threadId };
}
async function suspend(client, threadId) {
  await ok(client.request('pause', { threadId }));
  const outcome = await until(() => {
    if (client.fatalError) throw client.fatalError;
    const index = client.events.findIndex(e => (e.event === 'stopped' && !e.body.preserveFocusHint) || e.event === 'terminated');
    return index >= 0 && client.events.splice(index, 1)[0];
  }, 'Pause must respond with a stopped event');
  assert.equal(outcome.event, 'stopped', 'Pause must not terminate the program');
  assert.equal(outcome.body.reason, 'pause');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: outcome.body.threadId }));
  return { ...stackFrames[0], threadId: outcome.body.threadId, stop: outcome.body };
}

test('Pause bypasses application break handlers and preserves a blocked continuation', async t => {
  const { client, threadId } = await prepare(t, [
    '#lang racket/base', '(define gate (make-semaphore))',
    '(define caught 0)', '(define enters 0)', '(define leaves 0)',
    '(define label (make-parameter "outside"))',
    '(define (work x)',
    '  (parameterize ([label "inside"])',
    '    (with-handlers ([exn:break? (lambda (_) (set! caught (add1 caught)))])',
    '      (dynamic-wind',
    '        (lambda () (set! enters (add1 enters)))',
    '        (lambda () (displayln "waiting") (flush-output) (semaphore-wait gate) (displayln x))',
    '        (lambda () (set! leaves (add1 leaves)))))))',
    '(work 7)', '(displayln (list caught enters leaves))'
  ]);
  await client.event('output', e => e.body.output.includes('waiting'));
  for (let n = 0; n < 3; n++) {
    const frame = await suspend(client, threadId);
    const result = await ok(client.request('evaluate', {
      frameId: frame.id, expression: '(format "~s" (list x caught enters leaves (label)))'
    }));
    assert.equal(result.result, '"(7 0 1 0 \\"inside\\")"');
    if (n === 2) await ok(client.request('evaluate', {
      frameId: frame.id, expression: '(begin (set! x 19) (semaphore-post gate))'
    }));
    await ok(client.request('continue', { threadId }));
    assert.equal((await client.request('scopes', { frameId: frame.id })).success, false);
  }
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join('');
  assert.equal(output, '19\n(0 1 1)\n');
});

test('Pause and Continue preserve a running world event loop', {
  skip: process.platform === 'linux' && !process.env.DISPLAY
}, async t => {
  const { client, threadId, dir } = await prepare(t, [
    '#lang racket/base', '(require 2htdp/image 2htdp/universe)',
    '(define (tick n)',
    '  (when (= n 0) (displayln "ticking") (flush-output))',
    '  (add1 n))',
    '(define result',
    '  (big-bang 0 [on-tick tick 1/20]',
    '    [to-draw (lambda (n) (text (number->string n) 18 "black"))]',
    '    [name "Pause regression"]',
    '    [stop-when (lambda (_) (file-exists? "finish"))]',
    '    [close-on-stop #t]))',
    '(displayln (list \'finished (positive? result)))'
  ]);
  await client.event('output', e => e.body.output.includes('ticking'));
  for (let n = 0; n < 2; n++) {
    const frame = await suspend(client, threadId);
    assert.equal(frame.stop.racketdapApproximate, false, 'Pause reaches an executing callback');
    assert.notEqual(frame.threadId, threadId, 'Focus moves from the waiting main thread to game code');
    assert.equal((await ok(client.request('threads'))).threads.some(t => t.id === threadId), true);
    for (const command of ['next', 'stepIn', 'next', 'stepOut']) {
      await ok(client.request(command, { threadId: frame.threadId }));
      const step = await client.event('stopped', e => !e.body.preserveFocusHint);
      assert.equal(step.body.reason, 'step');
      assert.equal(step.body.threadId, frame.threadId);
    }
    await ok(client.request('continue', { threadId: frame.threadId }));
  }
  const { threads } = await ok(client.request('threads'));
  const callbackThread = threads.find(t => t.id !== threadId);
  assert.ok(callbackThread, 'The GUI callback has its own registered thread');
  await suspend(client, callbackThread.id);
  await ok(client.request('continue', { threadId: callbackThread.id }));
  await fs.writeFile(path.join(dir, 'finish'), 'done');
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  assert.match(client.events.filter(e => e.event === 'output').map(e => e.body.output).join(''), /\(finished #t\)/);
});

test('Pause focuses executing source, holds other threads, and cancels pending fallback on Continue', async t => {
  const { client, threadId } = await prepare(t, [
    '#lang racket/base', '(define gate (make-semaphore))', '(define total 0)',
    '(define worker (thread (lambda () (let loop ()',
    '  (set! total (add1 total)) (sleep 0.02) (loop)))))',
    '(displayln "waiting") (flush-output)', '(semaphore-wait gate)', '(thread-wait worker)'
  ]);
  await client.event('output', e => e.body.output.includes('waiting'));
  for (let round = 0; round < 3; round++) {
    const frame = await suspend(client, threadId);
    assert.notEqual(frame.threadId, threadId);
    assert.equal(frame.stop.racketdapApproximate, false);
    const inspect = expression => ok(client.request('evaluate', { frameId: frame.id, expression }));
    const initial = (await inspect('total')).result;
    if (round === 0) {
      const waiting = await client.event('stopped', e => e.body.threadId === threadId);
      assert.equal(waiting.body.preserveFocusHint, true);
      assert.equal(waiting.body.racketdapApproximate, true);
      const waitingFrame = (await ok(client.request('stackTrace', { threadId }))).stackFrames[0];
      assert.ok(waitingFrame);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal((await inspect('total')).result, initial, 'Source remains stopped while inspecting');
      await ok(client.request('next', { threadId: frame.threadId, singleThread: true }));
      assert.equal((await client.event('stopped')).body.reason, 'step');
      assert.equal((await ok(client.request('evaluate', {
        frameId: waitingFrame.id, expression: '(semaphore? gate)'
      }))).result, '#t', 'Single-thread stepping leaves the waiting thread inspectable');
    }
    const resumed = await client.request('continue', { threadId: frame.threadId });
    assert.equal(resumed.success, true, resumed.message);
    await new Promise(resolve => setTimeout(resolve, 150));
    // The waiting thread's fallback stop may legitimately precede Continue on a
    // slow host; Continue resumes it. Messages are ordered by sequence number,
    // so only a stop after the Continue response is a suspension Continue missed.
    const stops = client.events.filter(e => e.event === 'stopped');
    client.events = client.events.filter(e => e.event !== 'stopped');
    for (const stop of stops.filter(e => e.seq < resumed.seq)) {
      assert.equal(stop.body.threadId, threadId);
      assert.equal(stop.body.racketdapApproximate, true);
    }
    assert.deepEqual(stops.filter(e => e.seq > resumed.seq), [], 'Continue cancels delayed suspension');
  }
  await ok(client.request('terminate'));
  await client.event('terminated');
});

test('cancelling inspection during Pause leaves the enclosing interactive call resumable', async t => {
  const { client, threadId } = await prepare(t, [
    '#lang racket/base', '(define gate (make-semaphore))',
    '(define (work x) (displayln "waiting") (flush-output) (semaphore-wait gate) x)'
  ], { interactive: true });
  await client.event('racketdap/ready');
  let completed = false;
  const outer = client.request('evaluate', { expression: '(work 7)' }).then(r => { completed = true; return r; });
  await client.event('output', e => e.body.output.includes('waiting'));
  const frame = await suspend(client, threadId);
  const inner = client.request('evaluate', {
    frameId: frame.id, expression: '(begin (displayln "inspecting") (flush-output) (sync never-evt))'
  });
  await client.event('output', e => e.body.output.includes('inspecting'));
  assert.equal((await ok(client.request('racketdap/cancelEvaluation'))).cancelled, 1);
  assert.equal((await inner).success, false);
  assert.equal(completed, false);
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'x' }))).result, '7');
  await ok(client.request('evaluate', { frameId: frame.id, expression: '(begin (set! x 13) (semaphore-post gate))' }));
  await ok(client.request('continue', { threadId }));
  assert.equal((await ok(outer)).result, '13');
  await ok(client.request('terminate'));
  await client.event('terminated');
});
