// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const treeRemoval = require('./support/tree-removal');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
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
  const client = new DapClient();
  t.after(async () => { await client.close(); await fs.rm(directory, treeRemoval); });
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
  t.after(() => fs.rm(cache, treeRemoval));
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

const classes = [
  '#lang racket/base',
  '(require racket/class)',
  '(define counter%',
  '  (class object%',
  '    (init-field start)',
  '    (field [count start])',
  '    (define hidden 5)',
  '    (super-new)',
  "    (void 'stop-class-body)",
  '    (define/public (bump step)',
  '      (define next (+ count step hidden))',
  "      (void 'stop-method)",
  '      (set! count next)',
  '      next)',
  '    (define/public (read) (map (lambda (x)',
  "                                 (void 'stop-closure)",
  '                                 (+ x count)) (list 1)))',
  '    (define/public (no-arguments)',
  "      (void 'stop-no-arguments)",
  '      count)',
  '    (define/public (by-tail-send) (send this no-arguments))',
  '    (define/public (with-keyword #:k [k 1] [o 2])',
  "      (void 'stop-keyword)",
  '      (list k o))))',
];

test('a method, an initialiser and a closure in a class show this, and it opens to the fields', async t => {
  const { seen, output } = await eachStop(t, [
    ...classes,
    '(define obj (new counter% [start 1]))',
    '(send obj bump 2)',
    '(send obj read)',
    '(send obj by-tail-send)',
    '(send obj with-keyword #:k 3)',
    '(define (not-a-class self1)',
    "  (void 'stop-not-a-class)",
    '  self1)',
    '(not-a-class 4)'
  ], async (name, stop) => {
    const rows = await stop.rows();
    const expected = {
      'class-body': ['start', 'this'], method: ['count', 'hidden', 'next', 'step', 'this'],
      closure: ['count', 'this', 'x'], 'no-arguments': ['count', 'this'], keyword: ['k', 'o', 'this'],
      'not-a-class': ['self1']
    };
    assert.deepEqual(names(rows), expected[name].sort(), name);
    if (name === 'not-a-class') {
      assert.equal(shown(rows).self1, '4');
      return;
    }
    if (name === 'class-body') assert.equal(shown(rows).this, '#<object:counter% 1 1 5>');
    if (name !== 'method') return;
    const object = rows.find(row => row.name === 'this');
    assert.equal(object.value, '#<object:counter% 1 1 5>');
    assert.equal(object.type, 'object:counter%');
    assert.equal(object.indexedVariables, 3);
    // Fields are numbered in the order of the object's structure: the program's inspector
    // gives their values, and the class alone knows their names.
    assert.deepEqual((await stop.open(object.variablesReference)).map(row => [row.name, row.value]),
      [['0', '1'], ['1', '1'], ['2', '5']]);
    for (const read of [stop.hover, stop.watch, stop.console]) {
      assert.equal((await ok(read('this'))).result, '#<object:counter% 1 1 5>');
    }
    assert.equal((await ok(stop.console('(get-field count this)'))).result, '1');
    // The object cannot be assigned here any more than in the class.
    const assigned = await stop.set('this', '1');
    assert.equal(assigned.success, false);
    assert.match(assigned.message, /this cannot be assigned/);
    const fromConsole = await stop.console('(set! this 1)');
    assert.equal(fromConsole.success, false);
    assert.match(fromConsole.message, /cannot be assigned/);
    assert.equal(shown(await stop.rows()).this, '#<object:counter% 1 1 5>');
    // This method's code does not touch start, so it stays a numbered field of this.
    const hovered = await stop.hover('start');
    assert.equal(hovered.success, false);
    assert.match(hovered.message, /no source-visible variable named start/);
    assert.equal((await stop.console('start')).success, false);
  });
  assert.deepEqual(seen, ['class-body', 'method', 'closure', 'no-arguments', 'keyword', 'not-a-class']);
  assert.equal(output, "8\n'(9)\n8\n'(3 2)\n4\n");
});

test('a subclass, super, a mixin and a class in a method each show their own object', async t => {
  const { seen, output } = await eachStop(t, [
    ...classes,
    '(define sub%',
    '  (class counter%',
    '    (field [extra',
    "            (begin (void 'stop-field-initialiser)",
    '                   7)])',
    '    (super-new)',
    '    (define/override (bump step)',
    "      (void 'stop-override)",
    '      (super bump (+ step extra)))',
    '    (define/public (make-inner)',
    '      (new (class object%',
    '             (super-new)',
    '             (define/public (inside)',
    "               (void 'stop-inner)",
    '               1))))))',
    '(define (mixin %)',
    '  (class %',
    '    (field [m 9])',
    '    (super-new)',
    '    (define/public (mixed)',
    "      (void 'stop-mixin)",
    '      (+ m 1))))',
    '(define own-this%',
    '  (class object%',
    '    (super-new)',
    '    (define/public (take this)',
    "      (void 'stop-own-this)",
    '      this)))',
    '(define s (new sub% [start 1]))',
    '(send s bump 2)',
    '(send (send s make-inner) inside)',
    '(send (new (mixin counter%) [start 4]) mixed)',
    "(send (new own-this%) take 'mine)"
  ], async (name, stop) => {
    const object = (await stop.rows()).find(row => row.name === 'this');
    assert.ok(object, name);
    if (name === 'field-initialiser') {
      // Reads what is there: nothing has been stored in any field yet.
      assert.equal(object.value, '#<object:sub% <uninitialized> <uninitialized> <uninitialized> <uninitialized>>');
      assert.deepEqual((await stop.open(object.variablesReference)).map(row => row.value),
        Array(4).fill('<uninitialized>'));
    } else if (name === 'override' || name === 'method') {
      assert.match(object.value, /^#<object:sub% \d+ 1 5 7>$/, name);
      assert.equal((await stop.open(object.variablesReference)).at(-1).value, '7');
    } else if (name === 'inner') {
      assert.match(object.value, /^#<object:.*>$/);
      assert.doesNotMatch(object.value, /sub%/);
    } else if (name === 'mixin') {
      assert.match(object.value, / 4 4 5 9>$/);
    } else if (name === 'own-this') {
      // A parameter the source names this is what the source reads.
      assert.equal(object.value, 'mine');
      assert.equal((await ok(stop.hover('this'))).result, 'mine');
    }
  });
  assert.ok(seen.includes('field-initialiser') && seen.includes('override') && seen.includes('method') &&
    seen.includes('inner') && seen.includes('mixin') && seen.includes('own-this'), seen.join());
  assert.equal(output, "15\n1\n10\n'mine\n");
});

test('an object seen before its fields are set is still shown, with the unset ones as such', async t => {
  await eachStop(t, [
    '#lang racket/base',
    '(require racket/class)',
    ';; Calling a method in the body lets this be seen before late is set, so the class makes',
    ';; each object a chaperone that refuses to read an unset field.',
    '(define early%',
    '  (class object%',
    '    (super-new)',
    '    (define/public (peek)',
    "      (void 'stop-during-initialisation)",
    '      1)',
    '    (send this peek)',
    '    (field [late 2])',
    '    (define/public (read)',
    "      (void 'stop-after-initialisation)",
    '      late)))',
    '(send (new early%) read)'
  ], async (name, stop) => {
    const object = (await stop.rows()).find(row => row.name === 'this');
    const value = name === 'during-initialisation' ? '<uninitialized>' : '2';
    assert.equal(object.value, `#<object:early% ${value}>`);
    assert.equal(object.indexedVariables, 1);
    assert.deepEqual((await stop.open(object.variablesReference)).map(row => row.value), [value]);
  });
});

test('a scope with more names than a page returns them all, first and last', async t => {
  const count = 251;
  await eachStop(t, [
    '#lang racket/base',
    '(define (many first-argument second-argument)',
    ...Array.from({ length: count - 2 }, (_, i) => `  (define v${i} ${i})`),
    "  (void 'stop-many)",
    '  first-argument)',
    '(many 1 2)'
  ], async (_, stop) => {
    const rows = await stop.rows();
    assert.equal(rows.length, count);
    assert.deepEqual(rows.slice(-2).map(row => row.name), ['first-argument', 'second-argument']);
    assert.ok(rows.some(row => row.name === 'v0') && rows.some(row => row.name === 'v248'));
    assert.deepEqual((await stop.rows({ start: 250, count: 5 })).map(row => row.name), ['second-argument']);
    assert.equal((await stop.rows({ start: 100, count: 100 }))[0].name, rows[100].name);
    assert.deepEqual(await stop.rows({ filter: 'indexed' }), []);
  });
});

test('containers report their sizes and page as they are asked', async t => {
  await eachStop(t, [
    '#lang racket/base',
    '(struct triple (a b c))',
    '(struct level0 (f0))',
    ...Array.from({ length: 39 }, (_, i) => `(struct level${i + 1} level${i} (f${i + 1}))`),
    '(define (containers v h l s b p deep)',
    "  (void 'stop-containers)",
    '  1)',
    '(containers (build-vector 150 values) (for/hash ([i 150]) (values i i)) (build-list 150 values)',
    `            (triple 1 2 3) (box 1) add1 (level39 ${Array.from({ length: 40 }, (_, i) => i).join(' ')}))`
  ], async (_, stop) => {
    const rows = Object.fromEntries((await stop.rows()).map(row => [row.name, row]));
    const sizes = name => [rows[name].indexedVariables, rows[name].namedVariables];
    assert.deepEqual(sizes('v'), [150, undefined]);
    assert.deepEqual(sizes('h'), [150, undefined]);
    assert.deepEqual(sizes('s'), [3, undefined]);
    assert.deepEqual(sizes('l'), [undefined, 2]);
    assert.deepEqual(sizes('b'), [undefined, 1]);
    assert.deepEqual(sizes('p'), [undefined, 1]);
    // The preview budget does not hide the container's size.
    assert.deepEqual(sizes('deep'), [40, undefined]);
    assert.equal((await stop.open(rows.deep.variablesReference)).length, 40);
    const vector = rows.v.variablesReference;
    assert.equal((await stop.open(vector)).length, 150);
    const page = await stop.open(vector, { start: 100, count: 100 });
    assert.deepEqual([page.length, page[0].name, page[0].value, page.at(-1).name], [50, '100', '100', '149']);
    assert.deepEqual((await stop.open(vector, { start: 100 })).length, 50);
    assert.deepEqual((await stop.open(vector, { start: 149, count: 1, filter: 'indexed' })).map(row => row.value), ['149']);
    assert.deepEqual(await stop.open(vector, { filter: 'named' }), []);
    assert.deepEqual((await stop.open(vector, { count: 0 })).length, 150);
    assert.deepEqual(await stop.open(rows.l.variablesReference, { filter: 'indexed' }), []);
    assert.deepEqual((await stop.open(rows.l.variablesReference, { filter: 'named' })).map(row => row.name), ['car', 'cdr']);
    assert.equal((await stop.open(rows.h.variablesReference, { start: 100, count: 100 })).length, 50);
    // A watch and a hover carry the sizes too, so a client pages them the same way.
    assert.equal((await ok(stop.watch('v'))).indexedVariables, 150);
    assert.equal((await ok(stop.hover('v'))).indexedVariables, 150);
  });
});

test('a vector of a million opens in pages at once, and an unpaged request says where it ended', async t => {
  await eachStop(t, [
    '#lang racket/base',
    '(define (enormous million)',
    "  (void 'stop-enormous)",
    '  1)',
    '(enormous (make-vector 1000000 7))'
  ], async (_, stop) => {
    const [row] = await stop.rows();
    assert.equal(row.value, '#(7 7 7 7 7 7 …)');
    assert.equal(row.indexedVariables, 1000000);
    const page = await stop.open(row.variablesReference, { start: 999900, count: 100 });
    assert.deepEqual([page.length, page[0].name, page.at(-1).name], [100, '999900', '999999']);
    assert.equal((await stop.open(row.variablesReference, { start: 20000, count: 300 })).length, 300);
    const unpaged = await stop.open(row.variablesReference);
    assert.equal(unpaged.length, 10001);
    assert.equal(unpaged[9999].name, '9999');
    assert.equal(unpaged[10000].name, '…');
    assert.equal(unpaged[10000].value, '990000 more rows: ask for them by start and count');
    assert.equal(unpaged[10000].variablesReference, 0);
    const later = await stop.open(row.variablesReference, { start: 995000 });
    assert.equal(later.length, 5000);
    assert.equal(later.at(-1).name, '999999');
  });
});

const fields = [
  '#lang racket/base',
  '(require racket/class)',
  '(define count 99)',
  '(define counter%',
  '  (class object%',
  '    (field [count 5] [(inner outer) 3] [never 9] [written 0] [call add1])',
  '    (define hidden 7)',
  '    (super-new)',
  '    (define-syntax-rule (from-template) never)',
  '    (define/public (bump step)',
  '      (define next (+ count step hidden inner))',
  "      (void 'stop-bump)",
  '      (set! count next)',
  "      (void 'stop-assigned)",
  '      count)',
  '    (define/public (writes)',
  "      (void 'stop-writes)",
  '      (set! written 6))',
  '    (define/public (calls)',
  "      (void 'stop-calls)",
  '      (call 1))',
  '    (define/public (touches-nothing)',
  "      (void 'stop-touches-nothing)",
  '      1)',
  '    (define/public (in-closure)',
  '      ((lambda (x)',
  "         (void 'stop-in-closure)",
  '         (+ x hidden)) 1))',
  '    (define/public (own-parameter count)',
  "      (void 'stop-own-parameter)",
  '      count)',
  '    (define/public (own-local)',
  '      (let ([hidden 1])',
  "        (void 'stop-own-local)",
  '        hidden))',
  '    (define/public (by-template)',
  "      (void 'stop-by-template)",
  '      (from-template))',
  '    (define/public (by-reflection)',
  "      (void 'stop-by-reflection)",
  '      (set-field! never this (get-field never this)))))'
];

test('a field the source reads or assigns is a row, and reads and writes the field', async t => {
  const { output } = await eachStop(t, [
    ...fields,
    '(define obj (new counter%))',
    '(send obj bump 1)',
    '(send obj writes)',
    '(get-field written obj)',
    '(send obj calls)'
  ], async (name, stop) => {
    const rows = shown(await stop.rows());
    if (name === 'bump') {
      assert.deepEqual(rows, { next: '16', step: '1', this: '#<object:counter% 5 3 9 0 #<procedure:add1> 7>', count: '5', inner: '3', hidden: '7' });
      assert.equal((await ok(stop.hover('count'))).result, '5');
      assert.equal((await ok(stop.hover('hidden'))).result, '7');
      assert.equal((await ok(stop.watch('(* count 2)'))).result, '10');
      assert.equal((await ok(stop.console('count'))).result, '5');
      // A name the file renames is the name the file reads. A field not touched has no row.
      assert.equal((await stop.hover('outer')).success, false);
      assert.equal((await stop.hover('never')).success, false);
      assert.equal((await ok(stop.set('hidden', '70'))).value, '70');
      assert.equal(shown(await stop.rows()).hidden, '70');
      assert.match(shown(await stop.rows()).this, / 70>$/);
      assert.equal((await ok(stop.console('(set! inner 30)'))).variablesReference, 0);
      assert.equal(shown(await stop.rows()).inner, '30');
    } else if (name === 'assigned') {
      assert.equal(rows.count, '16');
      assert.equal((await ok(stop.set('count', '100'))).value, '100');
    } else if (name === 'writes') {
      // Assigned but not read: the row reads through the accessor declared with its mutator.
      assert.equal(rows.written, '0');
    } else {
      assert.equal(rows.call, '#<procedure:add1>');
      assert.equal((await ok(stop.console('(call 2)'))).result, '3');
    }
  });
  assert.equal(output, '100\n6\n2\n');
});

test('a row belongs to the method whose code touches the field, and to nothing else', async t => {
  await eachStop(t, [
    ...fields,
    '(define (outside o)',
    "  (void 'stop-outside)",
    '  (set-field! never o 1)',
    '  (get-field never o))',
    '(define obj (new counter%))',
    '(send obj touches-nothing) (send obj in-closure) (send obj own-parameter 1) (send obj own-local)',
    '(send obj by-template) (send obj by-reflection) (outside obj)'
  ], async (name, stop) => {
    const rows = shown(await stop.rows());
    const fieldRows = names(await stop.rows()).filter(row => !['this', 'x', 'o'].includes(row));
    const expected = {
      'touches-nothing': [], 'in-closure': ['hidden'], 'own-parameter': ['count'], 'own-local': ['hidden'],
      'by-template': [], 'by-reflection': [], outside: []
    };
    assert.deepEqual(fieldRows, expected[name], name);
    // The module's definition of the same name stands where the field is not read.
    if (name === 'touches-nothing' || name === 'outside') assert.equal((await ok(stop.hover('count'))).result, '99');
    if (name === 'in-closure') assert.equal(rows.hidden, '7');
    if (name === 'own-parameter') assert.equal(rows.count, '1');
    if (name === 'own-local') assert.equal(rows.hidden, '1');
  });
});

test('an inherited field is a row, and can be assigned where the class assigns it', async t => {
  const { output } = await eachStop(t, [
    '#lang racket/base',
    '(require racket/class)',
    '(define base%',
    '  (class object%',
    '    (field [read-here 1] [both 2] [written-here 3])',
    '    (super-new)))',
    '(define sub%',
    '  (class base%',
    '    (inherit-field read-here both written-here)',
    '    (super-new)',
    '    (define/public (reads)',
    "      (void 'stop-reads)",
    '      (+ read-here both))',
    '    (define/public (writes)',
    '      (set! both 20)',
    '      (set! written-here 30)',
    "      (void 'stop-writes))))",
    '(define obj (new sub%))',
    '(send obj reads)',
    '(send obj writes)',
    '(send obj reads)'
  ], async (name, stop) => {
    const rows = shown(await stop.rows());
    if (name === 'writes') {
      // The class form names no accessor for a field only assigned through inherit-field.
      assert.deepEqual(names(await stop.rows()), ['both', 'this']);
      assert.equal((await ok(stop.set('both', '40'))).value, '40');
      return;
    }
    assert.deepEqual(names(await stop.rows()), ['both', 'read-here', 'this']);
    assert.equal(rows['read-here'], '1');
    assert.equal((await ok(stop.hover('read-here'))).result, '1');
    // Only read in this class: the expansion names no mutator for it, so the row says so.
    const refused = await stop.set('read-here', '5');
    assert.equal(refused.success, false);
    assert.match(refused.message, /read-here cannot be assigned/);
  });
  assert.equal(output, '3\n41\n');
});

test('a field before it is set reads as uninitialized, with or without the class guarding it', async t => {
  await eachStop(t, [
    '#lang racket/base',
    '(require racket/class)',
    '(define plain%',
    '  (class object%',
    '    (super-new)',
    '    (field [unset (begin',
    "                    (void 'stop-plain)",
    '                    1)]',
    '           [after unset])))',
    '(define guarded%',
    '  (class object%',
    '    (super-new)',
    '    (define/public (peek)',
    "      (void 'stop-guarded)",
    '      (when #f late))',
    '    (send this peek)',
    '    (field [late 2])',
    '    (define/public (read)',
    "      (void 'stop-set)",
    '      late)))',
    '(define unguarded%',
    '  (class object%',
    '    (field [early 1])',
    "    (void 'stop-unguarded)",
    '    (field [later 2])',
    '    (super-new)))',
    '(new plain%)',
    '(send (new guarded%) read)',
    '(new unguarded%)'
  ], async (name, stop) => {
    const rows = Object.fromEntries((await stop.rows()).map(row => [row.name, row]));
    if (name === 'unguarded') {
      // With no guard, the object holds the undefined value itself, and a read gets it.
      assert.equal((await ok(stop.console('(impersonator? this)'))).result, '#f');
      assert.equal(rows.this.value, '#<object:unguarded% 1 <uninitialized>>');
      assert.deepEqual((await stop.open(rows.this.variablesReference)).map(row => row.value), ['1', '<uninitialized>']);
      return;
    }
    const field = name === 'plain' ? 'unset' : 'late';
    if (name === 'set') {
      assert.equal(rows.late.value, '2');
      return;
    }
    assert.equal(rows[field].value, '<uninitialized>');
    assert.equal(rows[field].type, 'unavailable');
    assert.equal((await ok(stop.hover(field))).result, '<uninitialized>');
    if (name === 'guarded') {
      // The program's own read would raise here, and so does the console's, as an answer.
      const read = await stop.console(field);
      assert.equal(read.success, false);
      assert.match(read.message, /late/);
      const assigned = await stop.set(field, '1');
      assert.equal(assigned.success, false);
      assert.equal(shown(await stop.rows())[field], '<uninitialized>');
    }
  });
});

test('a chaperone of the program is not run to fill a row, and the console runs it when asked', async t => {
  const { output } = await eachStop(t, [
    '#lang racket/base',
    '(require racket/class)',
    '(define effects 0)',
    '(define open%',
    '  (class object%',
    '    (inspect #f)',
    '    (field [watched 1])',
    '    (super-new)',
    '    (define/public (read)',
    "      (void 'stop-read)",
    '      watched)))',
    '(define obj (new open%))',
    '(define-values (type skipped) (struct-info obj))',
    '(define-values (name init auto ref set immutable super skip) (struct-type-info type))',
    '(define wrapped',
    '  (chaperone-struct obj (make-struct-field-accessor ref 0)',
    '                    (lambda (self value) (set! effects (add1 effects)) value)))',
    '(send wrapped read)',
    'effects'
  ], async (name, stop) => {
    const rows = Object.fromEntries((await stop.rows()).map(row => [row.name, row]));
    const shownWrapped = '<wrapped value; inspect explicitly in the console>';
    assert.equal(rows.this.value, shownWrapped);
    assert.equal(rows.this.type, 'wrapped value');
    assert.equal(rows.this.variablesReference, 0);
    assert.equal(rows.watched.value, shownWrapped);
    assert.equal((await ok(stop.hover('watched'))).result, shownWrapped);
    assert.equal((await ok(stop.console('effects'))).result, '0');
    assert.equal((await ok(stop.console('watched'))).result, '1');
    assert.equal((await ok(stop.console('effects'))).result, '1');
  });
  assert.equal(output, '1\n2\n');
});

test('rows are read at every stop and the program prints what it prints without the debugger', async t => {
  const lines = [
    ...fields,
    '(define sub%',
    '  (class counter%',
    '    (inherit-field count)',
    '    (super-new)',
    '    (define/override (bump step)',
    "      (void 'stop-override)",
    '      (super bump (+ step count)))',
    '    (define/public (keyword #:k [k count] [o k])',
    "      (void 'stop-keyword)",
    '      (list k o count))))',
    '(define in-long-body',
    '  (let ()',
    ...Array.from({ length: 40 }, (_, i) => `    (define d${i} ${i})`),
    '    (define obj (new (class counter%',
    '                       (inherit-field written)',
    '                       (super-new)',
    '                       (define/public (late)',
    "                         (void 'stop-in-long-body)",
    '                         (+ written d39)))))',
    '    (send obj late)))',
    'in-long-body',
    '(define o (new sub%))',
    '(send o bump 1)',
    '(send o keyword)',
    '(send o touches-nothing)',
    '(get-field written o)'
  ];
  const { seen, output } = await eachStop(t, lines, async (name, stop) => {
    const first = await stop.rows();
    for (const row of first) await stop.hover(row.name);
    assert.deepEqual((await stop.rows()).map(row => row.value), first.map(row => row.value), name);
    if (name === 'in-long-body') assert.equal(shown(first).written, '0');
    if (name === 'keyword') assert.equal(shown(first).count, shown(first).k);
  });
  assert.ok(seen.includes('in-long-body') && seen.includes('override') && seen.includes('keyword'), seen.join());
  const program = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-variables-plain-')), 'specimen.rkt');
  t.after(() => fs.rm(path.dirname(program), treeRemoval));
  await fs.writeFile(program, lines.join('\n') + '\n');
  const { stdout } = await promisify(execFile)('racket', [program]);
  assert.equal(output, stdout);
});
