// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper hiding behavior.
'use strict';
const { tick, plain, root, racket, helper } = require('./support/macro-common');
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const os = require('node:os');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { applyCustomPicker, customChoice, workerRule, customSettings } = require('./support/macro-hiding');
const { pair } = require('./support/macro-fixtures');
const { request } = require('./support/macro-worker');

test('hiding loads schema 2 in Standard/Disable and resets to first position', async () => {
  const ui = fakeStepper(); await opened(ui); const p = ui.panels[0]; await ui.command('last');
  const all = ui.command('showAll'); await tick();
  assert.equal(ui.pending.at(-1).queries.at(-1).mode, 'reexpand'); assert.equal(ui.pending.at(-1).queries.at(-1).hiding, 'none'); assert.equal(ui.pending.length, 1);
  ui.answer(ui.pending.at(-1)); await all; assert.equal(p.projection.position, 1);
  assert.equal(p.messages.filter(m => m.type === 'state').at(-1).hiding, 'disable');
  const mine = ui.command('showMine'); await tick(); assert.equal(ui.pending.at(-1).queries.at(-1).hiding, 'standard'); assert.equal(ui.pending.length, 1);
  ui.answer(ui.pending.at(-1)); await mine; assert.equal(p.projection.position, 1);
  ui.dispose();
});

test('Custom picker acceptance applies checked items independently of focus, including an empty checklist', async () => {
  await applyCustomPicker();
  await applyCustomPicker(undefined, ['contracts']);
  await applyCustomPicker(undefined, []);
});

test('Custom picker cancellation preserves the mode and settings and disposes both pickers', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  ui.window.showQuickPick = undefined;
  const before = plain(await ui.command('_observe')), queries = ui.pending[0].queries.length;
  const opening = ui.command('hiding');
  const mode = await ui.command('_hidingPicker');
  mode.picker.selectedItems = mode.picker.activeItems = [mode.picker.items.find(item => item.value === 'custom')];
  mode.accept(); await tick();
  const checklist = await ui.command('_hidingPicker');
  checklist.picker.selectedItems = [];
  checklist.picker.hide(); await opening;
  const after = plain(await ui.command('_observe'));
  assert.equal(after.hiding, before.hiding); assert.deepEqual(after.custom, before.custom);
  assert.equal(ui.pending[0].queries.length, queries);
  assert.equal(mode.picker.disposed, true); assert.equal(checklist.picker.disposed, true);
  assert.equal(await ui.command('_hidingPicker'), null);
});

test('Custom picker regressions detect broken acceptance, focus handling, checked settings and mode application', async () => {
  const file = 'vscode/macro-steps/hiding.js';
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const mutations = [
    ["items.filter(item => item.picked)", '[]'],
    ['picker.onDidAccept(accept)', 'picker.onDidAccept(() => finish(undefined))'],
    ['picker.selectedItems[0] || picker.activeItems[0]', 'picker.selectedItems[0]'],
    ['[...picker.selectedItems]', '[...picker.activeItems]'],
    ['picked.some(item => item.key === key)', 'true'],
    ['return applyCustom(v, true);', 'return applyCustom(v, false);'],
    ["v.hiding === 'custom' ? 'custom' : 'standard', lineReveal", "v.hiding === 'custom' ? 'standard' : 'standard', lineReveal", 'vscode/macro-steps/panes.js']
  ];
  for (const [before, after, target = file] of mutations) {
    const source = fs.readFileSync(path.join(root, target), 'utf8');
    assert.ok(source.includes(before), `Mutation target exists: ${before}`);
    await assert.rejects(applyCustomPicker({ [target]: source.replace(before, after) }), assert.AssertionError, `Regression detects: ${before}`);
  }
});

test('Custom quick picks mark the current mode, retain switches, cancel atomically and update both titles', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  let picks = await customChoice(ui);
  assert.deepEqual(picks[0].items.map(item => [item.label, item.description]), [
    ['Standard', 'Current'], ['Disable', undefined], ['Custom...', undefined]
  ]);
  assert.equal(picks[1].options.canPickMany, true);
  assert.deepEqual(picks[1].items.map(item => [item.label, item.picked]), [
    ['Enable macro hiding', true], ['Hide racket syntax', true], ['Hide library syntax', true],
    ['Hide contracts (heuristic)', true], ['Hide phase>0', true]
  ]);
  assert.ok(ui.panels.every(panel => panel.title.endsWith(' (Custom)')));
  assert.deepEqual(plain(ui.pending[0].queries.findLast(q => q.mode === 'reexpand').custom), {
    enabled: true, racket: true, library: true, contracts: true, phase: true, rules: []
  });
  picks = await customChoice(ui, ['enabled', 'racket']);
  assert.equal(picks[0].items.find(item => item.value === 'custom').description, 'Current');
  const retained = plain((await ui.command('_observe')).custom);
  assert.equal(retained.library, false); assert.equal(retained.phase, false);
  const count = ui.pending[0].queries.length;
  let stage = 0;
  ui.window.showQuickPick = async items => ++stage === 1 ? items.find(item => item.value === 'custom') : undefined;
  await ui.command('hiding');
  assert.deepEqual(plain((await ui.command('_observe')).custom), retained);
  assert.equal(ui.pending[0].queries.length, count);
  await customChoice(ui, ['racket']);
  assert.ok(ui.panels.every(panel => !panel.title.includes('(Custom)')));
  const standard = ui.command('showMine'); await tick(); ui.answer(ui.pending[0]); await standard;
  picks = await customChoice(ui, ['racket']);
  assert.deepEqual(picks[1].items.map(item => item.picked), [false, true, false, false, false]);
});

test('identifier rules use worker binding identities, replace equivalents, delete multiple entries and share the session', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui, 'A');
  await customChoice(ui);
  const first = ui.panels[0];
  await opened(ui, 'B');
  assert.ok(ui.panels.slice(2).every(panel => !panel.title.includes('(Custom)')), 'New views default to Standard');
  await customChoice(ui);
  const processB = ui.pending[1];
  ui.panels[3].reveal(); ui.panels[3].send('select', pair('a1', 'b')); await tick();
  const changing = ui.command('hideMacro'); await tick(); await tick();
  const capture = processB.queries.findLast(q => q.mode === 'hidingRule');
  assert.equal(capture.term, 'x'); assert.equal(capture.position, 1); assert.equal(capture.action, 'hide');
  assert.equal(capture.text, undefined);
  ui.answer(ui.pending[0]); await tick(); ui.answer(processB); await changing;
  const rule = (await ui.command('_observe')).custom.rules[0];
  assert.equal(rule.syntax, 'retained-syntax-context');
  assert.ok(ui.panels.every(panel => panel.title.endsWith(' (Custom)')));
  assert.ok(ui.pending.every(process => process.queries.findLast(q => q.mode === 'reexpand').custom.rules[0].id === rule.id));
  first.reveal(); first.send('select', pair()); await tick();
  const replacing = ui.command('showMacro'); await tick(); await tick();
  ui.answer(ui.pending[0]); await tick(); ui.answer(processB); await replacing;
  let rules = (await ui.command('_observe')).custom.rules;
  assert.equal(rules.length, 1); assert.equal(rules[0].action, 'show'); assert.notEqual(rules[0].id, rule.id);
  let offered;
  ui.window.showQuickPick = async (items, options) => { offered = plain({ items, options }); return []; };
  await ui.command('hidingRules');
  assert.deepEqual(offered.items.map(item => item.label), ["show 'x' imported from example/helpers"]);
  assert.equal(offered.options.canPickMany, true);
  assert.equal((await ui.command('_observe')).custom.rules.length, 1, 'Empty acceptance preserves the list');
  ui.window.showQuickPick = async items => items;
  const deleting = ui.command('hidingRules'); await tick();
  ui.answer(ui.pending[0]); await tick(); ui.answer(processB); await deleting;
  assert.equal((await ui.command('_observe')).custom.rules.length, 0);
  first.send('select', pair('b1', 'root')); await tick();
  const count = ui.pending[0].queries.length;
  await ui.command('hideMacro'); assert.equal(ui.pending[0].queries.length, count, 'Compound terms cannot create rules');
  for (const panel of ui.panels) panel.dispose();
  await opened(ui, 'C');
  const state = await ui.command('_observe');
  assert.equal(state.custom.enabled, true); assert.equal(state.hiding, 'standard');
});

test('rule picker preserves newest-first order, deletes selected identities and retains survivors', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  // Distinct binding identities come from the worker, independent of labels.
  const process = ui.pending[0], send = process.send;
  let serial = 0;
  process.send = query => {
    if (query.mode !== 'hidingRule') return send(query);
    process.queries.push(query);
    queueMicrotask(() => process.handlers.output(JSON.stringify({ id: query.id, action: query.action,
      label: `hide 'clamp' imported from lib${++serial}`, syntax: 'context', index: serial, replaces: [] }) + '\n'));
    return true;
  };
  for (let n = 0; n < 3; n++) {
    ui.panels[0].send('select', pair()); await tick();
    const adding = ui.command('hideMacro'); await tick(); await tick(); ui.answer(process); await adding;
  }
  let offered;
  ui.window.showQuickPick = async items => { offered = plain(items); return [items[0], items[2]]; };
  const deleting = ui.command('hidingRules'); await tick(); ui.answer(process); await deleting;
  assert.deepEqual(offered.map(item => item.label), [3, 2, 1].map(n => `hide 'clamp' imported from lib${n}`));
  assert.deepEqual(plain((await ui.command('_observe')).custom.rules.map(rule => rule.label)), ["hide 'clamp' imported from lib2"]);
});

test('Custom presentation checks reject broken defaults, title suffixes and switch labels', async t => {
  const hidingFile = 'vscode/macro-steps/hiding.js', panesFile = 'vscode/macro-steps/panes.js';
  const source = fs.readFileSync(path.join(root, hidingFile), 'utf8');
  async function checkDefaults(text) {
    const ui = fakeStepper({ sources: { [hidingFile]: text } });
    try {
      await opened(ui); ui.window.showQuickPick = undefined;
      const page = { settings: (await ui.command('_observe')).custom };
      const opening = ui.command('hiding');
      const mode = await ui.command('_hidingPicker');
      mode.picker.activeItems = [mode.picker.items.find(item => item.value === 'custom')];
      mode.accept(); await tick();
      const checklist = await ui.command('_hidingPicker');
      page.switches = checklist.picker.items.map(item => [item.key, item.label]);
      checklist.picker.hide(); await opening;
      assert.equal(page.settings.enabled, true);
      assert.equal(page.settings.phase, true);
      assert.deepEqual(plain(page.switches.map(item => item[1])), [
        'Enable macro hiding', 'Hide racket syntax', 'Hide library syntax', 'Hide contracts (heuristic)', 'Hide phase>0'
      ]);
    } finally { ui.dispose(); }
  }
  await checkDefaults(source);
  for (const [before, after] of [['enabled: true', 'enabled: false'], ['phase: true', 'phase: false'], ['Hide phase>0', 'Hide phase 1']]) {
    await assert.rejects(checkDefaults(source.replace(before, after)), assert.AssertionError);
  }
  const title = fs.readFileSync(path.join(root, panesFile), 'utf8');
  const checkTitle = async body => {
    const ui = fakeStepper({ sources: { [panesFile]: body } });
    try {
      await opened(ui); await customChoice(ui);
      const page = { v: { panel: ui.panels[0] } };
      assert.ok(page.v.panel.title.endsWith(' (Custom)'));
    } finally { ui.dispose(); }
  };
  await checkTitle(title);
  await assert.rejects(checkTitle(title.replace("' (Custom)'", "''")), assert.AssertionError);
});

test('real Custom worker hides and shows selected module and lexical bindings after re-expansion and worker replacement', async t => {
  for (const [name, text] of [
    ['own', '#lang racket/base\n(define-syntax-rule (own x) x)\n(own 1)\n'],
    ['local', '#lang racket/base\n(let-syntax ([local (syntax-rules () [(_ x) x])]) (local 1))\n']
  ]) {
    const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
    const input = { ...request(text, 'module'), schemaVersion: 2, session: true, snapshot };
    const session = createMacroSession(racket, helper, input); t.after(() => session.stop());
    const shown = await session.start();
    const rule = await workerRule(session, shown, snapshot, name, 'hide');
    assert.ok(Number.isSafeInteger(rule.index), 'The selected identifier has an exact derivation identity');
    const query = { mode: 'reexpand', snapshot, hiding: 'custom', custom: customSettings([rule]) };
    const hidden = await session.request(query);
    assert.equal(hidden.failed, undefined, hidden.failed);
    assert.ok(!hidden.steps.some(step => step.macro === name));
    const restored = createMacroSession(racket, helper, { ...input, hiding: 'custom', custom: customSettings([rule]) });
    t.after(() => restored.stop());
    const replaced = await restored.start();
    assert.equal(replaced.failed, undefined, replaced.failed);
    assert.deepEqual(replaced.steps.map(step => step.macro), hidden.steps.map(step => step.macro));
    const deleted = await session.request({ ...query, custom: customSettings() });
    assert.deepEqual(deleted.steps.map(step => step.macro), shown.steps.map(step => step.macro));
    const bypassed = await session.request({ ...query, custom: customSettings([rule], { enabled: false }) });
    assert.ok(bypassed.steps.some(step => step.macro === name));
    await session.stop(); await restored.stop();
  }
});

test('real worker shares an imported binding rule across sources without hiding equal spellings from another binding', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-custom-binding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'helper.rkt'), '#lang racket/base\n(provide helper)\n(define-syntax-rule (helper x) x)\n');
  const text = '#lang racket/base\n(require "helper.rkt")\n(helper 7)\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const input = { ...request(text, 'module'), source: path.join(directory, 'first.rkt'), sourceIsFile: true,
    directory, schemaVersion: 2, session: true, snapshot };
  const session = createMacroSession(racket, helper, input); t.after(() => session.stop());
  const summary = await session.start();
  const rule = await workerRule(session, summary, snapshot, 'helper', 'hide');
  assert.equal(rule.label, `hide 'helper' imported from "helper.rkt"`);
  const show = await workerRule(session, summary, snapshot, 'helper', 'show');
  assert.equal(show.label, `show 'helper' imported from "helper.rkt"`);
  const other = createMacroSession(racket, helper, { ...input, source: path.join(directory, 'second.rkt'), hiding: 'custom', custom: customSettings([rule]) });
  t.after(() => other.stop());
  const hidden = await other.start();
  assert.equal(hidden.failed, undefined, hidden.failed);
  assert.deepEqual(hidden.steps.map(step => step.macro), []);
  const independentText = '#lang racket/base\n(define-syntax-rule (helper x) x)\n(helper 7)\n';
  const independent = createMacroSession(racket, helper, { ...input, text: independentText, source: path.join(directory, 'third.rkt'),
    hiding: 'custom', custom: customSettings([rule]) });
  t.after(() => independent.stop());
  const visible = await independent.start();
  assert.equal(visible.failed, undefined, visible.failed);
  assert.deepEqual(visible.steps.map(step => step.macro), ['helper']);
});

test('shared own rules do not hide a different source module with the same spelling', async t => {
  const text = '#lang racket/base\n(define-syntax-rule (own x) x)\n(own 1)\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const input = { ...request(text, 'module'), source: 'untitled:first', schemaVersion: 2, session: true, snapshot };
  const session = createMacroSession(racket, helper, input); t.after(() => session.stop());
  const rule = await workerRule(session, await session.start(), snapshot, 'own', 'hide');
  const other = createMacroSession(racket, helper, { ...input, source: 'untitled:second', hiding: 'custom', custom: customSettings([rule]) });
  t.after(() => other.stop());
  const summary = await other.start();
  assert.equal(summary.failed, undefined, summary.failed);
  assert.deepEqual(summary.steps.map(step => step.macro), ['own']);
});

test('a shared rule follows a defining source module between its own view and an importing view', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-custom-own-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const definition = '#lang racket/base\n(provide own)\n(define-syntax-rule (own x) x)\n(own 1)\n';
  const source = path.join(directory, 'definition.rkt'); fs.writeFileSync(source, definition);
  const importer = '#lang racket/base\n(require "definition.rkt")\n(own 2)\n';
  const sessions = [];
  async function start(text, filename) {
    const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
    const session = createMacroSession(racket, helper, { ...request(text, 'module'), directory, source: filename,
      sourceIsFile: true, schemaVersion: 2, session: true, snapshot });
    sessions.push(session); t.after(() => session.stop());
    return { session, snapshot, summary: await session.start() };
  }
  const own = await start(definition, source), imported = await start(importer, path.join(directory, 'importer.rkt'));
  for (const [from, to] of [[own, imported], [imported, own]]) {
    const rule = await workerRule(from.session, from.summary, from.snapshot, 'own', 'hide');
    const hidden = await to.session.request({ mode: 'reexpand', snapshot: to.snapshot, hiding: 'custom', custom: customSettings([rule]) });
    assert.equal(hidden.failed, undefined, hidden.failed);
    assert.deepEqual(hidden.steps.map(step => step.macro), []);
    await to.session.request({ mode: 'reexpand', snapshot: to.snapshot, hiding: 'standard' });
  }
});

test('Custom rules and disabled switches survive closing every view and reset for a new extension session', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  await customChoice(ui, ['racket']);
  ui.panels[0].send('select', pair()); await tick();
  const adding = ui.command('hideMacro'); await tick(); await tick(); ui.answer(ui.pending[0]); await adding;
  const retained = plain((await ui.command('_observe')).custom);
  assert.equal(retained.enabled, false); assert.equal(retained.rules.length, 1);
  assert.ok(ui.panels.every(panel => !panel.title.includes('(Custom)')));
  ui.panels[0].dispose();
  await opened(ui, 'new-view');
  assert.deepEqual(plain((await ui.command('_observe')).custom), retained);
  assert.equal((await ui.command('_observe')).hiding, 'standard');
  const fresh = fakeStepper(); t.after(() => fresh.dispose()); await opened(fresh);
  assert.deepEqual(plain((await fresh.command('_observe')).custom), customSettings());
});
