// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { tick, plain, root, racket, helper } = require('./support/macro-common');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const { request } = require('./support/macro-worker');
const os = require('node:os');
const path = require('node:path');
const { workerOverride } = require('./support/macro-racket-proof');
const { pair } = require('./support/macro-fixtures');

async function check(sources) {
  const ui = fakeStepper({ sources });
  try {
    await opened(ui, 'A');
    const before = ui.panels[0], after = ui.panels[1];
    before.send('select', pair()); await tick();
    before.send('pin', { action: 'tack', ...pair() }); await tick();
    const selection = plain(before.selection.selected);
    const pins = plain((await ui.command('_observe')).pins);
    await opened(ui, 'B');
    const other = ui.panels[2].projection;
    before.reveal();
    const resetting = ui.command('resetMarkNumbering'); await tick();
    ui.answer(ui.pending[0]); await resetting;
    assert.deepEqual(plain(before.selection.selected), selection);
    assert.deepEqual(plain((await ui.command('_observe')).pins), pins);
    assert.equal(before.projection.preserveSelection, true);
    assert.equal(after.projection.preserveSelection, true);
    assert.equal(before.projection.position, 1);
    assert.equal(ui.panels[2].projection, other);
    assert.equal(ui.pending[0].queries.filter(q => q.mode === 'configure').length, 1);
    assert.equal(ui.pending[1].queries.some(q => q.mode === 'configure'), false);
  } finally { ui.dispose(); }
}
test('reset redraws both panes preserving selection and arrows in this pair alone', () => check());
test('reset regression proof rejects clearing selection and omitting redraw preservation', async () => {
  const file = 'vscode/macro-steps/navigation.js';
  const source = fs.readFileSync(`${root}/${file}`, 'utf8');
  for (const broken of [
    source.replace('for (const pane of runtime.panes(v)) pane.positionRevision++;\n    } finally',
      'for (const pane of runtime.panes(v)) { pane.selection = null; pane.pins = []; pane.positionRevision++; }\n    } finally'),
    source.replace('v.busy = false; await show(v, true)', 'v.busy = false; await show(v)')
  ]) {
    assert.notEqual(broken, source);
    await assert.rejects(check({ [file]: broken }), assert.AssertionError);
  }
});

async function checkCompletion(t, worker = helper) {
  const snapshot = { sourceHash: 'a'.repeat(64), sourceVersion: 1 };
  const session = createMacroSession(racket, worker, { ...request('#lang racket/base\n(define-syntax-rule (m x) (list x))\n(m 1)\n', 'module'),
    schemaVersion: 2, session: true, snapshot, nextGroup: 23 });
  t.after(() => session.stop());
  const summary = await session.start();
  const ask = query => session.request({ snapshot, panes: true, suffixOption: 'always', ...query });
  await ask({ mode: 'position', position: summary.stepCount });
  const previous = await ask({ mode: 'position', position: summary.stepCount + 1 });
  assert.ok(previous.terminalBefore);
  await ask({ mode: 'configure', grouping: 'macro' });
  const redrawn = await ask({ mode: 'position', position: summary.stepCount + 1, retainTerminalBefore: true });
  assert.equal(redrawn.terminalBefore.id, previous.terminalBefore.id);
  assert.deepEqual(redrawn.terminalBefore.occurrences.map(o => [o.id, o.syntaxId]), previous.terminalBefore.occurrences.map(o => [o.id, o.syntaxId]));
  assert.ok(redrawn.nextGroup < previous.nextGroup);
}
test('reset at completion retains the displayed input and its deterministic selection identities', checkCompletion);
test('completion reset proof rejects losing the retained input', async t => {
  const file = 'racketdap/tools/macro-steps/answer.rkt', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace("(eq? (hash-ref query 'retainTerminalBefore #f) #t)", '#f');
  assert.notEqual(broken, source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-reset-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const driver = path.join(directory, 'worker.rkt');
  fs.writeFileSync(driver, workerOverride(file, broken));
  await assert.rejects(checkCompletion(t, driver), /terminalBefore|Cannot read/);
});
