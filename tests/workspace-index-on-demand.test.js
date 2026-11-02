// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [path.join(__dirname, '../vscode')] }));
const { addon, uri, project } = require('./workspace-index-project');

const traced = { RACKETEER_INDEX_TRACE: '1' };
const passes = p => (p.diagnostics().match(/discover: starting/g) || []).length;
// Longer than the pause a pass could have waited for.
const quietly = () => delay(3000);
const from = (locations, source) => locations.filter(location => location.uri === source);

test('nothing is analysed at startup or after any change until a request asks', { timeout: 120000 }, async t => {
  const p = await project(t, traced);
  await quietly();
  assert.equal(passes(p), 0, 'No pass at startup');
  assert.equal(p.notifications.length, 0, 'Nothing to report');
  const buffer = p.open('uses.rkt', fs.readFileSync(p.filename('uses.rkt'), 'utf8'));
  await p.update(true);
  p.documents.get(buffer).text += '(square 4)\n'; p.documents.get(buffer).version++;
  await p.update(true);
  p.write('more.rkt', '#lang racket/base\n');
  await p.diskChange('more.rkt');
  p.settings.timeoutSeconds = 30;
  await p.update(true);
  await p.request('workspace/executeCommand', { command: 'racketeer.refreshWorkspaceIndex' });
  await quietly();
  assert.equal(passes(p), 0, 'No pass after edits, file events, settings or a refresh');
  assert.equal(p.notifications.length, 0);
  assert.doesNotMatch(p.diagnostics(), /analyse \S+: starting/);
  const locations = await p.references(p.origin);
  assert.equal(from(locations, buffer).length, 2);
  assert.equal(passes(p), 1);
  await p.references(p.origin);
  assert.equal(passes(p), 1, 'A second request with nothing changed needs no pass');
});

test('the first request after a change waits for a pass and sees its progress first', { timeout: 120000 }, async t => {
  const p = await project(t);
  await p.references(p.origin);
  const first = p.notifications.length, firstProgress = p.progress.length;
  p.write('uses.rkt', fs.readFileSync(p.filename('uses.rkt'), 'utf8') + '(square 4)\n');
  await p.update();
  await quietly();
  assert.equal(p.notifications.length, first, 'The change alone reports nothing');
  assert.equal(p.progress.length, firstProgress);
  const locations = await p.references(p.origin);
  assert.equal(from(locations, uri(p.filename('uses.rkt'))).length, 2);
  assert.deepEqual(p.notifications.slice(first), [{ state: 'ready', indexed: 2, total: 2, failures: 0 }],
    'The private status carries the final state only');
  const seen = p.progress.slice(firstProgress);
  assert.deepEqual(seen[0], { kind: 'begin', title: 'Analysing workspace', percentage: 0 });
  assert.deepEqual(seen.at(-1), { kind: 'end' });
  assert.deepEqual(seen.slice(1, -1).filter(value => value.message).at(-1), { kind: 'report', percentage: 100, message: '2/2' },
    'The count of files is known once they are found');
  for (const value of seen.slice(1, -1)) if (value.message) assert.match(value.message, /^\d+\/2$/);
});

// A project whose pass stops at `blocked.rkt` for as long as a file exists,
// after analysing `a.rkt`, which logs each expansion.
async function blockingProject(t, env) {
  const p = await project(t, env);
  const log = path.join(addon, `${path.basename(p.directory)}-a.log`);
  const gate = path.join(addon, `${path.basename(p.directory)}-gate`), entered = `${gate}-entered`;
  p.write('a.rkt', `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(log)} #:exists 'append
    (lambda (out) (display "expanded\\n" out))))
`);
  const blocking = `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (when (file-exists? ${JSON.stringify(gate)})
    (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate
      (lambda (out) (display "entered" out)))
    (sync never-evt)))
`;
  fs.writeFileSync(gate, 'block');
  p.write('blocked.rkt', blocking);
  await p.update();
  const reached = async () => {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(entered)) {
      assert.ok(Date.now() < deadline, p.diagnostics());
      await delay(25);
    }
  };
  // Workers run at once, so reaching one file does not mean that the one before it ended.
  const finished = async name => {
    const deadline = Date.now() + 60000;
    while (!new RegExp(`analyse \\S*${name.replace('.', '\\.')}: reaped`).test(p.diagnostics())) {
      assert.ok(Date.now() < deadline, p.diagnostics());
      await delay(25);
    }
  };
  return { ...p, reached, finished, expansions: () => fs.readFileSync(log, 'utf8').trim().split('\n').length,
    release: () => fs.unlinkSync(gate), entered };
}

test('cancelling the only request stops its pass, and the next request keeps what it finished', { timeout: 120000 }, async t => {
  const p = await blockingProject(t, traced);
  const cancel = new rpc.CancellationTokenSource();
  const request = p.references(p.origin, undefined, false, cancel.token);
  await p.reached();
  await p.finished('a.rkt');
  const expansions = p.expansions();
  assert.equal(expansions, 1, 'a.rkt comes first');
  cancel.cancel();
  await assert.rejects(request, error => error.code === -32800);
  cancel.dispose();
  // The worker is reaped and no other starts: nobody is asking.
  await quietly();
  assert.equal(p.notifications.at(-1).state, 'outdated', 'A client must stop showing a pass as running');
  const log = p.diagnostics();
  await quietly();
  assert.equal(p.diagnostics().match(/analyse \S+: starting/g).length, log.match(/analyse \S+: starting/g).length,
    'Nobody is asking, so no more files are analysed');
  p.release();
  const locations = await p.references(p.origin);
  assert.equal(from(locations, uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.equal(p.expansions(), expansions, 'A finished file is not analysed again');
});

test('a pass keeps going while one of its requests is cancelled and another waits', { timeout: 120000 }, async t => {
  const p = await blockingProject(t, traced);
  const cancel = new rpc.CancellationTokenSource();
  const cancelled = p.references(p.origin, undefined, false, cancel.token);
  const waiting = p.references(p.origin);
  await p.reached();
  const passesBefore = passes(p);
  cancel.cancel();
  await assert.rejects(cancelled, error => error.code === -32800);
  cancel.dispose();
  p.release();
  // Blocked without a limit, the file takes its 20 seconds and the pass ends.
  assert.equal(from(await waiting, uri(p.filename('uses.rkt'))).length, 1);
  assert.equal(p.notifications.at(-1).state, 'partial', p.diagnostics());
  assert.equal(passes(p), passesBefore, 'The second request did not need a new pass');
});

test('a partial index refuses rename with the same message after a request asked for it', { timeout: 120000 }, async t => {
  const p = await project(t);
  p.write('broken.rkt', '#lang racket/base\n(\n');
  await p.update();
  const refused = /Workspace analysis is incomplete\. Resolve its errors before renaming\./;
  await assert.rejects(p.rename(p.origin), refused);
  await assert.rejects(p.rename(p.origin, 'squared'), refused);
  assert.equal(p.notifications.at(-1).state, 'partial');
});

test('prepareRename and rename each start a pass when none has run', { timeout: 120000 }, async t => {
  const first = await project(t, traced);
  assert.equal((await first.rename(first.origin)).start.character, 9);
  assert.equal(passes(first), 1);
  const second = await project(t, traced);
  const edit = await second.rename(second.origin, 'squared');
  assert.equal(Object.keys(edit.changes).length, 2);
  assert.equal(passes(second), 1);
});

// Rewrites a source and reports it, as a generator or a build does.
function rewriting(p, name, milliseconds) {
  let generation = 0;
  const timer = setInterval(() => {
    p.write(name, `#lang racket/base\n; ${++generation}\n`);
    void p.diskChange(name);
  }, milliseconds);
  return { stop: () => clearInterval(timer), count: () => generation };
}

test('a request refuses in words once sources have kept changing past the time limit', { timeout: 120000 }, async t => {
  const p = await project(t);
  p.settings.timeoutSeconds = 4;
  p.write('generated.rkt', '#lang racket/base\n');
  await p.update();
  await p.references(p.origin);
  const settled = request => request.then(value => ({ value }), error => ({ error }));
  const writer = rewriting(p, 'generated.rkt', 100);
  t.after(writer.stop);
  const started = Date.now();
  const answers = Promise.all([settled(p.references(p.origin)), settled(p.rename(p.origin, 'squared'))]);
  const outcome = await Promise.race([answers, delay(30000, 'still waiting', { ref: false })]);
  writer.stop();
  assert.notEqual(outcome, 'still waiting', `Pending after ${writer.count()} rewrites`);
  assert.ok(Date.now() - started >= 4000, 'It waits out the time limit first');
  for (const { error } of outcome) {
    assert.equal(error?.code, -32803, 'Neither answers from sources that have moved on');
    assert.match(error.message, /Workspace sources kept changing for 4 seconds/);
  }
  // Nothing is left behind once the sources settle.
  assert.ok(from(await p.references(p.origin), uri(p.filename('uses.rkt'))).length === 1);
  assert.ok((await p.rename(p.origin, 'squared')).changes[uri(p.filename('uses.rkt'))]);
});

test('a burst of changes that ends is waited out, however many it held', { timeout: 120000 }, async t => {
  const p = await project(t);
  p.write('generated.rkt', '#lang racket/base\n');
  await p.update();
  await p.references(p.origin);
  const writer = rewriting(p, 'generated.rkt', 25);
  t.after(writer.stop);
  const request = p.references(p.origin).then(value => ({ value }), error => ({ error }));
  await delay(2000);
  writer.stop();
  assert.ok(writer.count() > 16, `Only ${writer.count()} rewrites`);
  const { value, error } = await request;
  assert.equal(error, undefined);
  assert.equal(from(value, uri(p.filename('uses.rkt'))).length, 1);
});
