// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
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

// A waiter left on an event that never comes would fail the client's close, so this
// looks at what has arrived.
async function nextStopOrEnd(client) {
  for (;;) {
    const index = client.events.findIndex(event => event.event === 'stopped' || event.event === 'terminated');
    if (index >= 0) {
      const [event] = client.events.splice(index, 1);
      return event.event === 'stopped' ? event : null;
    }
    if (client.fatalError) throw client.fatalError;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Runs a program with a breakpoint on each line that holds (void 'stop-NAME), and calls
// visit at every stop with the stop's name and what it needs to inspect it.
async function eachStop(t, lines, visit, config = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-variables-')));
  const program = path.join(directory, 'specimen.rkt');
  await fs.writeFile(program, lines.join('\n') + '\n');
  const client = new DapClient(undefined, { timeout: 60000 });
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const marks = new Map();
  lines.forEach((line, index) => {
    const mark = /\(void 'stop-([^)]*)\)/.exec(line);
    if (mark) marks.set(index + 1, mark[1]);
  });
  await ok(client.request('initialize', { linesStartAt1: true, columnsStartAt1: true }));
  await ok(client.request('launch', { program, cwd: directory, ...config }));
  await client.event('initialized');
  await ok(client.request('setBreakpoints', {
    source: { path: program }, breakpoints: [...marks.keys()].map(line => ({ line }))
  }));
  await ok(client.request('configurationDone'));
  const seen = [];
  for (;;) {
    const stopped = await nextStopOrEnd(client);
    if (!stopped) break;
    const threadId = stopped.body.threadId;
    const { stackFrames } = await ok(client.request('stackTrace', { threadId }));
    const frame = stackFrames[0];
    const name = marks.get(frame.line);
    seen.push(name);
    const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
    const locals = scopes.find(scope => scope.name === 'Locals').variablesReference;
    const stop = {
      client, frame, locals,
      rows: async (args = {}) => (await ok(client.request('variables', { variablesReference: locals, ...args }))).variables,
      hover: expression => client.request('evaluate', { expression, frameId: frame.id, context: 'hover' }),
      watch: expression => client.request('evaluate', { expression, frameId: frame.id, context: 'watch' }),
      console: expression => client.request('evaluate', { expression, frameId: frame.id, context: 'repl' }),
      set: (variable, value) => client.request('setVariable', { variablesReference: locals, name: variable, value }),
      open: async (reference, args = {}) => (await ok(client.request('variables', { variablesReference: reference, ...args }))).variables
    };
    await visit(name, stop);
    await ok(client.request('continue', { threadId }));
  }
  assert.equal((await client.event('exited')).body.exitCode, 0);
  const output = client.events.filter(event => event.event === 'output' && event.body.category === 'stdout')
    .map(event => event.body.output).join('');
  return { seen, output };
}
const shown = rows => Object.fromEntries(rows.map(row => [row.name, row.value]));
const names = rows => rows.map(row => row.name).sort();

const macros = [
  '#lang racket/base',
  '(require (for-syntax racket/base racket/syntax))',
  '(define-syntax (aif stx)',
  '  (syntax-case stx ()',
  '    [(_ c t e) (with-syntax ([it (datum->syntax stx (quote it))]) #\'(let ([it c]) (if it t e)))]))',
  '(define-syntax (def-getter stx)',
  '  (syntax-case stx ()',
  '    [(_ name val)',
  '     (with-syntax ([get-name (format-id #\'name "get-~a" #\'name)])',
  '       #\'(define get-name (lambda () val)))]))'
];

test('a name the source reads and a macro binds is a variable everywhere', async t => {
  const { seen, output } = await eachStop(t, [
    ...macros,
    '(define (anaphoric v)',
    '  (aif v',
    '       (begin',
    "         (void 'stop-anaphoric)",
    '         (+ it 1))',
    '       0))',
    '(define (format-named)',
    '  (def-getter thing 3)',
    "  (void 'stop-format-named)",
    '  (get-thing))',
    '(define (local-structure)',
    '  (struct local-pt (x y))',
    '  (define p (local-pt 1 2))',
    "  (void 'stop-local-structure)",
    '  (local-pt-x p))',
    '(anaphoric 9)',
    '(format-named)',
    '(local-structure)'
  ], async (name, stop) => {
    if (name === 'anaphoric') {
      assert.deepEqual(shown(await stop.rows()), { it: '9', v: '9' });
      assert.equal((await ok(stop.hover('it'))).result, '9');
      assert.equal((await ok(stop.watch('(* it 2)'))).result, '18');
      assert.equal((await ok(stop.console('it'))).result, '9');
      assert.equal((await ok(stop.set('it', '41'))).value, '41');
      assert.equal(shown(await stop.rows()).it, '41');
    } else if (name === 'format-named') {
      assert.deepEqual(names(await stop.rows()), ['get-thing']);
      assert.equal((await ok(stop.hover('get-thing'))).result, '#<procedure:get-thing>');
      assert.equal((await ok(stop.console('(get-thing)'))).result, '3');
    } else {
      // The accessor the source reads is listed, and the one it does not read is not.
      assert.deepEqual(names(await stop.rows()), ['local-pt-x', 'p']);
      assert.equal((await ok(stop.console('(local-pt-x p)'))).result, '1');
      const refused = await stop.hover('local-pt-y');
      assert.equal(refused.success, false);
      assert.match(refused.message, /no source-visible variable named local-pt-y/);
    }
  });
  assert.deepEqual(seen, ['anaphoric', 'format-named', 'local-structure']);
  assert.equal(output, '42\n3\n1\n');
});

test('a reference counts wherever it is: after the stop, as an assignment, in a closure', async t => {
  await eachStop(t, [
    ...macros,
    '(define (read-later v)',
    '  (aif v',
    '       (begin',
    "         (void 'stop-before-reference)",
    '         (void)',
    '         it)',
    '       0))',
    '(define (assigned v)',
    '  (aif v',
    '       (begin',
    "         (void 'stop-before-assignment)",
    '         (set! it 50)',
    "         (void 'stop-after-assignment))",
    '       0))',
    '(define (in-closure v)',
    '  (aif v',
    '       (let ([get (lambda () it)])',
    "         (void 'stop-beside-closure)",
    '         (get))',
    '       0))',
    '(define (inside-closure v)',
    '  (aif v',
    '       ((lambda ()',
    "          (void 'stop-inside-closure)",
    '          it))',
    '       0))',
    '(define (long-body v)',
    '  (aif v',
    '       (let ()',
    ...Array.from({ length: 40 }, (_, i) => `         (define d${i} ${i})`),
    "         (void 'stop-long-body)",
    '         (+ it d39))',
    '       0))',
    '(define (not-read v)',
    '  (aif v',
    '       (begin',
    "         (void 'stop-not-read)",
    '         1)',
    '       0))',
    '(read-later 1) (assigned 1) (in-closure 1) (inside-closure 1) (long-body 1) (not-read 1)'
  ], async (name, stop) => {
    const rows = shown(await stop.rows());
    if (name === 'after-assignment') assert.equal(rows.it, '50');
    else if (name === 'not-read') {
      assert.deepEqual(rows, { v: '1' });
      assert.equal((await stop.hover('it')).success, false);
    } else {
      assert.equal(rows.it, '1', name);
      assert.equal((await ok(stop.hover('it'))).result, '1', name);
    }
  });
});

test('the row is the binding the source refers to, never one of the same name', async t => {
  const { output } = await eachStop(t, [
    ...macros,
    ';; Each binds twin twice: once where the use site can read it, once hygienically.',
    '(define-syntax (readable-outside stx)',
    '  (syntax-case stx ()',
    "    [(_ body) (with-syntax ([named (datum->syntax stx 'twin)])",
    "                #'(let ([named 'referred]) (let ([twin 'hygienic]) (void twin) body)))]))",
    '(define-syntax (readable-inside stx)',
    '  (syntax-case stx ()',
    "    [(_ body) (with-syntax ([named (datum->syntax stx 'twin)])",
    "                #'(let ([twin 'hygienic]) (void twin) (let ([named 'referred]) body)))]))",
    '(define (first-twin)',
    '  (readable-outside (begin',
    "                      (void 'stop-outside)",
    '                      twin)))',
    '(define (second-twin)',
    '  (readable-inside (begin',
    "                     (void 'stop-inside)",
    '                     twin)))',
    '(define (nested a b)',
    '  (aif a (aif b (begin',
    "                  (void 'stop-nested)",
    '                  it) 0) 0))',
    '(first-twin) (second-twin) (nested 1 2)'
  ], async (name, stop) => {
    if (name === 'nested') {
      // The outer `it` has no reference: the source's one refers to the inner.
      assert.deepEqual(shown(await stop.rows()), { it: '2', a: '1', b: '2' });
    } else {
      assert.deepEqual(shown(await stop.rows()), { twin: 'referred' });
      assert.equal((await ok(stop.hover('twin'))).result, 'referred');
      assert.equal((await ok(stop.set('twin', "'changed"))).value, 'changed');
    }
  });
  assert.equal(output, "'changed\n'changed\n2\n");
});

test('a module-level binding a macro made is reached from any form, and its namesake is not', async t => {
  await eachStop(t, [
    ...macros,
    '(define-syntax-rule (hygienic-definition v)',
    '  (begin (define shared v) (void shared)))',
    '(def-getter thing 3)',
    '(hygienic-definition 1)',
    '(define shared 2)',
    '(define (reader)',
    "  (void 'stop-reader)",
    '  (get-thing))',
    '(define (other)',
    "  (void 'stop-other)",
    '  1)',
    '(reader) (other)'
  ], async (name, stop) => {
    assert.deepEqual(await stop.rows(), []);
    assert.equal((await ok(stop.hover('get-thing'))).result, '#<procedure:get-thing>', name);
    assert.equal((await ok(stop.console('(get-thing)'))).result, '3', name);
    assert.equal((await ok(stop.hover('shared'))).result, '2', name);
  });
});

test('names no source identifier refers to stay hidden', async t => {
  await eachStop(t, [
    ...macros,
    "(require racket/match)",
    '(define-syntax-rule (swap! a b)',
    "  (let ([tmp a]) (set! a b) (void 'stop-swap) (set! b tmp)))",
    '(define-syntax-rule (with-template-var body)',
    '  (let ([template-var 7]) body))',
    '(define (swapping x y)',
    '  (swap! x y)',
    '  x)',
    '(define (template)',
    '  (with-template-var',
    "   (void 'stop-template)))",
    '(define (or-form a)',
    '  (or #f',
    "      (void 'stop-or)))",
    '(define (for-form)',
    '  (for ([element (in-list (list 1))])',
    "    (void 'stop-for)))",
    '(define (for-vector)',
    '  (for ([element (in-vector (vector 1))])',
    "    (void 'stop-for-vector)))",
    '(define (match-form v)',
    '  (match v',
    '    [(list a (cons b _))',
    "     (void 'stop-match)",
    '     (+ a b)]))',
    '(define (keyword-form a #:k [k (add1 a)] [o 2])',
    "  (void 'stop-keyword)",
    '  (list a k o))',
    '(define (case-form v)',
    '  (case v',
    '    [(a)',
    "     (void 'stop-case)]))",
    "(swapping 1 2) (template) (or-form 1) (for-form) (for-vector) (match-form '(1 (2)))",
    "(keyword-form 1) (case-form 'a)"
  ], async (name, stop) => {
    const expected = {
      swap: ['x', 'y'], template: [], or: ['a'], for: ['element'], 'for-vector': ['element'],
      match: ['a', 'b', 'v'], keyword: ['a', 'k', 'o'], case: ['v']
    };
    assert.deepEqual(names(await stop.rows()), expected[name].sort(), name);
    for (const hidden of ['tmp', 'template-var', 'or-part', 'for-loop', 'pos']) {
      assert.equal((await stop.hover(hidden)).success, false, `${name}: ${hidden}`);
    }
  });
});

test('a warm cache lists the same names as the run that compiled them', async t => {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-variables-cache-'));
  t.after(() => fs.rm(cache, { recursive: true, force: true }));
  const lines = [
    ...macros,
    '(define (anaphoric v)',
    '  (aif v',
    '       (begin',
    "         (void 'stop-anaphoric)",
    '         it)',
    '       0))',
    '(anaphoric 9)'
  ];
  for (let run = 0; run < 2; run++) {
    await eachStop(t, lines, async (_, stop) => {
      assert.deepEqual(shown(await stop.rows()), { it: '9', v: '9' });
    }, { debugCacheDirectory: cache });
  }
});
