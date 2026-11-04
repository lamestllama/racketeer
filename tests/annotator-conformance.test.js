// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Behavioral tests: no imports of the instrumentation implementation.
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DapClient } = require('./dap-client');
const treeRemoval = require('./support/tree-removal');
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
    await fs.rm(directory, treeRemoval);
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

test('function inspection preserves inferred names, identity, and case-lambda arity', async t => {
  const lines = [
    '#lang racket/base',
    '(define (cedar x) x)',
    '(define branch (case-lambda [(x) x] [(x y) y]))',
    '(define alias cedar)',
    '(define nested (letrec ([leaf (lambda (x) x)]) leaf))',
    '(define selected (if #t (lambda (x) x) (lambda (x y) y)))',
    '(define (run proc)',
    '  (displayln (list (object-name cedar) (object-name branch) (object-name nested)',
    '                   (object-name selected) (procedure-arity branch) (eq? alias cedar))))',
    '(module+ main (run cedar))'
  ];
  const { client, program } = await prepare(t, lines, [{ line: 8 }]);
  const normal = await execute('racket', [program], { timeout: 30000 });
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  for (const [expression, name] of [['cedar', 'cedar'], ['branch', 'branch'], ['nested', 'leaf'], ['selected', 'selected'], ['proc', 'cedar']]) {
    const value = await ok(client.request('evaluate', { frameId: frame.id, expression, context: 'watch' }));
    assert.equal(value.result, `#<procedure:${name}>`);
    assert.ok(value.variablesReference > 0);
    const { variables } = await ok(client.request('variables', { variablesReference: value.variablesReference }));
    assert.equal(variables.find(item => item.name === 'arity').value, expression === 'branch' ? '(1 2)' : '1');
  }
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: '(eq? cedar alias)' }))).result, '#t');
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), normal.stdout);
});

test('port provenance preserves evaluation order, multiple values, tail calls, and continuation reentry', async t => {
  const { client, program } = await prepare(t, [
    '#lang racket/base',
    "(define events '())",
    '(define (note label value) (set! events (cons label events)) value)',
    '(define (choose port #:label label) (list (input-port? port) label))',
    '(define (failure thunk) (with-handlers ([exn:fail? exn-message]) (thunk)))',
    '(define saved #f)',
    '(define (build)',
    "  (define port ((note 'operator open-input-string)",
    "                (call/cc (lambda (k) (set! saved k) (note 'content \"fir\")))",
    "                (note 'name 'canopy)))",
    '  (list (object-name port) (read-string 3 port) (eq? port port)))',
    '(define (tail-loop n)',
    "  (with-continuation-mark 'branch n",
    "    (if (zero? n) (values 'done (continuation-mark-set->list #f 'branch))",
    '        ((if (even? n) tail-loop tail-loop) (sub1 n)))))',
    '(module+ main',
    '  (define rounds 0)',
    '  (displayln (build))',
    '  (set! rounds (add1 rounds))',
    '  (when (= rounds 1) (saved "oak"))',
    "  (define-values (input output) ((note 'pipe-maker make-pipe) 16 'twig-in 'twig-out))",
    '  (displayln (list (object-name input) (object-name output) (input-port? input) (output-port? output)))',
    '  (close-input-port input) (close-output-port output)',
    '  (displayln (call-with-values (lambda () (tail-loop 30000)) list))',
    "  (displayln (choose (note 'positional (open-input-string \"\")) #:label (note 'keyword 'caption)))",
    '  (displayln (failure (lambda () ((values) 1))))',
    '  (displayln (failure (lambda () ((values 1 2) 3))))',
    '  (displayln (reverse events)))'
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

test('unit state keeps source names, lexical shadowing, and live mutation across instances', async t => {
  const lines = [
    '#lang racket/base',
    '(require racket/unit)',
    '(define worker@',
    '  (unit (import) (export)',
    '    (define count 10)',
    '    (define reserve 90)',
    '    (define (update n)',
    '      (let ([count 1000])',
    '        (displayln (+ count n)))',
    '      (set! count (+ count n))',
    '      count)',
    '    (displayln (update 4))))',
    '(invoke-unit worker@)',
    '(invoke-unit worker@)'
  ];
  const { client } = await prepare(t, lines, [{ line: 9 }, { line: 10 }]);
  await ok(client.request('configurationDone'));
  for (let instance = 0; instance < 2; instance++) {
    const shadow = await stoppedFrame(client);
    assert.equal(shadow.frame.line, 9);
    assert.equal((await ok(client.request('evaluate', { frameId: shadow.frame.id, expression: 'count' }))).result, '1000');
    await ok(client.request('continue', { threadId: shadow.threadId }));
    const { threadId, frame } = await stoppedFrame(client);
    assert.equal(frame.line, 10);
    const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
    const locals = scopes.find(scope => scope.name === 'Locals');
    const { variables } = await ok(client.request('variables', { variablesReference: locals.variablesReference }));
    assert.deepEqual(variables.map(variable => variable.name).sort(), ['count', 'n', 'reserve']);
    assert.equal(variables.find(variable => variable.name === 'count').value, '10');
    assert.equal(variables.find(variable => variable.name === 'reserve').value, '90');
    assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'count' }))).result, '10');
    if (instance === 0) {
      await ok(client.request('setVariable', { variablesReference: locals.variablesReference, name: 'count', value: '20' }));
      assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'count' }))).result, '20');
    }
    await ok(client.request('continue', { threadId }));
  }
  assert.equal(await finished(client), '1004\n24\n1004\n14\n');
});

test('macro-renamed locals use binding identity through nested and hidden same-name bindings', async t => {
  const lines = [
    '#lang racket/base',
    '(require (for-syntax racket/base))',
    '(define-syntax (with-state stx)',
    '  (syntax-case stx ()',
    '    [(_ name initial body ...)',
    '     (with-syntax ([(cell) (generate-temporaries #\'(name))])',
    '       #\'(let ([cell initial])',
    '           (let-syntax ([name (make-rename-transformer #\'cell)]) body ...)))]))',
    '(define-syntax-rule (hide body) (let ([count \'hidden]) body))',
    '(with-state count 10',
    '  (with-state count 20',
    '    (hide (displayln (+ count 1))))',
    '  (displayln (+ count 2)))'
  ];
  const { client } = await prepare(t, lines, [{ line: 12, column: lines[11].indexOf('(+ count') + 1 }, { line: 13 }]);
  await ok(client.request('configurationDone'));
  const inner = await stoppedFrame(client);
  assert.equal(inner.frame.line, 12);
  assert.equal((await ok(client.request('evaluate', { frameId: inner.frame.id, expression: 'count' }))).result, '20');
  assert.equal((await ok(client.request('evaluate', { frameId: inner.frame.id, expression: '(begin (set! count 30) count)' }))).result, '30');
  await ok(client.request('continue', { threadId: inner.threadId }));
  const outer = await stoppedFrame(client);
  assert.equal(outer.frame.line, 13);
  assert.equal((await ok(client.request('evaluate', { frameId: outer.frame.id, expression: 'count' }))).result, '10');
  await ok(client.request('continue', { threadId: outer.threadId }));
  assert.equal(await finished(client), '31\n12\n');
});

test('a conditional breakpoint stops once per call across expanded clauses', async t => {
  const lines = [
    '#lang racket/base',
    '(define (classify x)',
    '  (cond [(zero? x) \'zero]',
    '        [(negative? x) \'negative]',
    '        [else \'positive]))',
    '(displayln (classify -1))',
    '(displayln (classify 1))'
  ];
  const { client } = await prepare(t, lines, [{ line: 3 }]);
  await ok(client.request('configurationDone'));
  for (const expected of ['-1', '1']) {
    const { threadId, frame } = await stoppedFrame(client);
    assert.equal(frame.line, 3);
    assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: 'x' }))).result, expected);
    await ok(client.request('continue', { threadId }));
  }
  assert.equal(await finished(client), 'negative\npositive\n');
});

test('a generated operation keeps its stop when it borrows an atomic argument range', async t => {
  const lines = [
    '#lang racket/base',
    '(require (for-syntax racket/base))',
    '(define-syntax (increment stx)',
    '  (syntax-case stx ()',
    '    [(_ value) (syntax/loc #\'value (+ 1 value))]))',
    '(define (run)',
    '  (displayln (increment 4)))',
    '(run)'
  ];
  const { client } = await prepare(t, lines, [{ line: 7, column: lines[6].indexOf('4') + 1 }]);
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  assert.equal(frame.line, 7);
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), '5\n');
});

test('a generated operation around an atomic argument shows no value at that argument', async t => {
  const lines = [
    '#lang racket/base',
    '(require (for-syntax racket/base))',
    '(define-syntax (increment stx)',
    '  (syntax-case stx ()',
    '    [(_ value) (syntax/loc #\'value (+ 1 value))]))',
    '(displayln (increment 4))'
  ];
  const { client } = await prepare(t, lines, [{ line: 6, column: lines[5].indexOf('4') + 1 }]);
  await ok(client.request('configurationDone'));
  const { threadId } = await stoppedFrame(client);
  const stepped = client.event('stopped', event => event.body.reason === 'step');
  await ok(client.request('stepIn', { threadId }));
  await stepped;
  const { stackFrames: [frame] } = await ok(client.request('stackTrace', { threadId }));
  assert.match(frame.name, /^Returned, value not shown/);
  const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
  assert.deepEqual(scopes.map(scope => scope.name), ['Locals']);
  assert.equal((await client.request('racketdap/replaceResults', { threadId, expression: '9' })).success, false);
  assert.equal((await client.request('racketdap/printResults', { threadId })).success, false);
  await ok(client.request('continue', { threadId }));
  assert.equal(await finished(client), '5\n');
});

for (const expression of ['(set! counter (add1 counter))', '(tick)', '(when #t (set! counter (add1 counter)))']) {
  for (const phase of ['before', 'after']) {
    test(`a macro borrowing ${expression}'s range preserves each ${phase} boundary`, async t => {
      const lines = [
        '#lang racket/base',
        '(require (for-syntax racket/base))',
        '(define-syntax (twice stx)',
        '  (syntax-case stx ()',
        '    [(_ expression) (syntax/loc #\'expression (begin0 expression expression))]))',
        '(define counter 0)',
        '(define (tick) (set! counter (add1 counter)) counter)',
        '(define (run)',
        `  (twice ${expression})`,
        '  (displayln counter))',
        '(run)'
      ];
      const column = lines[8].indexOf(expression) + (phase === 'after' ? expression.length : 1);
      const { client } = await prepare(t, lines, [{ line: 9, column }]);
      await ok(client.request('configurationDone'));
      for (let iteration = 0; iteration < 2; iteration++) {
        const stopped = await client.event('stopped');
        assert.equal(stopped.body.reason, 'breakpoint');
        assert.equal(stopped.body.racketdapStopKind, phase);
        const { stackFrames } = await ok(client.request('stackTrace', { threadId: stopped.body.threadId }));
        assert.equal(stackFrames[0].line, 9);
        const value = String(iteration + (phase === 'after' ? 1 : 0));
        assert.equal((await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'counter' }))).result, value);
        if (phase === 'before') {
          await ok(client.request('next', { threadId: stopped.body.threadId }));
          const returned = await client.event('stopped');
          assert.equal(returned.body.racketdapStopKind, 'after');
          const stack = await ok(client.request('stackTrace', { threadId: returned.body.threadId }));
          assert.equal((await ok(client.request('evaluate', { frameId: stack.stackFrames[0].id, expression: 'counter' }))).result, String(iteration + 1));
        }
        await ok(client.request('continue', { threadId: stopped.body.threadId }));
      }
      assert.equal(await finished(client), '2\n');
    });
  }
}

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

test('a breakpoint on the expression producing a for sequence stops once, at its value', async t => {
  const lines = [
    '#lang racket/base',
    '(for ([i (list 1 2)])',
    '  (displayln i))'
  ];
  const column = lines[1].indexOf('(list 1 2)') + 1;
  const { client, program } = await prepare(t, lines, [{ line: 2, column }]);
  await ok(client.request('configurationDone'));
  const { threadId, frame } = await stoppedFrame(client);
  assert.deepEqual([frame.line, frame.column, frame.endColumn], [2, column, column + '(list 1 2)'.length]);
  const { breakpoints } = await ok(client.request('breakpointLocations', { source: { path: program }, line: 2 }));
  assert.equal(breakpoints.filter(location => location.column === column).length, 1);
  await ok(client.request('continue', { threadId }));
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
  assert.equal((await ok(evaluate('(list n n.1)'))).result, '(5 40)');
  await ok(evaluate('(set! n.1 100)'));
  assert.equal((await ok(evaluate('(list n n.1)'))).result, '(5 100)');
  await ok(evaluate('(set! n.1 40)'));
  assert.equal((await ok(evaluate('(list n n.1)'))).result, '(5 40)');
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
