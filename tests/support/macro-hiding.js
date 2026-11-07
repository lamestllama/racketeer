// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Drives hiding pickers and worker binding rules.
'use strict';
const { plain, tick } = require('./macro-common');
const assert = require('node:assert/strict');
const { fakeStepper, opened } = require('./macro-stepper');
async function customChoice(ui, keys = ['enabled', 'racket', 'library', 'contracts', 'phase']) {
  const picks = [];
  ui.window.showQuickPick = async (items, options) => {
    picks.push(plain({ items, options }));
    return options.canPickMany ? items.filter(item => keys.includes(item.key)) : items.find(item => item.value === 'custom');
  };
  const changing = ui.command('hiding'); await tick(); await tick();
  for (const process of ui.pending.filter(process => !process.stopped)) {
    if (process.queries?.at(-1)?.mode === 'reexpand') { ui.answer(process); await tick(); }
  }
  await changing;
  return picks;
}
async function applyCustomPicker(sources, keys = ['enabled', 'racket', 'library', 'phase']) {
  const ui = fakeStepper({ sources });
  ui.window.showQuickPick = undefined;
  try {
    await opened(ui);
    await ui.command('last');
    const opening = ui.command('hiding');
    const mode = await ui.command('_hidingPicker');
    assert.equal(mode.picker.title, 'Macro Hiding');
    assert.equal(mode.picker.activeItems[0].value, 'standard', 'Current mode starts with focus');
    // A single picker can accept the focused item without a selected item.
    mode.picker.activeItems = [mode.picker.items.find(item => item.value === 'custom')];
    mode.picker.selectedItems = [];
    mode.picker.accept();
    await tick();
    assert.equal(mode.picker.disposed, true);
    const checklist = await ui.command('_hidingPicker');
    assert.equal(checklist?.picker.title, 'Custom Macro Hiding', 'Accepting Custom opens its checklist');
    assert.equal(checklist.picker.canSelectMany, true);
    assert.deepEqual(plain(checklist.picker.selectedItems.map(item => item.key)), ['enabled', 'racket', 'library', 'contracts', 'phase']);
    // The focused contract row is independent of its checkbox. Accept must
    // apply selectedItems even when the focused row is unchecked.
    checklist.picker.activeItems = [checklist.picker.items.find(item => item.key === 'contracts')];
    checklist.picker.selectedItems = checklist.picker.items.filter(item => keys.includes(item.key));
    checklist.picker.accept();
    await tick();
    const process = ui.pending[0], query = process.queries.at(-1);
    assert.equal(query.mode, 'reexpand', 'Acceptance requests a new expansion');
    assert.equal(query.hiding, 'custom', 'Acceptance chooses Custom mode');
    const expected = Object.fromEntries(['enabled', 'racket', 'library', 'contracts', 'phase'].map(key => [key, keys.includes(key)]));
    assert.deepEqual(plain(query.custom), { ...expected, rules: [] }, 'Worker gets the checked switches');
    ui.answer(process); await opening;
    const state = await ui.command('_observe');
    assert.equal(state.hiding, 'custom');
    assert.deepEqual(plain(state.custom), { ...expected, rules: [] });
    assert.equal(state.position, 1); assert.equal(state.count, 3);
    assert.ok(ui.panels.every(panel => panel.messages.filter(message => message.type === 'state').at(-1).hiding === 'custom'));
    assert.ok(ui.panels.every(panel => panel.title.endsWith(' (Custom)') === expected.enabled));
    assert.equal(checklist.picker.disposed, true);
    assert.equal(await ui.command('_hidingPicker'), null);
    // A stale test handle cannot accept a disposed picker again.
    checklist.accept();
    const reopening = ui.command('hiding');
    const again = await ui.command('_hidingPicker');
    assert.equal(again.picker.activeItems[0].value, 'custom');
    again.picker.hide(); await reopening;
  } finally {
    (await ui.command('_hidingPicker'))?.picker.hide();
    ui.dispose();
  }
}
const customSettings = (rules = [], extra = {}) => ({ enabled: true, racket: true, library: true, contracts: true, phase: true, rules, ...extra });
async function workerRule(session, summary, snapshot, name, action, rules = []) {
  const position = summary.steps.findIndex(step => step.macro === name) + 1;
  assert.ok(position > 0, `The ${name} transformation is visible before adding a rule`);
  const projection = await session.request({ mode: 'position', snapshot, position });
  const section = projection.record.before;
  const term = section.occurrences.findLast(occurrence => projection.terms[occurrence.syntaxId].name === name);
  assert.ok(term);
  const rule = await session.request({ mode: 'hidingRule', snapshot, position, term: term.syntaxId,
    id: `${action}-${name}`, action, rules });
  assert.equal(rule.failed, undefined, rule.failed);
  assert.equal(typeof rule.syntax, 'string'); assert.ok(rule.syntax.length > 0);
  return rule;
}
module.exports = { customChoice, applyCustomPicker, customSettings, workerRule };
