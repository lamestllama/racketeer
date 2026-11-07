// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper worker behavior.
'use strict';
const { load, helper, racket, noVscode } = require('./support/macro-common');
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const Model = require('../vscode/macro-view/model');
const fs = require('node:fs');
const { createMacroProcess } = require('../vscode/macro-process');
const Data = require('../vscode/macro-view-data');
const { decodeTerm } = require('../vscode/macro-stepper-codec');
const { owned, request } = require('./support/macro-worker');

test('buffer capture selects the line or exact selection, preserving Unicode prefix and module directory', () => {
  const buffer = '; 😀\r\n\t(or #f 42)\n';
  const start = buffer.indexOf('(or');
  const uri = { scheme: 'file', fsPath: '/workspace/sub/dirty λ.rkt' };
  const folder = { uri: { fsPath: '/workspace' } };
  const vscode = { workspace: { getWorkspaceFolder: () => folder,
    getConfiguration: () => ({ get: () => '/tools/Racket binary' }) } };
  const { macroTarget } = load({ vscode });
  const editor = { document: { uri, languageId: 'racket', getText: () => buffer,
    offsetAt: position => position.offset,
    lineAt: () => ({ range: { start: { offset: start - 1 }, end: { offset: buffer.length - 1 } } }) },
    selection: { isEmpty: true, active: { line: 1 } } };
  const line = macroTarget(editor, false);
  assert.equal(line.fragment.text, '\t(or #f 42)');
  assert.equal(line.fragment.prefix, '; 😀\r\n');
  assert.equal(line.fragment.directory, '/workspace/sub');
  assert.equal(line.fragment.cwd, '/workspace');
  assert.equal(line.module.text, buffer, 'A line of a module expands within its module');
  assert.equal(line.module.prefix, '');
  assert.equal(line.executable, '/tools/Racket binary');
  editor.selection = { isEmpty: false, start: { offset: start }, end: { offset: buffer.length - 1 } };
  assert.equal(macroTarget(editor, false).fragment.text, '(or #f 42)');
  assert.equal(macroTarget(editor, true).module.text, buffer);
  editor.document.uri = { scheme: 'untitled', toString: () => 'untitled:Untitled-1' };
  assert.equal(macroTarget(editor, true).module.source, 'untitled:Untitled-1');
  editor.document.getText = () => '   ';
  assert.throws(() => macroTarget(editor, true), /no Racket forms/);
});

test('missing configured executable reports once and cancellation before open starts nothing', async () => {
  const missing = owned(path.join(os.tmpdir(), 'racketeer-no-such-executable'), helper, request('42'));
  missing.process.start(); await missing.process.done;
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /racketExecutable/);
  const cancelled = owned('must-not-run', helper, request('42'));
  await cancelled.process.stop(); cancelled.process.start();
  await cancelled.process.done;
  assert.equal(cancelled.code, 0);
  assert.deepEqual(cancelled.errors, []);
});

test('the real worker answers with steps, and what compile-time code prints stays out of the answer', async () => {
  const text = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    '(begin-for-syntax (displayln "printed while expanding") (eprintf "and to errors\\n"))\n' +
    '(define-syntax-rule (twice e) (list e e))\n(twice 1)\n';
  const run = owned(racket, helper, { ...request(text, 'module'), hiding: 'standard' });
  run.process.start();
  await run.process.done;
  assert.deepEqual(run.errors, []);
  const answer = JSON.parse(run.output);
  assert.deepEqual(answer.steps.map(step => step.macro), ['twice']);
  assert.equal(answer.steps[0].source.line, 5);
  assert.match(answer.final, /module/);
});

test('a read error and a file that is no module come back as answers, not as crashes', async () => {
  for (const [text, words] of [['(', /read|expected/], ['(+ 1 2)', /single #lang or module/]]) {
    const run = owned(racket, helper, request(text, 'module'));
    run.process.start();
    await run.process.done;
    assert.deepEqual(run.errors, []);
    assert.match(JSON.parse(run.output).failed, words);
  }
});

test('source offsets account for tab columns, code points and CRLF spans', () => {
  const { sourceOffsets } = load({ vscode: noVscode });
  const text = '; 😀\r\n\t😀 (m\r\n  😀)\r\n';
  const offsets = sourceOffsets(text, 2, 10, 7);
  assert.deepEqual(Array.from(offsets), [text.indexOf('(m'), text.indexOf(')') + 1]);
  assert.equal(text.slice(...offsets), '(m\r\n  😀)');
  assert.equal(text.slice(...sourceOffsets(text, 2, 8, 1)), '😀');
});

test('source labels use status-bar coordinates, text spans and no raw offsets', () => {
  const source = { kind: 'file', value: '/project/sample.rkt' };
  const location = { line: 18, column: 3, span: 37, position: 999 };
  const text = '\n'.repeat(17) + ' '.repeat(3) + 'x'.repeat(37);
  assert.equal(Model.sourceLabel(location, source, text), '/project/sample.rkt, Ln 18, Col 4 to Ln 18, Col 41');
  assert.equal(Model.sourceLabel(location, source), '/project/sample.rkt, Ln 18, Col 4');
  assert.equal(Model.sourceLabel({ ...location, span: null }, source, text), '/project/sample.rkt, Ln 18, Col 4');
  assert.equal(Model.sourceLabel({ line: 1, column: 0, span: 0 }, source, ''), '/project/sample.rkt, Ln 1, Col 1 to Ln 1, Col 1');
  assert.equal(Model.sourceLabel({ line: 2, column: 8, span: 4 }, source, 'first\r\n\t😀x\r\ny'),
    '/project/sample.rkt, Ln 2, Col 2 to Ln 3, Col 2');
  assert.equal(Model.sourceLabel({ line: 1, column: 1, span: 1 }, source, '😀x'),
    '/project/sample.rkt, Ln 1, Col 3 to Ln 1, Col 4');
  assert.equal(Model.sourceLabel({ line: 2, column: 0, span: 2 }, source, 'a\rb\rc'),
    '/project/sample.rkt, Ln 2, Col 1 to Ln 3, Col 1');
  assert.equal(Model.sourceLabel(null, source), 'Unavailable');
});

test('a worker whose expansion kills its thread reports termination', async () => {
  const text = '#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (kill-thread (current-thread)))\n';
  const run = owned(racket, helper, request(text, 'module'));
  run.process.start(); await run.process.done;
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.output).failed, 'The expansion stopped before it finished.');
});

test('schema 2 worker rejects incompatible versions and malformed inspection inputs before expansion', async () => {
  const snapshot = { sourceHash: '0'.repeat(64), sourceVersion: 1 };
  for (const extra of [{ schemaVersion: 99 }, { schemaVersion: 2 },
    { schemaVersion: 2, snapshot },
    { schemaVersion: 2, session: true, snapshot, inspectionPhases: ['expression'] }]) {
    const run = owned(racket, helper, { ...request('(error "must not expand")'), ...extra });
    run.process.start(); await run.process.done;
    assert.deepEqual(run.errors, []);
    const answer = JSON.parse(run.output);
    assert.equal(answer.failureCode, 'incompatible');
    assert.equal(typeof answer.failed, 'string');
    assert.equal(answer.steps, undefined);
  }
});

test('lazy schema 2 session answers summary, positions and standalone inspection without expanding again', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-inspection-'));
  const marker = path.join(directory, 'expansions');
  const text = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    `(begin-for-syntax (call-with-output-file ${JSON.stringify(marker)} #:exists 'append (lambda (out) (display "x" out))))\n` +
    '(define-syntax-rule (keep x) x)\n(define value (keep 1))\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 3 };
  let buffered = '';
  const replies = [], waiting = [];
  const next = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve));
  const failures = [];
  const process = createMacroProcess(racket, helper, { ...request(text, 'module'), schemaVersion: 2, session: true, snapshot }, {
    output(chunk) {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
        if (waiting.length) waiting.shift()(reply); else replies.push(reply);
      }
    }, failure: error => failures.push(error), finished() {}
  });
  t.after(async () => { await process.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(process.send({ mode: 'inspect' }), false);
  process.start();
  const initial = await next();
  const expansions = fs.readFileSync(marker, 'utf8');
  assert.ok(expansions.length > 0);
  assert.equal(initial.failed, undefined);
  Data.validateAnswer(initial, snapshot);
  assert.equal(initial.mode, 'summary'); assert.equal(initial.stepCount, initial.steps.length);
  assert.equal(initial.terms, undefined); assert.equal(initial.shared, undefined);
  assert.equal(initial.final, true);
  const position = initial.stepCount + 1;
  process.send({ mode: 'position', snapshot, position });
  const program = await next(); Data.validatePosition(program, initial, position);
  const term = Object.keys(program.terms).find(tid => program.terms[tid].name === 'value');
  assert.equal(program.terms[term].scopes, undefined);
  const query = { mode: 'inspect', snapshot, position, term, phases: [1, -1, 'label', 8] };
  for (const invalid of [{ ...query, snapshot: { ...snapshot, sourceVersion: 4 } },
    { ...query, term: 'unknown' }, { ...query, phases: ['invalid'] }, { ...query, phases: Array(257).fill(0) },
    { mode: 'position', snapshot, position: position + 1 }]) {
    assert.equal(process.send(invalid), true);
    assert.equal((await next()).failureCode, 'incompatible');
  }
  assert.equal(process.send(query), true);
  const more = await next();
  assert.equal(more.mode, 'inspect');
  assert.deepEqual(more.snapshot, snapshot); assert.equal(more.term, term);
  Data.validateShared(more.shared);
  const facts = decodeTerm(more.shared, more.termData);
  assert.deepEqual(facts.inspectedPhases, query.phases);
  assert.deepEqual(facts.scopes.map(s => s.phase), query.phases);
  assert.deepEqual(facts.bindings.map(b => b.phase), query.phases);
  process.send(query); const repeated = await next();
  assert.deepEqual(decodeTerm(repeated.shared, repeated.termData), facts);
  // Loading a different position evicts worker syntax, then an inspection of
  // the cached position reconstructs exactly the same position-local identity.
  if (position > 1) {
    process.send({ mode: 'position', snapshot, position: 1 }); await next();
    process.send(query); const restored = await next();
    assert.deepEqual(decodeTerm(restored.shared, restored.termData), facts);
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), expansions);
  process.send({ mode: 'reexpand', snapshot, hiding: 'none' });
  const unhidden = await next(); Data.validateAnswer(unhidden, snapshot);
  assert.ok(unhidden.stepCount > initial.stepCount);
  assert.equal(fs.readFileSync(marker, 'utf8'), expansions, 'Hiding reuses the captured expansion and its scope identities');
  await process.stop();
  assert.equal(process.send(query), false);
});
