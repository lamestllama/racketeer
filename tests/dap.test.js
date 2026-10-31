'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const root = path.resolve(__dirname, '..');
const demo = path.join(root, 'examples/demo.rkt');
async function ok(promise) {
  const response = await promise;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function launch(client, program = demo, extra = {}) {
  await ok(client.request('initialize', { adapterID: 'racketdap', linesStartAt1: true, columnsStartAt1: true }, true));
  await ok(client.request('launch', { program, cwd: path.dirname(program), ...extra }));
  await client.event('initialized');
}
async function frame(client, stopped) {
  const stack = await ok(client.request('stackTrace', { threadId: stopped.body.threadId }));
  assert.ok(stack.stackFrames.length);
  return stack.stackFrames[0];
}
test('standalone adapter: break, inspect, evaluate, mutate, step, results, output, terminate', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-standalone-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  await fs.cp(path.join(root, 'racketdap'), path.join(directory, 'racketdap'), {
    recursive: true, filter: file => path.basename(file) !== 'compiled'
  });
  const program = path.join(directory, 'demo.rkt');
  await fs.copyFile(demo, program);
  // Only the adapter sources and the installed Racket distribution are present.
  // Exclude user package links and collection/cache overrides from this session.
  const env = { ...process.env, PLTADDONDIR: path.join(directory, 'addon') };
  delete env.PLTCOLLECTS;
  delete env.PLT_COMPILED_FILE_ROOTS;
  const client = new DapClient(path.join(directory, 'racketdap/main.rkt'), {
    spawn: (command, args, options) => spawn(command, args, { ...options, cwd: directory, env })
  });
  deferCleanup(t, () => client.close());
  await launch(client, program);
  const pending = await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 4 }] }));
  assert.equal(pending.breakpoints[0].verified, false);
  await ok(client.request('configurationDone'));
  let stopped = await client.event('stopped');
  assert.equal(stopped.body.reason, 'breakpoint');
  let top = await frame(client, stopped);
  assert.equal(top.line, 4);
  assert.match(top.name, /^Before evaluation at /);
  const pendingFrames = (await ok(client.request('stackTrace', { threadId: stopped.body.threadId }))).stackFrames;
  assert.match(pendingFrames[1].name, /^Waiting for return at /);
  const originalFrame = top.id;
  const scopes = await ok(client.request('scopes', { frameId: top.id }));
  const locals = scopes.scopes[0].variablesReference;
  const vars = await ok(client.request('variables', { variablesReference: locals }));
  assert.equal(vars.variables.find(v => v.name === 'subtotal').value, '100');
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: '(+ subtotal 20)', context: 'repl' }))).result, '120');
  assert.equal((await ok(client.request('setVariable', { variablesReference: locals, name: 'subtotal', value: '200' }))).value, '200');
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: '(values)', context: 'repl' }))).result, '#<zero values>');
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: '(values 1 2)', context: 'repl' }))).type, 'values');
  const raised = await client.request('evaluate', { frameId: top.id, expression: "(raise 'console-error)", context: 'repl' });
  assert.equal(raised.success, false);
  assert.match(raised.message, /console-error/);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'subtotal' }))).result, '200');
  await ok(client.request('next', { threadId: stopped.body.threadId }));
  stopped = await client.event('stopped');
  assert.equal(stopped.body.reason, 'step');
  assert.equal(stopped.body.description, 'Expression returned');
  assert.equal((await client.request('scopes', { frameId: originalFrame })).success, false);
  top = await frame(client, stopped);
  assert.match(top.name, /^Returned 1 value at /);
  assert.equal(top.column, '  (define tax (* subtotal rate'.length + 1);
  assert.equal(top.endColumn, top.column + 1);
  const afterScopes = await ok(client.request('scopes', { frameId: top.id }));
  const results = afterScopes.scopes.find(s => s.name === 'Return values (1)');
  assert.ok(results);
  assert.equal((await ok(client.request('variables', { variablesReference: results.variablesReference }))).variables[0].value, '20');
  await ok(client.request('stepIn', { threadId: stopped.body.threadId }));
  stopped = await client.event('stopped');
  assert.equal(stopped.body.reason, 'step');
  await ok(client.request('stepOut', { threadId: stopped.body.threadId }));
  stopped = await client.event('stopped');
  assert.equal(stopped.body.description, 'Expression returned');
  top = await frame(client, stopped);
  assert.match(top.name, /^Returned 2 values at /);
  const callerScopes = await ok(client.request('scopes', { frameId: top.id }));
  const returned = callerScopes.scopes.find(s => s.name === 'Return values (2)');
  assert.deepEqual((await ok(client.request('variables', { variablesReference: returned.variablesReference }))).variables.map(v => v.value), ['220', '20']);
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  assert.deepEqual(await ok(client.request('threads')), { threads: [] });
  assert.equal((await client.request('evaluate', { frameId: top.id, expression: 'subtotal' })).success, false);
  assert.equal(client.events.filter(e => e.event === 'output' && e.body.category === 'stdout').map(e => e.body.output).join(''), '220\n20\n');
});
test('termination remains responsive while paused evaluation is blocked', async t => {
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, demo, { stopOnEntry: true });
  await ok(client.request('configurationDone'));
  const top = await frame(client, await client.event('stopped'));
  const blocked = client.request('evaluate', { frameId: top.id, expression: '(sync never-evt)', context: 'repl' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const start = Date.now();
  await ok(client.request('terminate'));
  await client.event('terminated');
  assert.ok(Date.now() - start < 3000);
  assert.equal((await blocked).success, false);
});
test('Unicode byte framing and captured source survive editing the file during a stop', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racketdap-unicode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const program = path.join(dir, 'λ-😀.rkt');
  const source = '#lang racket/base\r\n(module+ main\r\n\t(displayln "😀λ"))\r\n';
  await fs.writeFile(program, source);
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program);
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  const top = await frame(client, stopped);
  assert.equal(top.column, 2);
  await fs.writeFile(program, '#lang racket/base\n');
  const captured = await ok(client.request('source', { sourceReference: top.source.sourceReference }));
  assert.equal(captured.content, source.replaceAll('\r\n', '\n'));
  assert.equal(captured.mimeType, 'text/x-racket');
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: '"😀λ"', context: 'repl' }, true))).result, '"😀λ"');
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal(client.events.filter(e => e.event === 'output' && e.body.category === 'stdout').map(e => e.body.output).join(''), '😀λ\n');
});

async function temporaryProgram(t, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racketdap-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const program = path.join(dir, 'target.rkt');
  await fs.writeFile(program, source);
  return program;
}
test('two program threads can stop and resume independently', async t => {
  const program = await temporaryProgram(t, '#lang racket/base\n(define (work x)\n  (define answer (+ x 1))\n  (sleep 0.1)\n  answer)\n(module+ main\n  (define child (thread (lambda () (work 10))))\n  (work 20)\n  (thread-wait child))\n');
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program);
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }));
  await ok(client.request('configurationDone'));
  const first = await client.event('stopped');
  const second = await client.event('stopped');
  assert.notEqual(first.body.threadId, second.body.threadId);
  assert.equal(first.body.allThreadsStopped, false);
  const a = await frame(client, first);
  const b = await frame(client, second);
  const values = [
    (await ok(client.request('evaluate', { frameId: a.id, expression: 'x' }))).result,
    (await ok(client.request('evaluate', { frameId: b.id, expression: 'x' }))).result
  ].sort();
  assert.deepEqual(values, ['10', '20']);
  assert.equal((await ok(client.request('continue', { threadId: first.body.threadId, singleThread: true }))).allThreadsContinued, false);
  assert.equal((await client.request('evaluate', { frameId: b.id, expression: 'x' })).success, true);
  await ok(client.request('continue', { threadId: second.body.threadId, singleThread: true }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});
test('cooperative pause stops a running tail loop and terminate ends it', async t => {
  const program = await temporaryProgram(t, '#lang racket/base\n(module+ main\n  (let loop ([n 0]) (loop (add1 n))))\n');
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program, { stopOnEntry: true });
  await ok(client.request('configurationDone'));
  const initial = await client.event('stopped');
  await ok(client.request('continue', { threadId: initial.body.threadId }));
  await ok(client.request('pause', { threadId: initial.body.threadId }));
  const paused = await client.event('stopped');
  assert.equal(paused.body.reason, 'pause');
  await ok(client.request('terminate'));
  await client.event('terminated');
});
test('target exit and module errors leave the adapter responsive', async t => {
  for (const [body, exitCode] of [['(exit 17)', 17], ['(error "target failed")', 1], ['(kill-thread (current-thread))', 1]]) {
    const program = await temporaryProgram(t, `#lang racket/base\n(module+ main ${body})\n`);
    const client = new DapClient();
    try {
      await launch(client, program);
      await ok(client.request('configurationDone'));
      await client.event('terminated');
      assert.equal((await client.event('exited')).body.exitCode, exitCode);
      assert.deepEqual(await ok(client.request('threads')), { threads: [] });
      assert.equal((await client.request('continue', { threadId: 1 })).success, false);
      await ok(client.request('disconnect'));
    } finally { await client.close(); }
  }
});

test('conditional breakpoints, Racket truth, hit counts, and interpolated logpoints', async t => {
  const program = await temporaryProgram(t, '#lang racket/base\n(define (work x)\n  (define answer (+ x 1))\n  answer)\n(module+ main\n  (for ([x (in-range 1 7)]) (work x)))\n');
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program);
  const breakpoints = [
    { line: 3, condition: '(= x 4)' },
    { line: 3, condition: '0', hitCondition: '3' },
    { line: 3, hitCondition: '%2', logMessage: 'x={x}, next={(+ x 1)}, {{literal}}' },
    { line: 3, condition: '#f' }
  ];
  const initial = await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints }));
  await ok(client.request('configurationDone'));
  let stopped = await client.event('stopped');
  let top = await frame(client, stopped);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'x' }))).result, '3');
  assert.deepEqual(stopped.body.hitBreakpointIds, [initial.breakpoints[1].id]);
  // Re-sending unchanged breakpoints must retain their IDs and hit counts.
  const updated = await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints }));
  assert.deepEqual(updated.breakpoints.map(b => b.id), initial.breakpoints.map(b => b.id));
  assert.ok(updated.breakpoints.every(b => b.verified));
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  stopped = await client.event('stopped');
  top = await frame(client, stopped);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'x' }))).result, '4');
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal(client.events.filter(e => e.event === 'stopped').length, 0);
  assert.equal(client.events.filter(e => e.event === 'output').map(e => e.body.output).join(''),
    'x=2, next=3, {literal}\nx=4, next=5, {literal}\nx=6, next=7, {literal}\n');
});

test('bad breakpoint expressions are diagnosed and runtime errors preserve the stop', async t => {
  const client = new DapClient(); t.after(() => client.close());
  await launch(client);
  const bad = await ok(client.request('setBreakpoints', { source: { path: demo }, breakpoints: [
    { line: 4, hitCondition: '%0' }, { line: 4, condition: '(' }, { line: 4, logMessage: 'broken {' }
  ] }));
  assert.ok(bad.breakpoints.every(b => !b.verified && !b.message.startsWith('Pending')));
  await ok(client.request('setBreakpoints', { source: { path: demo }, breakpoints: [{ line: 4, condition: "(raise 'condition-failed)" }] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  assert.match(stopped.body.description, /condition-failed/);
  const top = await frame(client, stopped);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'subtotal' }))).result, '100');
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});

test('uncaught exceptions expose their source, lexical locals, and exceptionInfo', async t => {
  for (const expression of ['(error "boom")', "(raise 'boom)"]) {
    const program = await temporaryProgram(t, `#lang racket/base\n(define (fail value)\n  ${expression})\n(module+ main (fail 42))\n`);
    const client = new DapClient();
    try {
      await launch(client, program);
      await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
      await ok(client.request('configurationDone'));
      const stopped = await client.event('stopped');
      assert.equal(stopped.body.reason, 'exception');
      const top = await frame(client, stopped);
      assert.equal(top.line, 3);
      assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'value' }))).result, '42');
      const info = await ok(client.request('exceptionInfo', { threadId: stopped.body.threadId }));
      assert.equal(info.breakMode, 'unhandled');
      assert.match(info.description, /boom/);
      const { scopes } = await ok(client.request('scopes', { frameId: top.id }));
      assert.ok(scopes.some(s => s.name === 'Exception'));
      await ok(client.request('continue', { threadId: stopped.body.threadId }));
      await client.event('terminated');
      assert.equal((await client.event('exited')).body.exitCode, 1);
    } finally { await client.close(); }
  }
});

test('caught exceptions continue normally and uncaught child-thread exceptions can stop', async t => {
  const program = await temporaryProgram(t, '#lang racket/base\n(define (fail value)\n  (error "child boom"))\n(module+ main\n  (with-handlers ([exn:fail? void]) (error "caught"))\n  (thread-wait (thread (lambda () (fail 19)))))\n');
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program);
  await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  assert.match(stopped.body.description, /child boom/);
  assert.deepEqual(stopped.body.racketdapActions, ['racketdap/continueToLocation', 'racketdap/printBinding', 'racketdap/setBinding']);
  const top = await frame(client, stopped);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'value' }))).result, '19');
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});

test('cancelling active and queued evaluations keeps live frames and the session usable', async t => {
  const client = new DapClient(); t.after(() => client.close());
  await launch(client);
  await ok(client.request('setBreakpoints', { source: { path: demo }, breakpoints: [{ line: 4 }] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  const top = await frame(client, stopped);
  const first = client.request('evaluate', { frameId: top.id, expression: '(begin (set! subtotal 150) (displayln "evaluating") (flush-output) (sync never-evt))' });
  const firstId = client.sequence;
  await client.event('output', e => e.body.output.includes('evaluating'));
  const queued = client.request('evaluate', { frameId: top.id, expression: '(sync never-evt)' });
  const queuedId = client.sequence;
  await ok(client.request('cancel', { requestId: queuedId }));
  await ok(client.request('cancel', { requestId: firstId }));
  for (const response of await Promise.all([first, queued])) {
    assert.equal(response.success, false);
    assert.equal(response.message, 'cancelled');
  }
  await ok(client.request('cancel', { requestId: firstId }));
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'subtotal' }))).result, '150');
  const another = client.request('evaluate', { frameId: top.id, expression: '(begin (displayln "again") (flush-output) (sync never-evt))' });
  await client.event('output', e => e.body.output.includes('again'));
  assert.equal((await ok(client.request('racketdap/cancelEvaluation'))).cancelled, 1);
  assert.equal((await another).message, 'cancelled');
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});

test('interactive sessions keep the module alive, inspect results, and debug console calls', async t => {
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, demo, { interactive: true, submodule: [] });
  await ok(client.request('setBreakpoints', { source: { path: demo }, breakpoints: [{ line: 4 }] }));
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  const call = client.request('evaluate', { context: 'repl', expression: '(price 50 1/10)' });
  const stopped = await client.event('stopped');
  const top = await frame(client, stopped);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'subtotal' }))).result, '50');
  const blocked = client.request('evaluate', { frameId: top.id, expression: '(begin (displayln "nested") (flush-output) (sync never-evt))' });
  await client.event('output', e => e.body.output.includes('nested'));
  assert.equal((await ok(client.request('racketdap/cancelEvaluation'))).cancelled, 1);
  assert.equal((await blocked).message, 'cancelled');
  await ok(client.request('evaluate', { frameId: top.id, expression: '(set! subtotal 80)' }));
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  const result = await ok(call);
  assert.equal(result.type, 'values');
  assert.deepEqual((await ok(client.request('variables', { variablesReference: result.variablesReference }))).variables.map(v => v.value), ['88', '8']);
  await ok(client.request('evaluate', { context: 'repl', expression: '(define session-value 123)' }));
  assert.equal((await client.request('variables', { variablesReference: result.variablesReference })).success, false);
  assert.equal((await ok(client.request('evaluate', { context: 'repl', expression: 'session-value' }))).result, '123');
  assert.equal((await client.request('evaluate', { context: 'repl', expression: '(error "console failed")' })).success, false);
  assert.equal((await ok(client.request('evaluate', { context: 'repl', expression: '(+ session-value 1)' }))).result, '124');
  await ok(client.request('terminate'));
  await client.event('terminated');
});

test('integrated terminal transports Unicode input, output, and EOF separately from evaluation', async t => {
  const program = await temporaryProgram(t, '#lang racket/base\n(module+ main\n  (displayln "name?") (flush-output)\n  (displayln (string-append "hello " (read-line)))\n  (displayln (eof-object? (read-line))))\n');
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program, { console: 'integratedTerminal' });
  await ok(client.request('configurationDone'));
  await client.event('racketdap/terminalOutput', e => e.body.output.includes('name?'));
  await ok(client.request('racketdap/input', { text: 'λ😀\n' }));
  await ok(client.request('racketdap/input', { eof: true }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  assert.equal(client.events.filter(e => e.event === 'racketdap/terminalOutput').map(e => e.body.output).join(''), 'hello λ😀\n#t\n');
});

test('interactive entry output flushes before termination and terminal interrupt unblocks input', async t => {
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, demo, { interactive: true });
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  let printed = '';
  while (!printed.includes('110\n10\n')) printed += (await client.event('output', e => e.body.category === 'stdout')).body.output;
  await ok(client.request('terminate'));
  await client.event('terminated');

  const program = await temporaryProgram(t, '#lang racket/base\n(module+ main (displayln "reading") (flush-output) (read-line))\n');
  const terminal = new DapClient(); t.after(() => terminal.close());
  await launch(terminal, program, { console: 'integratedTerminal' });
  await ok(terminal.request('configurationDone'));
  await terminal.event('racketdap/terminalOutput', e => e.body.output.includes('reading'));
  await ok(terminal.request('racketdap/interrupt'));
  await terminal.event('terminated');
  assert.equal((await terminal.event('exited')).body.exitCode, 1);
});

test('target exit ends its ordinary subprocess group without hanging inherited output', async t => {
  if (process.platform !== 'linux') return t.skip('Linux process-state check');
  const program = await temporaryProgram(t, '#lang racket/base\n(module+ main\n  (define-values (child out in err)\n    (subprocess (current-output-port) #f (current-error-port) (find-executable-path "sleep") "10"))\n  (displayln (subprocess-pid child))\n  (flush-output)\n  (exit 23))\n');
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program);
  const started = Date.now();
  await ok(client.request('configurationDone'));
  await client.event('terminated');
  assert.ok(Date.now() - started < 3000, 'Target exit must not wait for the sleeping descendant');
  assert.equal((await client.event('exited')).body.exitCode, 23);
  const output = client.events.filter(e => e.event === 'output' && e.body.category === 'stdout').map(e => e.body.output).join('');
  const pid = Number(output.trim());
  assert.ok(pid > 0);
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    assert.match(stat, /\) Z /, 'A remaining child may only be a zombie awaiting reaping');
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
});
test('opaque program structures expose paged fields without invoking user code', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racketdap-structures-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const program = path.join(dir, 'main.rkt');
  await fs.writeFile(program, `#lang racket/base
(define effects 0)
(struct post (title body)
  #:property prop:custom-write (lambda args (set! effects (add1 effects)))
  #:property prop:object-name (lambda (_) (set! effects (add1 effects)) 'wrong))
(define (show value)
  (displayln effects))
(show (post "Title" "Body"))
`);
  const client = new DapClient(); t.after(() => client.close());
  await launch(client, program);
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 7 }] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  const top = await frame(client, stopped);
  const value = await ok(client.request('evaluate', { frameId: top.id, expression: 'value', context: 'watch' }));
  assert.equal(value.type, 'post');
  assert.equal(value.result, '#<post "Title" "Body">');
  assert.ok(value.variablesReference > 0);
  const fields = (await ok(client.request('variables', { variablesReference: value.variablesReference, start: 1, count: 1 }))).variables;
  assert.deepEqual(fields.map(({ name, value }) => ({ name, value })), [{ name: '1', value: '"Body"' }]);
  assert.equal((await ok(client.request('evaluate', { frameId: top.id, expression: 'effects' }))).result, '0');
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
});
