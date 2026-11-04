// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DapClient } = require('./dap-client');

async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function prepare(t, source, { oneBased = true, ...config } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-breakpoint-lifecycle-'));
  const program = path.join(directory, 'main.rkt');
  await fs.writeFile(program, source);
  const client = new DapClient();
  t.after(async () => { try { await client.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  await ok(client.request('initialize', { linesStartAt1: oneBased, columnsStartAt1: oneBased }));
  await ok(client.request('launch', { program, sourceRoots: [], ...config }));
  await client.event('initialized');
  return { client, program, directory };
}

for (const oneBased of [true, false]) {
  const base = oneBased ? 1 : 0;
  test(`malformed ${base}-based breakpoints are rejected before replacing pending or loaded state`, async t => {
    const { client, program } = await prepare(t,
      '#lang racket/base\n(define result (+ 1 2))\n(displayln result)\n', { oneBased });
    const source = { path: program };
    const valid = { line: 2 + base };
    const original = (await ok(client.request('setBreakpoints', { source, breakpoints: [valid] }))).breakpoints[0];
    assert.equal(original.verified, false);
    const malformed = [
      { ...valid, phase: 'during' }, { ...valid, phase: false }, { ...valid, phase: null },
      { line: '3' }, { line: 2.5 }, { line: base - 1 }, { line: false }, { line: null }, {},
      { ...valid, column: '3' }, { ...valid, column: 1.5 }, { ...valid, column: base - 1 },
      { ...valid, column: null }, { ...valid, column: false }, null, false
    ];
    for (const invalid of malformed) {
      const response = await client.request('setBreakpoints', {
        source, breakpoints: [{ line: 1 + base }, invalid]
      });
      assert.equal(response.success, false, `Must reject ${JSON.stringify(invalid)}`);
    }
    assert.equal((await client.request('setBreakpoints', { source, breakpoints: {} })).success, false);
    await ok(client.request('configurationDone'));
    const stop = await client.event('stopped');
    assert.equal(stop.body.reason, 'breakpoint');
    assert.deepEqual(stop.body.hitBreakpointIds, [original.id]);
    const stack = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
    assert.equal(stack.stackFrames[0].line, valid.line);
    // Repeat the malformed request after resolution, where it used to replace
    // the table before select-targets raised its error.
    assert.equal((await client.request('setBreakpoints', {
      source, breakpoints: [{ line: 1 + base }, { ...valid, phase: 'during' }]
    })).success, false);
    const retained = (await ok(client.request('setBreakpoints', { source, breakpoints: [valid] }))).breakpoints[0];
    assert.equal(retained.id, original.id);
    assert.equal(retained.verified, true);
    await ok(client.request('setBreakpoints', { source, breakpoints: [] }));
    await ok(client.request('continue', { threadId: stop.body.threadId }));
    await client.event('terminated');
    assert.equal((await client.event('exited')).body.exitCode, 0);
  });

  test(`breakpointLocations respects partial and multiline ${base}-based ranges`, async t => {
    const lines = ['#lang racket/base', '(define a (+ 1 2)) (define b (+ 3 4))', '(define c', '  (+ a b))'];
    const { client, program } = await prepare(t, lines.join('\n') + '\n', { oneBased, interactive: true });
    await ok(client.request('configurationDone'));
    await client.event('racketdap/ready');
    const locations = async range => (await ok(client.request('breakpointLocations', { source: { path: program }, ...range }))).breakpoints;
    const full = await locations({ line: base, endLine: 3 + base });
    assert.ok(full.length > 2);
    assert.deepEqual(full, [...full].sort((left, right) => left.line - right.line || left.column - right.column));
    const line = 1 + base;
    const inLine = full.filter(location => location.line === line);
    assert.deepEqual(await locations({ line }), inLine, 'Missing endLine means the start line');
    assert.deepEqual(await locations({ line, column: base }), inLine, 'Missing endColumn includes the rest of the line');
    const firstColumn = lines[1].indexOf('(+ 3') + base;
    const endColumn = lines[1].indexOf(')', firstColumn - base) + base;
    const partial = inLine.filter(location => location.column >= firstColumn && location.column <= endColumn);
    assert.ok(partial.length > 0 && partial.length < inLine.length);
    assert.deepEqual(await locations({ line, column: firstColumn, endColumn }), partial);
    assert.deepEqual(await locations({ line, endColumn: firstColumn }), inLine.filter(location => location.column <= firstColumn),
      'Missing column starts at the client coordinate base');
    assert.deepEqual(await locations({ line, column: firstColumn, endColumn: firstColumn }),
      inLine.filter(location => location.column === firstColumn), 'An exact boundary is included');
    const endLine = 3 + base;
    const multilineColumn = 2 + base;
    assert.deepEqual(await locations({ line, column: firstColumn, endLine, endColumn: multilineColumn }),
      full.filter(location => location.line >= line && location.line <= endLine &&
        (location.line > line || location.column >= firstColumn) &&
        (location.line < endLine || location.column <= multilineColumn)));
    assert.equal((await client.request('breakpointLocations', {
      source: { path: program }, line, column: endColumn, endColumn: firstColumn - 1
    })).success, false);
  });

  test(`captured source references identify ${base}-based breakpoints without a filesystem path`, async t => {
    const { client, program, directory } = await prepare(t,
      '#lang racket/base\n(define result (+ 1 2))\n(displayln result)\n', { oneBased, stopOnEntry: true });
    await ok(client.request('configurationDone'));
    const entry = await client.event('stopped');
    await fs.appendFile(program, '; saved during the stop\n');
    const stack = await ok(client.request('stackTrace', { threadId: entry.body.threadId }));
    const { sourceReference } = stack.stackFrames[0].source;
    const line = 2 + base;
    const expected = await ok(client.request('breakpointLocations', { source: { path: program, sourceReference: 0 }, line }));
    let breakpoint;
    for (const source of [{ sourceReference }, { sourceReference, path: path.join(directory, 'unrelated.rkt') }]) {
      assert.deepEqual(await ok(client.request('breakpointLocations', { source, line })), expected);
      breakpoint = (await ok(client.request('setBreakpoints', { source, breakpoints: [{ line }] }))).breakpoints[0];
      assert.equal(breakpoint.verified, true);
      assert.equal(breakpoint.source, undefined, 'The client keeps the name it set the breakpoint on');
    }
    assert.equal((await client.request('setBreakpoints', {
      source: { path: program, sourceReference: sourceReference + 10000 }, breakpoints: []
    })).success, false, 'An unknown reference must not clear breakpoints through a fallback path');
    await ok(client.request('continue', { threadId: entry.body.threadId }));
    const stopped = await client.event('stopped');
    assert.deepEqual(stopped.body.hitBreakpointIds, [breakpoint.id]);
    await ok(client.request('setBreakpoints', { source: { sourceReference }, breakpoints: [] }));
    await ok(client.request('continue', { threadId: stopped.body.threadId }));
    await client.event('terminated');
  });

  test(`returned frames use closing boundaries with ${base}-based Unicode coordinates`, async t => {
    const lines = ['#lang racket/base', '(define-values (a b)', '  (values "first"', '          "λ😀"))'];
    const { client } = await prepare(t, lines.join('\r\n') + '\r\n', { oneBased, stopOnEntry: true });
    await ok(client.request('configurationDone'));
    const before = await client.event('stopped');
    await ok(client.request('next', { threadId: before.body.threadId }));
    const after = await client.event('stopped');
    assert.equal(after.body.racketdapStopKind, 'after');
    const { stackFrames } = await ok(client.request('stackTrace', { threadId: after.body.threadId }));
    const top = stackFrames[0];
    assert.equal(top.line, 3 + base);
    assert.equal(top.endLine, top.line);
    assert.equal(top.column, lines[3].indexOf(')') + base);
    assert.equal(top.endColumn, top.column + 1);
    assert.match(top.name, /^Returned 2 values at /);
    await ok(client.request('continue', { threadId: after.body.threadId }));
    await client.event('terminated');
  });
}

test('a late breakpoint selects an unloaded external module for instrumentation', async t => {
  const { client, program, directory } = await prepare(t, '#lang racket/base\n(define marker 1)\n', { interactive: true });
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-late-external-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const support = path.join(external, 'support.rkt');
  await fs.writeFile(support, '#lang racket/base\n(provide twice)\n(define (twice value)\n  (* value 2))\n');
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  const before = await ok(client.request('loadedSources'));
  assert.ok(!before.sources.some(source => source.path === support));
  assert.ok(!support.startsWith(directory + path.sep));
  const breakpoint = (await ok(client.request('setBreakpoints', {
    source: { path: support }, breakpoints: [{ line: 4 }]
  }))).breakpoints[0];
  assert.equal(breakpoint.verified, false);
  const evaluation = ok(client.request('evaluate', {
    context: 'repl', expression: `((dynamic-require '(file ${JSON.stringify(support)}) 'twice) 21)`
  }));
  const stop = await client.event('stopped');
  assert.equal(stop.body.reason, 'breakpoint');
  assert.deepEqual(stop.body.hitBreakpointIds, [breakpoint.id]);
  const stack = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  assert.equal(stack.stackFrames[0].source.path, support);
  assert.equal((await ok(client.request('evaluate', { frameId: stack.stackFrames[0].id, expression: 'value' }))).result, '21');
  const captured = await ok(client.request('source', { source: stack.stackFrames[0].source }));
  assert.equal(captured.content, await fs.readFile(support, 'utf8'));
  await ok(client.request('continue', { threadId: stop.body.threadId }));
  assert.equal((await evaluation).result, '42');
  assert.ok((await ok(client.request('loadedSources'))).sources.some(source => source.path === program));
});

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`a ${name} source names its file until a saved edit leaves the running text behind`, async t => {
    const text = ['#lang racket/base', '(define result (+ 1 2))', '(displayln result)', ''].join(ending);
    const running = text.replaceAll('\r\n', '\n');
    const { client, program } = await prepare(t, text, { oneBased: true, stopOnEntry: true });
    await ok(client.request('configurationDone'));
    const { threadId } = (await client.event('stopped')).body;
    const reference = async () => (await ok(client.request('stackTrace', { threadId }))).stackFrames[0].source.sourceReference;
    const loaded = async () => (await ok(client.request('loadedSources'))).sources.find(source => source.path === program);
    const set = async line => (await ok(client.request('setBreakpoints', {
      source: { path: program }, breakpoints: [{ line }]
    }))).breakpoints[0];

    assert.equal(await reference(), 0);
    assert.equal((await loaded()).sourceReference, 0);
    const placed = await set(3);
    assert.equal(placed.verified, true);
    assert.equal(placed.source, undefined);
    assert.equal((await ok(client.request('source', { source: { path: program } }))).content, running);

    await fs.writeFile(program, `; saved during the stop${ending}${text}`);
    const captured = await reference();
    assert.ok(captured > 0);
    assert.equal((await loaded()).sourceReference, captured);
    for (const request of [{ sourceReference: captured }, { source: { sourceReference: captured } }]) {
      assert.equal((await ok(client.request('source', request))).content, running);
    }
    assert.equal((await client.request('source', { source: { path: `${program}.unknown` } })).success, false);
    assert.equal((await set(3)).verified, true, 'A breakpoint already placed stays');
    const refused = await set(2);
    assert.equal(refused.verified, false);
    assert.match(refused.message, /Restart/);
    assert.equal(refused.source, undefined);

    await fs.writeFile(program, text);
    assert.equal(await reference(), 0);
    assert.equal((await set(2)).verified, true, 'The same request is placed once the file matches again');
    await ok(client.request('terminate'));
  });
}

test('a saved edit that moves a breakpoint does not stop the program on another expression', async t => {
  const text = '#lang racket/base\n(define x (+ 0 1))\n(define y (+ 1 1))\n(define z (+ 1 2))\n(displayln (+ x y z))\n';
  const { client, program } = await prepare(t, text, { oneBased: true });
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  assert.equal(stopped.body.reason, 'breakpoint');
  await fs.writeFile(program, `; saved during the stop\n${text}`);
  const answer = await ok(client.request('setBreakpoints', {
    source: { path: program }, breakpoints: [{ line: 4 }], sourceModified: true
  }));
  assert.equal(answer.breakpoints[0].verified, false);
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('terminated');
  assert.equal(client.events.filter(event => event.event === 'stopped').length, 0, 'Only the first stop happened');
});

test('a line whose expansion lost its source location is verified on that line and stops there', async t => {
  const { client, program } = await prepare(t, [
    '#lang racket/base',
    '(require racket/file)',
    '(define dir (make-temporary-directory))',
    '(define (write-note)',
    '  (log-warning "writing ~a" dir)',
    "  (call-with-output-file (build-path dir \"note\") #:exists 'replace",
    "    (lambda (out) (write 'note out))))",
    '(define total (+ 1 2))',
    '(write-note)',
    '(delete-directory/files dir)',
    '(module+ main',
    '  (define inner (make-temporary-file))',
    '  (delete-file inner))',
    ''
  ].join('\n'));
  // Macros from other files whose expansions carry no location on these lines:
  // a definition, a logging form in a function body and a definition in a
  // submodule. The keyword application and the ordinary line already stopped.
  const lines = [3, 5, 6, 8, 12];
  const set = await ok(client.request('setBreakpoints', {
    source: { path: program }, breakpoints: lines.map(line => ({ line }))
  }));
  const ids = new Map(set.breakpoints.map((breakpoint, i) => [breakpoint.id, lines[i]]));
  await ok(client.request('configurationDone'));
  const stops = [];
  for (let i = 0; i < lines.length; i++) {
    const next = await client.event('stopped');
    const frame = (await ok(client.request('stackTrace', { threadId: next.body.threadId }))).stackFrames[0];
    stops.push([ids.get(next.body.hitBreakpointIds[0]), frame.line, frame.column]);
    await ok(client.request('continue', { threadId: next.body.threadId }));
  }
  await client.event('terminated');
  assert.deepEqual(stops, [[3, 3, 14], [8, 8, 15], [5, 5, 4], [6, 6, 3], [12, 12, 18]]);
  const latest = new Map();
  for (const message of client.events) {
    if (message.event === 'breakpoint') latest.set(message.body.breakpoint.id, message.body.breakpoint);
  }
  for (const [id, line] of ids) {
    assert.equal(latest.get(id).verified, true, `line ${line}: ${latest.get(id).message}`);
    assert.equal(latest.get(id).line, line);
  }
});
