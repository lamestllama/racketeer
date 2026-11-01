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

async function prepare(t, lines, breakpoint, config = {}) {
  // Racket reports the directory the operating system resolved, such as
  // /private/var for /var on macOS, so the expected paths use that form too.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-inspection-')));
  const program = path.join(directory, 'specimen.rkt');
  await fs.writeFile(program, lines.join('\n') + '\n');
  const client = new DapClient();
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await ok(client.request('initialize', { linesStartAt1: true, columnsStartAt1: true }));
  await ok(client.request('launch', { program, cwd: directory, ...config }));
  await client.event('initialized');
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [breakpoint] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stopped.body.threadId }));
  return { client, program, stop: stopped.body, frame: stackFrames[0] };
}

async function finish(client, threadId) {
  await ok(client.request('continue', { threadId }));
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
}

test('Watch, hover, and Variables share rich previews and expandable syntax metadata', async t => {
  const lines = [
    '#lang racket/base',
    '(define (fold-leaf a b) (+ a b))',
    '(struct sample (label weight) #:transparent)',
    '(define (inspect leaves spectrum index parcel token fn)',
    '  (displayln "inspected"))',
    "(inspect '(ochre indigo) '#(2 7 12) (hasheq 'level 4)",
    "         (sample 'seed 17)",
    "         (datum->syntax #f '(mix 4 8) '(\"garden.rkt\" 6 2 41 9)) fold-leaf)"
  ];
  const { client, stop, frame } = await prepare(t, lines, { line: 5 });
  const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
  const { variables } = await ok(client.request('variables', { variablesReference: scopes[0].variablesReference }));
  const expected = {
    leaves: '(ochre indigo)', spectrum: '#(2 7 12)', index: '#hasheq((level . 4))',
    parcel: '#<sample seed 17>', token: '#<syntax: (mix 4 8)>', fn: '#<procedure:fold-leaf>'
  };
  for (const [expression, preview] of Object.entries(expected)) {
    const local = variables.find(variable => variable.name === expression);
    assert.equal(local.value, preview);
    assert.ok(local.variablesReference > 0);
    for (const context of ['watch', 'hover']) {
      const evaluated = await ok(client.request('evaluate', { frameId: frame.id, expression, context }));
      assert.equal(evaluated.result, preview);
      assert.equal(evaluated.type, local.type);
      assert.ok(evaluated.variablesReference > 0);
    }
  }
  const token = variables.find(variable => variable.name === 'token');
  assert.equal(token.type, 'syntax');
  const metadata = (await ok(client.request('variables', { variablesReference: token.variablesReference, start: 1, count: 5 }))).variables;
  assert.deepEqual(metadata.map(({ name, value }) => [name, value]), [
    ['source', '"garden.rkt"'], ['line', '6'], ['column', '2'], ['position', '41'], ['span', '9']
  ]);
  const fn = variables.find(variable => variable.name === 'fn');
  const arity = (await ok(client.request('variables', { variablesReference: fn.variablesReference }))).variables;
  assert.deepEqual(arity.map(({ name, value }) => [name, value]), [['arity', '2']]);
  await finish(client, stop.threadId);
});

test('Return values use the same container, syntax, and function previews', async t => {
  const lines = [
    '#lang racket/base',
    '(define (map-seed x) x)',
    "(define leaves '(olive willow))",
    "(define token (datum->syntax #f '(sprout 19)))",
    '(define-values (a b c) (values leaves token map-seed))',
    '(displayln "returned")'
  ];
  const { client, stop, frame } = await prepare(t, lines, { line: 5, column: lines[4].indexOf('))') + 1 });
  assert.equal(stop.racketdapStopKind, 'after');
  const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
  const returned = scopes.find(scope => scope.name.startsWith('Return values'));
  assert.ok(returned);
  const { variables } = await ok(client.request('variables', { variablesReference: returned.variablesReference }));
  assert.deepEqual(variables.map(variable => variable.value), ['(olive willow)', '#<syntax: (sprout 19)>', '#<procedure:map-seed>']);
  for (const [index, expression] of ['leaves', 'token', 'map-seed'].entries()) {
    assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression, context: 'watch' }))).result, variables[index].value);
  }
  await finish(client, stop.threadId);
});

test('plain-file definitions retain function names and arity during inspection', async t => {
  const lines = [
    '(define (graft x) (+ x 3))',
    '(displayln (object-name graft))'
  ];
  const { client, stop, frame } = await prepare(t, lines, { line: 2 }, { language: 'racket/base' });
  const value = await ok(client.request('evaluate', { frameId: frame.id, expression: 'graft', context: 'watch' }));
  assert.equal(value.result, '#<procedure:graft>');
  assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression: '(object-name graft)' }))).result, 'graft');
  const { variables } = await ok(client.request('variables', { variablesReference: value.variablesReference }));
  assert.deepEqual(variables.map(({ name, value }) => [name, value]), [['arity', '1']]);
  await finish(client, stop.threadId);
});

test('Watch, hover, and Variables preserve escaped symbol and keyword spellings', async t => {
  const lines = [
    '#lang racket/base',
    '(define (inspect label option datum)',
    '  (displayln "escaped"))',
    '(inspect (string->symbol "blue bud") (string->keyword "stem;leaf")',
    '         (datum->syntax #f (list (string->symbol "blue bud") (string->keyword "stem;leaf"))))'
  ];
  const { client, stop, frame } = await prepare(t, lines, { line: 3 });
  const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
  const { variables } = await ok(client.request('variables', { variablesReference: scopes[0].variablesReference }));
  for (const [expression, preview] of [
    ['label', '|blue bud|'], ['option', '#:|stem;leaf|'], ['datum', '#<syntax: (|blue bud| #:|stem;leaf|)>']
  ]) {
    assert.equal(variables.find(value => value.name === expression).value, preview);
    for (const context of ['watch', 'hover']) {
      assert.equal((await ok(client.request('evaluate', { frameId: frame.id, expression, context }))).result, preview);
    }
  }
  await finish(client, stop.threadId);
});

test('known ports expose inert names and state while delegated or wrapped factories remain conservative', async t => {
  const lines = [
    '#lang racket/base',
    '(define effects 0)',
    '(struct label ()',
    '  #:property prop:custom-write (lambda args (set! effects (add1 effects)))',
    "  #:property prop:object-name (lambda (_) (set! effects (add1 effects)) 'changed))",
    '(struct delegated (port)',
    '  #:property prop:input-port 0',
    "  #:property prop:object-name (lambda (_) (set! effects (add1 effects)) 'changed))",
    '(define input (open-input-string "fir" \'canopy))',
    '(define output (open-output-string "log book"))',
    '(close-output-port output)',
    '(define alias open-input-string)',
    '(define from-alias (alias "elm" \'alias-name))',
    '(define-values (reader writer) (make-pipe 16 \'branch-in \'branch-out))',
    '(define custom (make-input-port (label)',
    '  (lambda (_) (set! effects (add1 effects)) eof)',
    '  (lambda (_ _skip _evt) (set! effects (add1 effects)) eof)',
    '  (lambda () (set! effects (add1 effects)))))',
    '(define wrapped (chaperone-struct (delegated input) delegated-port',
    '                 (lambda (_ value) (set! effects (add1 effects)) value)))',
    '(define through (delegated wrapped))',
    '(define disguised (procedure-rename (lambda args through) \'open-input-string))',
    '(define spoof (disguised "ignored"))',
    '(define wrapped-factory (chaperone-procedure open-input-string (lambda args (apply values args))))',
    '(define from-wrapper (wrapped-factory "ash" \'not-registered))',
    '(define file-factory open-input-file)',
    '(define file (file-factory (build-path (current-directory) "specimen.rkt")))',
    '(define optimized-file (open-input-file (build-path (current-directory) "specimen.rkt")))',
    '(define keyword-file (open-input-file (build-path (current-directory) "specimen.rkt") #:mode \'binary))',
    '(define applied (apply open-input-string \'("oak" indirect-name)))',
    '(define cycle (box #f)) (set-box! cycle cycle)',
    '(define cyclic-name (open-input-string "" cycle))',
    '(define long-name (open-input-string "" (make-string 50000 #\\z)))',
    '(set! effects 0)',
    '(displayln "inspect ports")',
    '(displayln (list (read-string 3 input) effects))'
  ];
  const { client, program, stop, frame } = await prepare(t, lines, { line: lines.indexOf('(displayln "inspect ports")') + 1 });
  const inspect = expression => ok(client.request('evaluate', { frameId: frame.id, expression, context: 'watch' }));
  for (const [expression, preview, name, closed] of [
    ['input', '#<input-port:canopy>', 'canopy', '#f'],
    ['output', '#<output-port:"log book">', '"log book"', '#t'],
    ['from-alias', '#<input-port:alias-name>', 'alias-name', '#f'],
    ['reader', '#<input-port:branch-in>', 'branch-in', '#f'],
    ['writer', '#<output-port:branch-out>', 'branch-out', '#f']
  ]) {
    const value = await inspect(expression);
    assert.equal(value.result, preview);
    assert.ok(value.variablesReference > 0);
    const { variables } = await ok(client.request('variables', { variablesReference: value.variablesReference }));
    assert.deepEqual(variables.map(({ name, value }) => [name, value]), [
      ['direction', expression === 'output' || expression === 'writer' ? 'output-port' : 'input-port'],
      ['name', name], ['closed?', closed]
    ]);
    const page = (await ok(client.request('variables', { variablesReference: value.variablesReference, start: 2, count: 1 }))).variables;
    assert.deepEqual(page.map(({ name, value }) => [name, value]), [['closed?', closed]]);
  }
  const custom = await inspect('custom');
  assert.equal(custom.result, '#<input-port:#<label>>');
  const metadata = (await ok(client.request('variables', { variablesReference: custom.variablesReference }))).variables;
  assert.equal(metadata.find(value => value.name === 'name').value, '#<label>');
  assert.equal(metadata.find(value => value.name === 'closed?').value, '#f');
  assert.equal((await inspect('cyclic-name')).result, '#<input-port:#&#<cycle>>');
  assert.ok((await inspect('long-name')).result.length <= 161);
  const file = await inspect('file');
  assert.equal(file.result, `#<input-port:${program}>`);
  assert.ok(file.variablesReference > 0);
  for (const expression of ['through', 'spoof', 'from-wrapper', 'optimized-file', 'keyword-file', 'applied']) {
    assert.equal((await inspect(expression)).result, '#<input-port>');
  }
  assert.equal((await inspect('(vector custom through)')).result, '#(#<input-port:#<label>> #<input-port>)');
  assert.equal((await inspect('effects')).result, '0');
  assert.equal((await inspect('(eq? input (delegated-port (delegated input)))')).result, '#t');
  await finish(client, stop.threadId);
  const output = client.events.filter(event => event.event === 'output' && event.body.category === 'stdout')
    .map(event => event.body.output).join('');
  assert.equal(output, 'inspect ports\n(fir 0)\n');
});
