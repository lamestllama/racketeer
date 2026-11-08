// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Exercises saved expansion points through menu and Settings changes.
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const { tick, racket, helper, plain } = require('./support/macro-common');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { summaryOf } = require('./support/macro-fixtures');
const { request } = require('./support/macro-worker');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');

async function stepper(t, leading = false, sharedPoint = false, duringExpansion = false) {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('renaming');
  const opening = ui.open(true); await tick();
  const worker = ui.pending[0];
  const labels = leading ? ['Introduce scope for module', 'Introduce scope for module body', 'Transform block to letrec', 'Finish block'] :
    ['Macro transformation', 'Introduce scope for local bindings', 'Add explicit #%datum', 'Macro transformation',
      'Introduce scope for internal definition context', 'Resolve variable (remove extra scopes)'];
  const hidden = leading ? [0, 1] : [1, 4, 5];
  let full;
  if (duringExpansion) {
    ui.setSetting('racketdap.macroSteps.includeRenamingSteps', true); await tick();
  }
  ui.answer(worker, a => {
    const template = a.steps[0];
    full = labels.map((label, i) => ({ ...template, label, id: `step${i}`, expansionPoint: sharedPoint && i === 5 ? 5 : i + 1 }));
    a.steps = full.filter((_, i) => !hidden.includes(i));
  });
  const send = worker.send;
  worker.send = query => {
    if (query.mode !== 'reexpand') return send(query);
    (worker.queries ||= []).push(query);
    worker.data = { ...worker.data, steps: full.filter((_, i) => query.includeRenamingSteps || !hidden.includes(i)) };
    queueMicrotask(() => ui.finish(worker, summaryOf(worker.data)));
    return true;
  };
  await opening; await tick();
  const pane = ui.panels[0];
  const toggle = async () => { await ui.command('includeRenamingSteps'); await tick(); };
  return { ui, pane, worker, toggle };
}

test('renaming toggle keeps a rewrite by expansion point and restores removed scope steps', async t => {
  const { ui, pane, worker, toggle } = await stepper(t);
  await ui.command('jump', 2);
  await toggle();
  assert.equal(pane.projection.position, 3);
  assert.equal(pane.projection.record.label, 'Add explicit #%datum');
  await ui.command('jump', 2);
  await toggle();
  assert.equal(pane.projection.position, 2);
  assert.equal(pane.projection.record.label, 'Add explicit #%datum');
  await toggle();
  assert.equal(pane.projection.position, 2);
  assert.equal(pane.projection.record.label, 'Introduce scope for local bindings');
  assert.equal(ui.pending.length, 1, 'Toggles use the retained worker');
  assert.ok(worker.queries.some(q => q.mode === 'reexpand' && q.includeRenamingSteps === true));
  assert.equal(ui.contexts['racketdap.macroSteps.includeRenamingSteps'], true);
});

test('both trailing renamings return after temporary completion; explicit end saves completion', async t => {
  const { ui, pane, toggle } = await stepper(t);
  await toggle();
  for (const n of [5, 6]) {
    await ui.command('jump', n);
    await toggle(); assert.equal(pane.projection.position, 4); assert.equal(pane.projection.record, null);
    await toggle(); assert.equal(pane.projection.position, n);
  }
  await toggle();
  await ui.command('last'); // Already at the end: this still saves the explicit navigation.
  await toggle(); assert.equal(pane.projection.position, 7); assert.equal(pane.projection.record, null);
  await toggle(); assert.equal(pane.projection.position, 4);
});

test('navigation after removal replaces the saved point, including backward navigation', async t => {
  const { ui, pane, toggle } = await stepper(t);
  await toggle(); await ui.command('jump', 5); await toggle();
  await ui.command('previous');
  await toggle();
  assert.equal(pane.projection.position, 4);
  assert.equal(pane.projection.record.label, 'Macro transformation');
});

test('a fresh sequence starts at newly included leading scopes; Settings changes act like the menu', async t => {
  const { ui, pane, toggle } = await stepper(t, true);
  assert.equal(pane.projection.record.label, 'Transform block to letrec');
  await toggle();
  assert.equal(pane.projection.position, 1);
  assert.equal(pane.projection.record.label, 'Introduce scope for module');
  ui.setSetting('racketdap.macroSteps.includeRenamingSteps', false);
  for (let i = 0; i < 20 && pane.projection.count !== 3; i++) await tick();
  assert.equal(pane.projection.position, 1); assert.equal(pane.projection.count, 3);
  assert.equal(pane.projection.record.label, 'Transform block to letrec');
});

test('restoration chooses the earliest transition sharing the saved expansion point', async t => {
  const { ui, pane, toggle } = await stepper(t, false, true);
  await toggle(); await ui.command('jump', 6);
  await toggle(); await toggle();
  assert.equal(pane.projection.position, 5);
});

test('the options group holds the six checkboxes and Taint Icons, with context toggles and palette entries', () => {
  const c = require('../vscode/package.json').contributes, prefix = 'racketdap.macroSteps.';
  const labels = { includeRenamingSteps: 'Include Renaming Steps', alwaysSuffixMarkedIdentifiers: 'Always Suffix Marked Identifiers',
    highlightRedexContractum: 'Highlight Redex/Contractum', drawBindingArrows: 'Draw Binding Arrows',
    oneTermAtATime: 'One Term at a Time', factorCommonContext: 'Factor Out Common Context' };
  const groups = new Set();
  for (const [name, title] of Object.entries(labels)) {
    const command = c.commands.find(entry => entry.command === prefix + name);
    assert.equal(command.title, title); assert.equal(command.toggled, prefix + name);
    const entry = c.menus['editor/title'].find(entry => entry.command === prefix + name);
    assert.match(entry.when, /activeWebviewPanelId == 'racketeer.macroSteps'/);
    groups.add(entry.group.split('@')[0]);
    assert.ok(c.menus.commandPalette.some(entry => entry.command === command.command && entry.when !== 'false'));
  }
  assert.equal(groups.size, 1);
  assert.equal(c.menus['editor/title'].filter(entry => groups.has(entry.group?.split('@')[0])).length, 7);
  assert.equal(c.configuration.properties[prefix + 'includeRenamingSteps'].default, false);
  assert.equal(c.configuration.properties[prefix + 'highlightRedexContractum'].default, true);
  assert.equal(c.configuration.properties[prefix + 'drawBindingArrows'].default, true);
  for (const name of ['includeRenamingSteps', 'highlightRedexContractum', 'drawBindingArrows']) {
    assert.equal(c.configuration.properties[prefix + name].scope, 'resource');
  }
  assert.equal(c.configuration.properties[prefix + 'alwaysSuffixMarkedIdentifiers'], undefined);
});

test('resident worker admits renamings when reconfigured and preserves expansion points', async t => {
  const snapshot = { sourceHash: 'a'.repeat(64), sourceVersion: 1 };
  const worker = createMacroSession(racket, helper, { ...request('(let ([x 1]) x)'), schemaVersion: 2,
    session: true, snapshot, hiding: 'none' });
  t.after(() => worker.stop());
  const off = await worker.start();
  assert.equal(off.stepCount, 3);
  const on = await worker.request({ mode: 'reexpand', snapshot, hiding: 'none', includeRenamingSteps: true });
  assert.equal(on.stepCount, 6);
  assert.deepEqual(on.steps.map(step => step.label), ['Macro transformation', 'Introduce scope for local bindings',
    'Add explicit #%datum', 'Macro transformation', 'Introduce scope for internal definition context', 'Resolve variable (remove extra scopes)']);
  assert.deepEqual(off.steps.map(step => step.expansionPoint), [on.steps[0], on.steps[2], on.steps[3]].map(step => step.expansionPoint));
  const before = await worker.request({ mode: 'position', snapshot, position: 2 });
  const section = before.record.before;
  assert.deepEqual(section.focus.map(range => section.text.slice(...range)), ['(x)', '1', 'x']);
  const standard = await worker.request({ mode: 'reexpand', snapshot, hiding: 'standard', includeRenamingSteps: true });
  assert.equal(standard.stepCount, 1);
  assert.equal(standard.steps[0].label, 'Resolve variable (remove extra scopes)');
  const reset = await worker.request({ mode: 'reexpand', snapshot, hiding: 'standard', includeRenamingSteps: false });
  assert.equal(reset.stepCount, 0);
});


test('a Settings change during the initial expansion is applied before its sequence is shown', async t => {
  const { ui, pane, worker } = await stepper(t, true, false, true);
  assert.equal(worker.request.includeRenamingSteps, false);
  assert.equal(pane.projection.count, 5);
  assert.equal(pane.projection.record.label, 'Introduce scope for module');
  assert.equal(ui.contexts['racketdap.macroSteps.includeRenamingSteps'], true);
});

test('Settings during Refresh uses the new snapshot and publishes only the latest filter', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  const document = await opened(ui), pane = ui.panels[0], oldSnapshot = pane.projection.snapshot;
  ui.edit(document, document.text + '(m)\n');
  const refreshing = ui.command('refresh'); await tick();
  const worker = ui.pending.at(-1), generation = pane.env.generation;
  assert.notEqual(worker.request.snapshot.sourceHash, oldSnapshot.sourceHash);
  ui.setSetting('racketdap.macroSteps.includeRenamingSteps', true); await tick();
  assert.equal(pane.env.generation, generation);
  assert.equal(worker.queries?.length || 0, 0, 'No query may reuse the displayed snapshot during Refresh');
  ui.answer(worker);
  await tick();
  let query = worker.queries.at(-1);
  assert.equal(query.mode, 'reexpand'); assert.equal(query.includeRenamingSteps, true);
  assert.deepEqual(query.snapshot, worker.request.snapshot);
  // A second edit during reconciliation belongs to this same load as well.
  ui.setSetting('racketdap.macroSteps.includeRenamingSteps', false); await tick();
  assert.equal(pane.env.generation, generation);
  ui.answer(worker); await tick();
  query = worker.queries.at(-1);
  assert.equal(query.mode, 'reexpand'); assert.equal(query.includeRenamingSteps, false);
  ui.answer(worker); await refreshing;
  assert.deepEqual(pane.projection.snapshot, plain(worker.request.snapshot));
  assert.equal(ui.pending.length, 2);
  assert.ok(ui.panels.every(p => !p.messages.some(m => m.type === 'actionResult' && !m.success)));
});

test('Settings during a line-policy fallback is reconciled before publishing', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('line-options');
  const opening = ui.open(false); await tick();
  const worker = ui.pending[0];
  ui.answer(worker, a => { for (const step of a.steps) step.source.line = 1; });
  await tick();
  assert.equal(worker.queries.at(-1).hiding, 'line');
  const generation = ui.panels[0].env.generation;
  ui.setSetting('racketdap.macroSteps.includeRenamingSteps', true);
  ui.answer(worker); await tick();
  const query = worker.queries.at(-1);
  assert.equal(query.mode, 'reexpand'); assert.equal(query.hiding, 'line');
  assert.equal(query.includeRenamingSteps, true);
  assert.equal(ui.panels[0].env.generation, generation);
  ui.answer(worker, a => { a.steps.unshift({ ...a.steps[0], id: 'scope', label: 'Introduce scope for local bindings' }); });
  await opening;
  assert.equal(ui.panels[0].projection.record.label, 'Introduce scope for local bindings');
  assert.equal(ui.panels[0].projection.count, 4);
});

for (const name of ['includeRenamingSteps', 'highlightRedexContractum', 'drawBindingArrows']) {
  for (const target of [1, 2, 3]) test(`${name} toggle changes the effective setting at scope ${target}`, async t => {
    const ui = fakeStepper(); t.after(() => ui.dispose());
    const key = `racketdap.macroSteps.${name}`;
    // Every lower scope conflicts with the scope supplying the effective value.
    for (let scope = 1; scope < target; scope++) ui.setSetting(key, true, scope);
    ui.setSetting(key, false, target);
    await opened(ui);
    const worker = ui.pending[0];
    const send = worker.send;
    worker.send = query => {
      if (query.mode !== 'reexpand') return send(query);
      (worker.queries ||= []).push(query);
      queueMicrotask(() => ui.answer(worker)); return true;
    };
    assert.equal(ui.contexts[key], false);
    await ui.command(name);
    assert.deepEqual(ui.settingUpdates.at(-1), { key, value: true, target });
    assert.equal(ui.workspace.getConfiguration('racketdap.macroSteps').get(name), true);
    assert.equal(ui.contexts[key], true);
    if (name !== 'includeRenamingSteps') for (const pane of ui.panels) {
      assert.equal(pane.messages.filter(m => m.type === 'state').at(-1)[name], true);
    }
    else assert.equal(worker.queries.find(q => q.mode === 'reexpand').includeRenamingSteps, true);
  });
}

test('each open session rebuilds independently and highlighting updates during a deferred rebuild', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui, 'A'); await opened(ui, 'B');
  const [a, b] = ui.pending, generation = ui.panels[0].env.generation;
  ui.setSetting('racketdap.macroSteps.includeRenamingSteps', true); await tick();
  for (const worker of [a, b]) {
    assert.equal(worker.queries.at(-1).mode, 'reexpand');
    assert.equal(worker.queries.at(-1).includeRenamingSteps, true);
  }
  assert.equal(ui.contexts['racketdap.macroSteps.includeRenamingSteps'], true);
  ui.setSetting('racketdap.macroSteps.highlightRedexContractum', false); await tick();
  assert.equal(ui.contexts['racketdap.macroSteps.highlightRedexContractum'], false);
  for (const pane of ui.panels) {
    const state = pane.messages.filter(m => m.type === 'state').at(-1);
    assert.equal(state.highlightRedexContractum, false);
  }
  ui.answer(b, data => { data.steps.push({ ...data.steps[0], id: 'extra', label: 'Introduce scope for module' }); });
  await tick(); await tick();
  assert.equal(ui.panels[2].projection.count, 4, 'B publishes while A is waiting');
  assert.equal(ui.panels[0].projection.count, 3);
  ui.setSetting('racketdap.macroSteps.includeRenamingSteps', false); await tick();
  ui.answer(a); await tick();
  assert.equal(ui.panels[0].env.generation, generation + 1, 'A keeps its running load');
  assert.equal(a.queries.at(-1).includeRenamingSteps, false);
  ui.answer(a); ui.answer(b); await tick(); await tick();
  assert.ok(ui.panels.every(p => p.projection.count === 3));
});
