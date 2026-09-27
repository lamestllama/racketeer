'use strict';
// Behavioral tests: no imports of the instrumentation implementation.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DapClient } = require('./dap-client');
const execute = promisify(execFile);
const adapter = process.env.RACKETDAP_CONFORMANCE_ADAPTER;

async function ok(response) {
  const message = await response;
  assert.equal(message.success, true, message.message);
  return message.body;
}

async function prepare(t, lines, breakpoints = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketdap-conformance-'));
  const program = path.join(directory, 'target.rkt');
  const source = lines.join('\n') + '\n';
  await fs.writeFile(program, source);
  const client = new DapClient(adapter);
  t.after(async () => {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await ok(client.request('initialize', { adapterID: 'racketdap', linesStartAt1: true, columnsStartAt1: true }));
  await ok(client.request('launch', { program, cwd: directory }));
  await client.event('initialized');
  if (breakpoints.length) await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints }));
  return { client, program, source };
}

async function stoppedFrame(client) {
  const stopped = await client.event('stopped');
  assert.equal(stopped.body.reason, 'breakpoint');
  const stack = await ok(client.request('stackTrace', { threadId: stopped.body.threadId }));
  assert.ok(stack.stackFrames.length);
  return { threadId: stopped.body.threadId, frame: stack.stackFrames[0] };
}

async function finished(client) {
  await client.event('terminated');
  const exited = await client.event('exited');
  assert.equal(exited.body.exitCode, 0);
  return client.events.filter(event => event.event === 'output' && event.body.category === 'stdout')
    .map(event => event.body.output).join('');
}

test('instrumented execution preserves values, effects, continuations, and tail calls', async t => {
  const { client, program } = await prepare(t, [
    '#lang racket',
    '(module+ main',
    "  (define effects '())",
    '  (define (note x) (set! effects (cons x effects)) x)',
    "  (write (call-with-values (lambda () (begin0 (values 'a 'b) (note 'after))) list))",
    '  (newline)',
    '  (write (call-with-values (lambda () (values)) list)) (newline)',
    "  (write (call/cc (lambda (escape) (dynamic-wind (lambda () (note 'enter))",
    "           (lambda () (escape 'escaped)) (lambda () (note 'leave)))))) (newline)",
    '  (write (let loop ([n 30000] [total 0]) (if (zero? n) total (loop (sub1 n) (add1 total))))) (newline)',
    '  (write (reverse effects)) (newline))'
  ]);
  const normal = await execute('racket', [program], { timeout: 30000 });
  await ok(client.request('configurationDone'));
  assert.equal(await finished(client), normal.stdout);
  assert.equal(normal.stderr, '');
});

test('source-visible locals retain hygiene and mutation affects the actual computation', async t => {
  const lines = [
    '#lang racket/base',
    "(define-syntax-rule (hide expression) (let ([x 'hidden]) expression))",
    '(define (work x)',
    '  (define answer (hide (+ x 1)))',
    '  (displayln (list x answer)))',
    '(module+ main (work 10))'
  ];
  const { client } = await prepare(t, lines, [{ line: 4, column: lines[3].indexOf('(+ x') + 1 }]);
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  assert.equal(frame.line, 4);
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'x', context: 'repl' }))).result, '10');
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: '(begin (set! x 30) x)', context: 'repl' }))).result, '30');
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), '(30 31)\n');
  assert.equal((await client.request('scopes', { frameId: frame.id })).success, false);
});

test('both executions of a macro-duplicated source expression hit the breakpoint', async t => {
  const lines = [
    '#lang racket/base',
    '(define-syntax-rule (twice expression) (begin expression expression))',
    '(define (run)',
    '  (define n 0)',
    '  (twice (begin (set! n (add1 n))',
    '                (displayln n))))',
    '(module+ main (run))'
  ];
  const { client } = await prepare(t, lines, [{ line: 5, column: lines[4].indexOf('(add1 n)') + 1 }]);
  await ok(client.request('configurationDone'));
  for (const value of ['0', '1']) {
    const { threadId, frame } = await stoppedFrame(client);
    assert.equal(frame.line, 5);
    assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'n' }))).result, value);
    await ok(client.request('continue', { threadId }));
  }
  assert.equal(await finished(client), '1\n2\n');
});

test('a paused main submodule can evaluate its initialized mutable module binding', async t => {
  const lines = [
    '#lang racket/base',
    '(module+ main',
    '  (define n 5)',
    '  (set! n (add1 n))',
    '  (displayln n))'
  ];
  const { client } = await prepare(t, lines, [{ line: 4, column: lines[3].indexOf('(add1 n)') + 1 }]);
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'n' }))).result, '5');
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), '6\n');
});

test('debug loading preserves expansion-time effects and leaves source files unchanged', async t => {
  const { client, program, source } = await prepare(t, [
    '#lang racket/base',
    '(require (for-syntax racket/base))',
    '(begin-for-syntax (displayln "compile-time effect"))',
    '(define-syntax (answer stx)',
    '  (displayln "transformer invocation")',
    "  #'42)",
    '(module+ main (displayln (answer)))'
  ]);
  const before = await fs.stat(program);
  const normal = await execute('racket', [program], { timeout: 30000 });
  await ok(client.request('configurationDone'));
  assert.equal(await finished(client), normal.stdout);
  assert.equal(await fs.readFile(program, 'utf8'), source);
  assert.equal((await fs.stat(program)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(path.dirname(program)), ['target.rkt']);
});

test('source module identifiers remain distinct from expansion-renamed namespace names', async t => {
  const lines = [
    '#lang racket/base', '(module+ main',
    '  (define n 5)', '  (define n.1 40)',
    '  (set! n (add1 n))', '  (displayln (list n n.1)))'
  ];
  const { client } = await prepare(t, lines, [{ line: 5, column: lines[4].indexOf('(add1 n)') + 1 }]);
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  const evaluate = expression => client.request('evaluate', { frameId: frame.id, expression });
  assert.equal((await ok(evaluate('(list n n.1)'))).result, '(5 . (40 . ()))');
  await ok(evaluate('(set! n.1 100)'));
  assert.equal((await ok(evaluate('(list n n.1)'))).result, '(5 . (100 . ()))');
  await ok(evaluate('(set! n.1 40)'));
  assert.equal((await ok(evaluate('(list n n.1)'))).result, '(5 . (40 . ()))');
  await ok(evaluate('(set! n 8)'));
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), '(9 40)\n');
});

test('merged main fragments expose later and inherited bindings in initializers and functions', async t => {
  const lines = [
    '#lang racket/base',
    '(module+ main',
    '  (define (inspect) (+ 1 2))',
    '  (define n 5))',
    '(define parent-later 100)',
    '(module+ main',
    '  (define n.1 40)',
    '  (set! n (add1 n)))',
    '(module+ main',
    '  (inspect)',
    '  (displayln (list n n.1 parent-later)))'
  ];
  const { client } = await prepare(t, lines, [
    { line: 8, column: lines[7].indexOf('(add1 n)') + 1 },
    { line: 3, column: lines[2].indexOf('(+ 1 2)') + 1 }
  ]);
  await ok(client.request('configurationDone'));
  for (const expected of ['5', '6']) {
    const { threadId, frame } = await stoppedFrame(client);
    const evaluate = expression => client.request('evaluate', { frameId: frame.id, expression });
    assert.equal((await ok(evaluate('n'))).result, expected);
    assert.equal((await ok(evaluate('n.1'))).result, '40');
    assert.equal((await ok(evaluate('parent-later'))).result, '100');
    await ok(evaluate('(set! n.1 0)'));
    assert.equal((await ok(evaluate('n.1'))).result, '0');
    await ok(evaluate('(set! n.1 40)'));
    assert.equal((await evaluate('(set! parent-later 0)')).success, false);
    if (frame.line === 3) await ok(evaluate('(set! n 9)'));
    await ok(client.request('continue', { threadId }));
  }
  assert.equal(await finished(client), '3\n(9 40 100)\n');
});

test('a submodule can evaluate a macro inherited from a parent with no runtime definitions', async t => {
  const lines = [
    '#lang racket/base',
    '(define-syntax-rule (bump x) (+ x 100))',
    '(module+ main',
    '  (define n 5)',
    '  (displayln (+ n 1)))'
  ];
  const { client } = await prepare(t, lines, [{ line: 5, column: lines[4].indexOf('(+ n 1)') + 1 }]);
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: '(bump n)' }))).result, '105');
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), '6\n');
});
