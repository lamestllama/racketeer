// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DapClient } = require('./dap-client');
const { until } = require('./support/wait');

const fixture = path.join(__dirname, 'fixtures', 'macro-template');
const program = path.join(fixture, 'use.rkt'), lib = path.join(fixture, 'lib.rkt');
const libLine = text => fs.readFileSync(lib, 'utf8').split('\n').findIndex(line => line.includes(text)) + 1;

async function start(t, { breakpoints, source = program, roots = [fixture], ...config }) {
  const client = new DapClient();
  t.after(() => client.close());
  await client.request('initialize', { adapterID: 'racketdap', linesStartAt1: true, columnsStartAt1: true });
  await client.request('launch', { program: source, sourceRoots: roots, ...config });
  await client.event('initialized');
  for (const [file, lines] of Object.entries(breakpoints)) {
    await client.request('setBreakpoints', { source: { path: file }, breakpoints: lines.map(line => ({ line })) });
  }
  await client.request('configurationDone');
  return client;
}
// Every stop until the program ends, resuming each with `resume`, as `seen` reports it.
async function stops(client, resume, seen) {
  const found = [];
  for (;;) {
    const event = await until(() => {
      if (client.fatalError) throw client.fatalError;
      const index = client.events.findIndex(({ event: name }) => name === 'stopped' || name === 'terminated');
      return index >= 0 && client.events.splice(index, 1)[0];
    }, 'the next stop or the end');
    if (event.event === 'terminated') return found;
    const { body } = await client.request('stackTrace', { threadId: event.body.threadId });
    const report = await seen(event, body.stackFrames[0]);
    if (report) found.push(report);
    await client.request(resume, { threadId: event.body.threadId });
  }
}
const basename = frame => path.basename(frame.source?.path || '');
const stdout = client => client.events.filter(event => event.event === 'output' && event.body.category === 'stdout')
  .map(event => event.body.output).join('');

test('a macro in another file stops, returns and shows variables as the gui-debugger annotator does', async t => {
  const theirs = JSON.parse(execFileSync('racket', [path.join(__dirname, 'support/annotator-stops.rkt'), program], { encoding: 'utf8' }));
  const text = fs.readFileSync(lib, 'utf8');
  const place = position => {
    const before = text.slice(0, position - 1).split('\n');
    return `${before.length}:${before.at(-1).length + 1}`;
  };
  const expected = theirs.stops.filter(stop => stop.file === 'lib.rkt')
    .map(stop => ({ at: place(stop.position), kind: stop.kind, results: stop.results, locals: stop.locals }));
  assert.ok(expected.length >= 12, `The annotator stopped ${expected.length} times in the macros' file`);

  const client = await start(t, { breakpoints: { [program]: [10] } });
  const ours = await stops(client, 'stepIn', async (event, frame) => {
    if (basename(frame) !== 'lib.rkt') return null;
    const { body: { scopes } } = await client.request('scopes', { frameId: frame.id });
    const rows = async name => {
      const scope = scopes.find(candidate => candidate.name.startsWith(name));
      return scope ? (await client.request('variables', { variablesReference: scope.variablesReference })).body.variables : [];
    };
    return {
      at: `${frame.line}:${frame.column}`,
      kind: /returned/i.test(event.body.description) ? 'after' : 'before',
      results: (await rows('Return values')).map(row => row.value),
      locals: Object.fromEntries((await rows('Locals')).map(row => [row.name, row.value]))
    };
  });
  assert.deepEqual(ours, expected);
  assert.equal(stdout(client), theirs.stdout);
});

test('a breakpoint in a macro\'s own file stops at each use, and again from the compiled cache', async t => {
  const line = libLine('(if (< value low)');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-macro-template-'));
  for (const run of ['built', 'reused']) {
    const client = await start(t, { breakpoints: { [lib]: [line] }, debugCacheDirectory: cache });
    const seen = await stops(client, 'continue', async (_event, frame) => `${basename(frame)}:${frame.line}`);
    assert.deepEqual(seen, [`lib.rkt:${line}`, `lib.rkt:${line}`], run);
    assert.equal(stdout(client), 'first\n2\n(2 2)\n5\n18\n', run);
    await client.close();
  }
});

test('a macro\'s own variables hide no name of the code written around them', async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-macro-variables-')));
  const source = path.join(directory, 'main.rkt');
  fs.writeFileSync(source, [
    '#lang racket/base',
    '(define-syntax-rule (wrapped body)',
    "  (let ([x 'macro])",
    "    (void 'in-template)",
    '    body))',
    '(define (f x)',
    '  (wrapped',
    '   (void x)))',
    '(f 1)',
    ''
  ].join('\n'));
  const client = await start(t, { source, roots: [directory], breakpoints: { [source]: [4, 8] } });
  const seen = await stops(client, 'continue', async (_event, frame) => {
    const { body: { scopes } } = await client.request('scopes', { frameId: frame.id });
    const { body: { variables } } = await client.request('variables', { variablesReference: scopes[0].variablesReference });
    return [frame.line, variables.find(row => row.name === 'x').value];
  });
  assert.deepEqual(seen, [[4, 'macro'], [8, '1']], 'In the template, x is the template\'s; in the code passed to it, x is that code\'s');
});

test('a template stops though it has the position and span of the code around it in another file', async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-macro-position-')));
  const template = '(displayln "x")';
  // The outermost form of a template takes the location of the macro's use.
  const library = `#lang racket/base\n(provide m)\n(define-syntax-rule (m)\n  (let ()\n    ${template}))\n`;
  const place = library.indexOf(template);
  const around = '(values    (m))';
  assert.equal(around.length, template.length);
  const head = '#lang racket/base\n(require "library.rkt")\n';
  const source = path.join(directory, 'main.rkt');
  fs.writeFileSync(path.join(directory, 'library.rkt'), library);
  fs.writeFileSync(source, `${head};${' '.repeat(place - head.length - 2)}\n${around}\n`);
  assert.equal(fs.readFileSync(source, 'utf8').indexOf(around), place);
  const client = await start(t, { source, roots: [directory], breakpoints: { [source]: [4] } });
  const seen = await stops(client, 'stepIn', async (_event, frame) => basename(frame));
  assert.ok(seen.includes('library.rkt'), seen.join());
});

test('a macro outside the program\'s own files reports the place it is used', async t => {
  const client = await start(t, { roots: [path.join(fixture, 'absent')], breakpoints: { [program]: [10] }, stopOnEntry: false });
  const seen = await stops(client, 'stepIn', async (_event, frame) => basename(frame));
  assert.ok(seen.length > 2);
  assert.ok(!seen.includes('lib.rkt'), seen.join());
  const racket = await start(t, { source: path.join(fixture, 'loop.rkt'), breakpoints: { [path.join(fixture, 'loop.rkt')]: [3] } });
  const inLoop = await stops(racket, 'stepIn', async (_event, frame) => basename(frame));
  assert.ok(inLoop.length > 2);
  assert.deepEqual([...new Set(inLoop)], ['loop.rkt'], 'Racket\'s own macros stay out');
});
