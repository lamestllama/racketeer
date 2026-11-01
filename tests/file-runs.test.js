// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const target = { program: '/workspace/main.rkt', cwd: '/workspace', racketExecutable: 'racket' };
function harness() {
  const saved = [], launched = [], revealed = [], control = {};
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vscode/file-runs.js'), 'utf8'), {
    module, require: () => ({ saveTarget: async t => { saved.push(t); if (control.saveError) throw control.saveError; } })
  });
  const sessions = { async start(t, config, options) {
    if (control.launchError) throw control.launchError;
    if (control.launchGate) await control.launchGate.promise;
    const done = deferred();
    const record = { target: t, config, options, done: done.promise, stopped: false, finish: done.resolve,
      async stop() { record.stopped = true; if (control.stopGate) await control.stopGate.promise; record.finish({ exitCode: 0 }); } };
    launched.push(record); return record;
  } };
  const output = { reveal(record, evaluate, restart) { revealed.push({ record, evaluate, restart }); } };
  return { runs: module.exports.registerFileRuns(sessions, output), saved, launched, revealed, control };
}

test('Run finishes its program normally, and Run again replaces only its owned execution', async () => {
  const h = harness(); const first = await h.runs.run(target);
  assert.equal(first.options.noDebug, true); assert.equal(first.config.interactive, false);
  assert.equal(first.config.stopOnEntry, false); assert.equal(Object.hasOwn(first.config, 'submodule'), false);
  assert.equal(h.revealed[0].evaluate, undefined);
  const other = await h.runs.run({ ...target, program: '/workspace/other.rkt' });
  const replacement = await h.revealed[0].restart();
  assert.equal(first.stopped, true); assert.equal(other.stopped, false);
  assert.equal(replacement.options.noDebug, true); assert.equal(h.saved.length, 3);
});

test('Debug and Debug again retain source debugging and replace the previous Run', async () => {
  const h = harness(); const running = await h.runs.run(target);
  const debugging = await h.runs.run(target, true);
  assert.equal(running.stopped, true); assert.equal(debugging.options.noDebug, false);
  assert.equal(debugging.config.stopOnEntry, true); assert.equal(debugging.config.interactive, false);
  const restarted = await h.revealed.at(-1).restart();
  assert.equal(debugging.stopped, true); assert.equal(restarted.options.noDebug, false);
});

test('rapid reruns wait for the pending launch and for its complete shutdown', async () => {
  const h = harness(), gate = deferred(); h.control.launchGate = gate;
  const first = h.runs.run(target), second = h.runs.run(target);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.launched.length, 0);
  h.control.stopGate = deferred(); gate.resolve(); const previous = await first;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(previous.stopped, true); assert.equal(h.launched.length, 1);
  h.control.stopGate.resolve(); await second; assert.equal(h.launched.length, 2);
});

test('a failed save leaves the running program alone and a later Run recovers', async () => {
  const h = harness(); const previous = await h.runs.run(target);
  h.control.saveError = Error('Save failed'); await assert.rejects(h.runs.run(target), /Save failed/);
  assert.equal(previous.stopped, false); assert.equal(h.launched.length, 1);
  h.control.saveError = undefined; await h.runs.run(target); assert.equal(previous.stopped, true);
});

test('a failed launch does not block a subsequent run', async () => {
  const h = harness(); h.control.launchError = Error('Cannot launch'); await assert.rejects(h.runs.run(target), /Cannot launch/);
  h.control.launchError = undefined; assert.ok(await h.runs.run(target)); assert.equal(h.launched.length, 1);
});
