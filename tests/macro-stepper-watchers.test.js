// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, tick } = require('./support/macro-common');
const { fakeStepper, opened, fakeTimers } = require('./support/macro-stepper');
const { until } = require('./support/wait');
const { hash } = load({ vscode: {} }, 'vscode/macro-steps/target.js');

test('source watcher skips unrelated writes and coalesces dependency checks without synchronous reads', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-watch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dependency = path.join(directory, 'dependency.rkt'), output = path.join(directory, 'program.log');
  fs.writeFileSync(dependency, '(old)');
  const uri = { scheme: 'untitled', toString: () => 'untitled:main' };
  const fileUri = file => ({ scheme: 'file', fsPath: file, toString: () => `file:${file}` });
  const view = { source: uri, snapshotText: 'main', generation: 1,
    data: { sources: { dep: { kind: 'file', value: dependency, fingerprint: hash('(old)') } } } };
  const events = {}, statuses = [], subscriptions = [], timers = fakeTimers();
  let synchronous = 0, asynchronous = 0;
  load({
    __setTimeout: timers.setTimeout, __clearTimeout: timers.clearTimeout,
    vscode: { ThemeColor: class {}, window: { createTextEditorDecorationType: () => ({ dispose() {} }) },
      workspace: { textDocuments: [{ uri, getText: () => 'main' }], createFileSystemWatcher: () => ({ dispose() {},
        onDidChange(fn) { events.change = fn; return { dispose() {} }; },
        onDidDelete(fn) { events.delete = fn; return { dispose() {} }; } }) } },
    'node:fs': { ...fs, readFileSync(...args) { synchronous++; return fs.readFileSync(...args); },
      promises: { ...fs.promises, async readFile(...args) { asynchronous++; return fs.promises.readFile(...args); } } }
  }, 'vscode/macro-steps/source.js').createSource({ context: { subscriptions }, views: new Map([['main', view]]),
    broadcast: (_view, type, status) => statuses.push({ type, ...status }), panes: () => [], activePane() {} });
  t.after(() => subscriptions.forEach(d => d.dispose()));
  fs.writeFileSync(output, 'unrelated'); events.change(fileUri(output)); await tick();
  assert.equal(synchronous, 0); assert.equal(asynchronous, 0); assert.equal(statuses.length, 0);
  fs.writeFileSync(dependency, '(new)');
  for (let i = 0; i < 3; i++) { events.change(fileUri(dependency)); await tick(); }
  assert.equal(synchronous, 0, 'No file is read synchronously in a watcher callback');
  assert.equal(asynchronous, 0, 'A burst waits for one coalesced check');
  await timers.advance(49); assert.equal(asynchronous, 0);
  await timers.advance(1);
  await until(() => statuses.length === 1);
  assert.equal(asynchronous, 1); assert.equal(statuses[0].stale, true);
  fs.writeFileSync(dependency, '(old)'); events.change(fileUri(dependency));
  await timers.advance(50);
  await until(() => statuses.length === 2);
  assert.equal(statuses[1].stale, false);
  assert.equal(synchronous, 0);
});

test('text changes and closes revisit only affected macro views', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  const main = await opened(ui, 'main'); await opened(ui, 'other');
  const unrelated = await ui.source('unrelated'); await tick();
  const counts = () => ui.panels.map(p => p.messages.filter(m => m.type === 'sourceStatus').length);
  const before = counts();
  ui.edit(unrelated, unrelated.text + '; unrelated'); ui.close(unrelated); await tick();
  assert.deepEqual(counts(), before);
  ui.edit(main, main.text + '; changed'); await tick();
  for (const [i, panel] of ui.panels.entries()) {
    assert.equal(counts()[i] - before[i], panel.title.endsWith('main') ? 1 : 0);
  }
});
