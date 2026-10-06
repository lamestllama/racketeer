'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
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
  const client = new DapClient(undefined, { timeout: 30000 });
  t.after(async () => { await client.close(); await fs.rm(dir, { recursive: true, force: true }); });
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
  const deadline = Date.now() + 30000;
  let outcome;
  while (!outcome && Date.now() < deadline) {
    if (client.fatalError) throw client.fatalError;
    const index = client.events.findIndex(e => e.event === 'stopped' || e.event === 'terminated');
    if (index >= 0) outcome = client.events.splice(index, 1)[0];
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(outcome, 'Pause must respond with a stopped event');
  assert.equal(outcome.event, 'stopped', 'Pause must not terminate the program');
  assert.equal(outcome.body.reason, 'pause');
  assert.equal(outcome.body.threadId, threadId);
  const { stackFrames } = await ok(client.request('stackTrace', { threadId }));
  return stackFrames[0];
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
    assert.ok(frame, 'The waiting source call remains inspectable');
    assert.equal((await ok(client.request('threads'))).threads.some(t => t.id === threadId), true);
    await ok(client.request('continue', { threadId }));
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
