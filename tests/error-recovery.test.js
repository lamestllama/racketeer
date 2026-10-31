'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');

async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function prepare(t, source, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-error-recovery-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'recover.rkt');
  await fs.writeFile(program, source);
  const plain = spawnSync('racket', [program], { encoding: 'utf8' });
  assert.equal(plain.error, undefined);
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, stopOnEntry: false, ...options }));
  await client.event('initialized');
  return { client, program, plain };
}
function outputOf(client, category) {
  return client.events.filter(event => event.event === 'output' && event.body.category === category)
    .map(event => event.body.output).join('');
}

// A fresh program using the documented escape continuation and error handlers.
// The display handler records the failure before the escape handler recovers.
const recoverySource = [
  '#lang racket/base',
  '(define outcome',
  '  (call-with-escape-continuation',
  '   (lambda (resume)',
  '     (parameterize ([error-display-handler',
  '                     (lambda (message raised)',
  '                       (fprintf (current-error-port) "reported: ~a\\n" message))]',
  '                    [error-escape-handler (lambda () (resume \'rescued))])',
  '       (error \'calibration "retry requested")))))',
  '(printf "resume: ~a\\n" outcome)',
  '(displayln "module finished")', ''
].join('\n');

for (const [name, options, observe] of [
  ['debugging without exception stops', {}, false],
  ['Continue after an exception stop', {}, true],
  ['running without debugging', { noDebug: true }, false]
]) {
  test(`error escape recovery survives ${name}`, async t => {
    const { client, program, plain } = await prepare(t, recoverySource, options);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, 'resume: rescued\nmodule finished\n');
    assert.equal(plain.stderr, 'reported: calibration: retry requested\n');
    await ok(client.request('setExceptionBreakpoints', { filters: observe ? ['uncaught'] : [] }));
    await ok(client.request('configurationDone'));
    if (observe) {
      const stop = await client.event('stopped');
      assert.equal(stop.body.reason, 'exception');
      const { stackFrames } = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
      assert.equal(stackFrames[0].source.path, program);
      assert.equal(stackFrames[0].line, 9);
      assert.equal(outputOf(client, 'stderr'), '');
      await ok(client.request('continue', { threadId: stop.body.threadId }));
    }
    await client.event('terminated');
    assert.equal((await client.event('exited')).body.exitCode, plain.status);
    assert.equal(outputOf(client, 'stdout'), plain.stdout);
    assert.equal(outputOf(client, 'stderr'), plain.stderr);
    assert.ok(!client.events.some(event => event.event === 'stopped'));
  });
}

test('an unrecovered error reports in the user context once and exits unsuccessfully after Continue', async t => {
  const source = [
    '#lang racket/base',
    '(parameterize ([error-display-handler',
    '                (lambda (message raised)',
    '                  (fprintf (current-error-port) "failure: ~a\\n" message))])',
    '  (error \'calibration "cannot resume"))',
    '(displayln "unreachable")', ''
  ].join('\n');
  const { client, plain } = await prepare(t, source);
  assert.equal(plain.status, 1);
  await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
  await ok(client.request('configurationDone'));
  const stop = await client.event('stopped');
  assert.equal(stop.body.reason, 'exception');
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 1);
  assert.equal(outputOf(client, 'stdout'), '');
  assert.equal(outputOf(client, 'stderr'), plain.stderr);
  assert.ok(!client.events.some(event => event.event === 'stopped'));
});

for (const noDebug of [false, true]) {
  test(`an ordinary default-prompt abort preserves its thunk and exit status with noDebug=${noDebug}`, async t => {
    const source = [
      '#lang racket/base',
      '(abort-current-continuation',
      ' (default-continuation-prompt-tag)',
      ' (lambda () (displayln "abort thunk ran")))',
      '(displayln "unreachable")', ''
    ].join('\n');
    const { client, plain } = await prepare(t, source, { noDebug });
    assert.equal(plain.status, 1, plain.stderr);
    assert.equal(plain.stdout, 'abort thunk ran\n');
    await ok(client.request('configurationDone'));
    await client.event('terminated');
    assert.equal((await client.event('exited')).body.exitCode, plain.status);
    assert.equal(outputOf(client, 'stdout'), plain.stdout);
    assert.equal(outputOf(client, 'stderr'), plain.stderr);
  });
}
