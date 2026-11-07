// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks position layout against complete worked traces and option restoration.
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const { racket, helper, tick, plain } = require('./support/macro-common');
const { request } = require('./support/macro-worker');
const { fakeStepper } = require('./support/macro-stepper');
const { summaryOf, fakeModel, pair, fixtureAnswer, project } = require('./support/macro-fixtures');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const Model = require('../vscode/macro-view/model');
const Editor = require('../vscode/macro-view/monaco');
const Data = require('../vscode/macro-view-data');
const snapshot = { sourceHash: 'a'.repeat(64), sourceVersion: 1 };
const definition = '(define-syntax-rule (m x) (+ x 1))';
const text = (p, pane) => Editor.compose(Model.sections({ ...p, ...(pane ? { pane } : {}) })).text;
async function worker(t, program, oneTermAtATime = false, hiding = 'standard') {
  const session = createMacroSession(racket, helper, { ...request(program, 'module'), schemaVersion: 2,
    session: true, snapshot, hiding, oneTermAtATime });
  t.after(() => session.stop());
  return { session, summary: await session.start(), get: (position, factorCommonContext) => session.request({
    mode: 'position', snapshot, position, factorCommonContext, columns: 160 }) };
}
async function visibleLet(t, oneTermAtATime = false, includeRenamingSteps = false) {
  const w = await worker(t, '(module larger racket/base (#%module-begin (define z 9) (+ z (let ([x 1]) x))))', false, 'none');
  const position = w.summary.steps.findIndex(step => step.macro === 'let') + 1;
  assert.ok(position > 0);
  const initial = await w.get(position, false);
  const selected = initial.record.before.occurrences.find(o => initial.terms[o.syntaxId].name === 'let');
  const rule = await w.session.request({ mode: 'hidingRule', snapshot, position, term: selected.syntaxId,
    id: 'let', action: 'show', rules: [] });
  const custom = { enabled: true, racket: true, library: true, contracts: true, phase: true, rules: [rule] };
  w.summary = await w.session.request({ mode: 'reexpand', snapshot, hiding: 'custom', custom, oneTermAtATime, includeRenamingSteps });
  return { ...w, custom };
}
const programs = [
  { name: 'own', body: `${definition} (m 2)`, states: ['(m 2)', '(+ 2 1)'],
    before: ['(m 2)'], after: ['(+ 2 1)'], context: ['[ HOLE ]'] },
  { name: 'larger', body: '(define z 9) (+ z (let ([x 1]) x))', states: ['(+ z (let ([x 1]) x))', '(+ z (let-values (((x) 1)) x))'],
    before: ['(let ([x 1]) x)'], after: ['(let-values (((x) 1)) x)'], context: ['(+ z [ HOLE ])'] },
  { name: 'nested', body: `${definition} (m (m 2))`, states: ['(m (m 2))', '(+ (m 2) 1)', '(+ (+ 2 1) 1)'],
    before: ['(m (m 2))', '(m 2)'], after: ['(+ (m 2) 1)', '(+ 2 1)'], context: ['[ HOLE ]', '(+ [ HOLE ] 1)'] }
];
for (const example of programs) for (const one of [false, true]) test(`${example.name}: exact text in every pane and position, A=${one}, B off/on`, async t => {
  const { name, body, states, before, after, context } = example;
  const module = expression => `(module ${name} racket/base (#%module-begin ${name === 'larger' ? '(define z 9)' : definition} ${expression}))\n`;
  const w = name === 'larger' ? await visibleLet(t, one) : await worker(t, `(module ${name} racket/base (#%module-begin ${body}))`, one);
  const count = (states.length - 1) * (one ? 2 : 1) + 1;
  assert.equal(w.summary.stepCount + 1, count);
  for (const factor of [false, true]) {
    for (let i = 0; i < states.length - 1; i++) {
      if (one) {
        for (const [offset, side, value] of [[1, 'before', states[i]], [2, 'after', states[i + 1]]]) {
          const p = Data.validatePosition(await w.get(2 * i + offset, factor), w.summary, 2 * i + offset);
          const expected = module(value);
          assert.equal(text(p), expected);
          assert.equal(text(p, side), expected);
          assert.equal(text(p, side === 'before' ? 'after' : 'before'), '');
          assert.equal(p.record.commonContext ?? null, null);
          assert.equal(p.record.label, 'Macro transformation');
          assert.equal(p.record.macro, name === 'larger' ? 'let' : 'm');
          const section = p.record[side];
          const decorations = Editor.decorations(fakeModel(section.text), [{ section, kind: side, offset: n => n }]);
          assert.ok(decorations.some(d => d.options.inlineClassName === `macro-${side}`));
        }
      } else {
        const p = Data.validatePosition(await w.get(i + 1, factor), w.summary, i + 1);
        assert.equal(text(p), factor ? `${before[i]}\n${after[i]}\n\nIn context:\n${module(context[i])}`
          : `${module(states[i])}${module(states[i + 1])}`);
        assert.equal(text(p, 'before'), factor ? before[i] + '\n' : module(states[i]));
        assert.equal(text(p, 'after'), factor ? `${after[i]}\n\nIn context:\n${module(context[i])}` : module(states[i + 1]));
        if (factor) {
          assert.deepEqual(p.record.commonContext.focus, []);
          assert.deepEqual(p.record.commonContext.frontier || [], []);
        }
      }
    }
    const final = await w.get(count, factor);
    assert.equal(text(final, 'before'), module(states.at(-1)));
    assert.equal(text(final, 'after'), module(states.at(-1)));
    assert.equal(text(final), module(states.at(-1)));
  }
});

test('factored arrows remain inside each separately printed display, with an arrow retained inside the residual binding', async t => {
  const w = await visibleLet(t, false, true), summary = w.summary;
  assert.equal(summary.stepCount, 4);
  const p = await w.get(2, true), r = p.record;
  assert.equal(r.before.text, '(let-values (((x) 1)) x)\n');
  assert.equal(r.after.text, r.before.text);
  assert.equal(r.commonContext.text, '(module larger racket/base (#%module-begin (define z 9) (+ z [ HOLE ])))\n');
  const variable = await w.get(4, true);
  assert.equal(variable.record.before.text, 'x\n');
  assert.deepEqual(variable.record.before.edges, [], 'The body fragment cannot reach its binder in common context');
  assert.deepEqual(variable.record.after.edges, []);
  for (const { section } of Model.sections(variable)) {
    const ids = new Set(section.occurrences.map(o => o.id));
    assert.ok(section.edges.every(e => ids.has(e.binder) && ids.has(e.reference)));
    Model.validateSection(section, variable.terms);
  }
  const split = await w.session.request({ mode: 'reexpand', snapshot, hiding: 'custom', oneTermAtATime: true,
    custom: w.custom });
  assert.equal(split.stepCount, 8);
});

async function splitUI(t, points = [10, 10, 20, 20], duringLoad = false) {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('options'); const opening = ui.open(true); await tick();
  const process = ui.pending[0];

  ui.answer(process, a => a.steps.forEach((s, i) => { s.expansionPoint = points[i * 2]; }));
  const original = process.send, full = process.data.steps;
  process.send = query => {
    if (query.mode !== 'reexpand') return original(query);
    (process.queries ||= []).push(query);
    const steps = query.oneTermAtATime ? full.flatMap((s, i) => [
      { ...s, id: s.id + 'b', side: 'before', after: null, expansionPoint: points[i * 2] },
      { ...s, id: s.id + 'a', side: 'after', before: null, expansionPoint: points[i * 2 + 1] }
    ]) : full;
    process.data = { ...process.data, steps };
    queueMicrotask(() => ui.finish(process, summaryOf(process.data))); return true;
  };
  await opening;
  if (duringLoad) await ui.command('oneTermAtATime');
  return { ui, process, panes: ui.panels };
}
test('A menu uses remembered progress, keeps end, and navigation visits every half with correct titles and empty panes', async t => {
  const { ui, process, panes: [before, after] } = await splitUI(t);
  await ui.command('jump', 2); await ui.command('oneTermAtATime');
  assert.equal(before.projection.position, 3);
  assert.equal(before.title, 'Before - Step 3 of 5 - options');
  assert.match(after.title, /After - \[Macro transformation\]/);
  assert.equal(after.projection.record.label, before.projection.record.label);
  for (const [command, value, number, side] of [['first', null, 1, 'before'], ['next', null, 2, 'after'],
    ['next', null, 3, 'before'], ['previous', null, 2, 'after'], ['jump', 4, 4, 'after']]) {
    await ui.command(command, value);
    assert.equal(before.projection.position, number); assert.equal(after.projection.position, number);
    assert.equal(text(side === 'before' ? after.projection : before.projection), '');
    assert.equal(text(side === 'before' ? before.projection : after.projection), '(x x)\n');
  }
  await ui.command('oneTermAtATime'); assert.equal(before.projection.position, 2);
  await ui.command('oneTermAtATime'); assert.equal(before.projection.position, 3);
  await ui.command('last'); assert.equal(before.projection.position, 5);
  await ui.command('oneTermAtATime'); assert.equal(before.projection.position, 3);
  await ui.command('oneTermAtATime'); assert.equal(before.projection.position, 5);
  await ui.command('jump', 2); assert.equal(before.projection.record.side, 'after');
  for (const invalid of [0, -1, 6, '2.0', 'END', 'bad']) {
    await ui.command('jump', invalid); assert.equal(before.projection.position, 2);
  }
  await ui.command('jump', 'end'); assert.equal(before.projection.position, 5);
  assert.equal(ui.contexts['racketdap.macroSteps.atEnd'], true);
  assert.equal(ui.pending.length, 1);
  assert.ok(process.queries.some(q => q.mode === 'reexpand' && q.oneTermAtATime));
});

for (const one of [false, true]) for (const factor of [false, true]) {
  test(`transformer contexts follow the term and common context in their pane, A=${one}, B=${factor}`, () => {
    const a = fixtureAnswer(snapshot), original = a.steps[0];
    const contexts = ['outer', 'inner'].map(id => ({ label: 'While executing macro transformer in:',
      section: { ...original.before, id } }));
    for (const side of one ? ['before', 'after'] : [null]) {
      const record = { ...original, contexts };
      if (side) { record.side = side; record[side === 'before' ? 'after' : 'before'] = null; }
      else if (factor) record.commonContext = { ...original.before, id: 'common', text: '[ HOLE ]\n',
        occurrences: [], focus: [], edges: [], binderOccurrences: [] };
      a.steps[0] = record;
      const p = Data.validatePosition(project(a, 1), summaryOf(a), 1);
      const active = side || 'after', inactive = active === 'before' ? 'after' : 'before';
      const sections = Model.sections({ ...p, pane: active });
      assert.deepEqual(sections.map(s => s.section.id), [record[active].id,
        ...(!side && factor ? ['common'] : []), 'outer', 'inner']);
      const suffix = contexts.map(c => '\nWhile executing macro transformer in:\n' + c.section.text).join('');
      assert.equal(text(p, active), record[active].text + (!side && factor ? '\nIn context:\n[ HOLE ]\n' : '') + suffix);
      assert.equal(text(p, inactive), side ? '' : original.before.text);
      const combined = Editor.compose(sections);
      for (const part of combined.parts) {
        assert.equal(combined.text.slice(part.start, part.end), part.section.text);
        assert.equal(part.offset(1), part.start + 1, 'Headings stay outside syntax occurrence coordinates');
      }
      for (const { section, kind } of sections.slice(-2)) {
        assert.equal(kind, 'before');
        assert.deepEqual(section.focus, original.before.focus);
        assert.deepEqual(section.edges, original.before.edges);
        const ids = new Set(section.occurrences.map(o => o.id));
        assert.ok(section.edges.every(e => ids.has(e.binder) && ids.has(e.reference)));
      }
    }
  });

  test(`remarks keep contexts in both panes with a heading for each, A=${one}, B=${factor}`, async t => {
    const program = '#lang racket/base\n(require (for-syntax racket/base))\n' +
      '(define-syntax (m stx) (syntax-local-lift-expression #\'(+ 1 2)) #\'0)\n' +
      '(define-syntax (outer stx) (local-expand #\'(m) \'expression null))\n(outer)';
    const w = await worker(t, program, one, 'none');
    const positions = w.summary.steps.flatMap((s, i) => s.kind === 'remark' ? [i + 1] : []);
    assert.equal(positions.length, 1, 'A remark remains a single position');
    const p = Data.validatePosition(await w.get(positions[0], factor), w.summary, positions[0]);
    const r = p.record;
    assert.equal(r.after, null);
    assert.ok(r.contexts.length > 1, 'Check the heading before every context');
    const expected = r.before.text + r.contexts.map(c => '\nWhile executing macro transformer in:\n' + c.section.text).join('');
    for (const pane of ['before', 'after']) {
      assert.deepEqual(Model.sections({ ...p, pane }).map(s => s.section.id), [r.before.id, ...r.contexts.map(c => c.section.id)]);
      assert.equal(text(p, pane), expected);
    }
  });

  test(`the Before title counts every displayed position including finished, A=${one}, B=${factor}`, async t => {
    const { ui, panes } = await splitUI(t);
    if (one) await ui.command('oneTermAtATime');
    if (factor) await ui.command('factorCommonContext');
    const count = one ? 5 : 3;
    for (let n = 1; n <= count; n++) {
      await ui.command('jump', n);
      for (const pane of panes) {
        assert.equal(pane.projection.position, n);
        assert.equal(pane.projection.count, count);
      }
      assert.match(panes[0].title, new RegExp(`^Before - Step ${n} of ${count} - `));
      assert.doesNotMatch(panes[1].title, /Step \d+ of/, 'The counter stays on the Before tab');
    }
    assert.match(panes[1].title, /After - Finished/);
  });
}

test('different After progress is restored without scaling, for distinct expansion states', async t => {
  const { ui, panes } = await splitUI(t, [10, 15, 20, 25], true);
  assert.equal(panes[0].projection.count, 5);
  await ui.command('jump', 2); await ui.command('oneTermAtATime');
  assert.equal(panes[0].projection.position, 2, 'First surviving Before progress at least 15 is 20');
  await ui.command('oneTermAtATime');
  assert.equal(panes[0].projection.position, 2, 'Remembered progress 15 survives restoration at progress 20');
  assert.equal(panes[0].projection.record.side, 'after');
});

for (const name of ['oneTermAtATime', 'factorCommonContext']) for (const scope of [1, 2, 3]) test(`${name} updates supplying scope ${scope} and both panes`, async t => {
  const { ui, panes } = await splitUI(t);
  const key = 'racketdap.macroSteps.' + name;
  for (let lower = 1; lower < scope; lower++) ui.setSetting(key, true, lower);
  ui.setSetting(key, false, scope); await tick(); await tick();
  await ui.command(name);
  assert.deepEqual(ui.settingUpdates.at(-1), { key, value: true, target: scope });
  assert.equal(ui.contexts[key], true);
  for (const p of panes) assert.equal(p.messages.filter(m => m.type === 'state').at(-1)[name], true);
});

test('selection follows syntax across panes, halves and option redraws; absence keeps its identity until cleared', async t => {
  const { ui, panes: [before, after] } = await splitUI(t);
  before.send('select', pair('b1')); await tick();
  assert.equal(after.selection.selected, null, 'Default selection stays local until an option is enabled');
  await ui.command('oneTermAtATime');
  assert.equal(before.selection.syntaxId, 'x'); assert.equal(after.selection.selected, null);
  await ui.command('next');
  assert.equal(before.selection.selected, null); assert.equal(after.selection.syntaxId, 'x');
  await ui.command('factorCommonContext');
  assert.equal(after.selection.syntaxId, 'x'); assert.equal(after.projection.record.commonContext, undefined);
  await ui.command('clearSelection');
  assert.equal(before.selection.selected, null); assert.equal(after.selection.selected, null);
  await ui.command('previous'); assert.equal(before.selection.selected, null);
});

test('saved option defaults apply to new pairs while existing pairs keep their own values', async t => {
  const { ui, panes: [first], process } = await splitUI(t);
  await ui.command('factorCommonContext');
  await ui.source('second-options'); const opening = ui.open(true); await tick();
  const secondProcess = ui.pending.at(-1); ui.answer(secondProcess); await opening;
  const second = ui.panels[2];
  assert.equal(first.messages.filter(m => m.type === 'state').at(-1).factorCommonContext, true);
  assert.equal(second.messages.filter(m => m.type === 'state').at(-1).factorCommonContext, true);
  await ui.command('factorCommonContext');
  assert.equal(first.messages.filter(m => m.type === 'state').at(-1).factorCommonContext, true);
  assert.equal(second.messages.filter(m => m.type === 'state').at(-1).factorCommonContext, false);
  assert.equal(process.queries.at(-1).factorCommonContext, true);
});

test('a same-spelled identifier with different syntax does not replace the remembered selection', async t => {
  const { ui, process, panes: [before, after] } = await splitUI(t);
  for (const step of process.data.steps) for (const occurrence of step.after.occurrences) {
    if (occurrence.syntaxId === 'x') occurrence.syntaxId = 'other-x';
  }
  process.data.terms['other-x'] = process.data.terms.x;
  before.send('select', pair('b1')); await tick();
  await ui.command('oneTermAtATime'); await ui.command('next');
  assert.equal(after.selection.selected, null);
  await ui.command('previous'); assert.equal(before.selection.syntaxId, 'x');
});

test('factored fragments share identifier relations across displays without gaining cross-display arrows', () => {
  const section = (id, name, syntaxId) => ({ id, text: name + '\n', focus: [], binderOccurrences: [], edges: [],
    occurrences: [{ id: 'o', syntaxId, range: [0, name.length], parentId: null, delimiterRanges: [], macroScopeGroup: 0 }] });
  const p = { record: { kind: 'rewrite', before: section('fragment', 'x', 'use'), after: section('after', 'x', 'use'),
    commonContext: section('common', 'x', 'binder'), contexts: [] }, terms: {
    use: { kind: 'identifier', name: 'x', relations: { free: 'binding' } },
    binder: { kind: 'identifier', name: 'x', relations: { free: 'binding' } }
  }, diagnostics: {} };
  assert.deepEqual(Model.bindingOccurrences(p, { sectionId: 'fragment', occurrenceId: 'o' }).map(p => p.sectionId), ['fragment', 'after', 'common']);
  assert.deepEqual(Model.incident(p, { sectionId: 'fragment', occurrenceId: 'o' }), []);
});

test('a preceding remark can be the first qualifying progress point after splitting an outer rewrite', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('remark-progress'); const opening = ui.open(true); await tick();
  const process = ui.pending[0];
  ui.answer(process, a => {
    Object.assign(a.steps[0], { kind: 'remark', after: null, label: 'Macro made a remark', expansionPoint: 20 });
    a.steps[1].expansionPoint = 10;
  });
  const initial = process.data.steps, send = process.send;
  process.send = q => {
    if (q.mode !== 'reexpand') return send(q);
    process.queries.push(q);
    process.data = { ...process.data, steps: q.oneTermAtATime ? [initial[0],
      { ...initial[1], id: 'before', side: 'before', after: null },
      { ...initial[1], id: 'after', side: 'after', before: null, expansionPoint: 30 }] : initial };
    queueMicrotask(() => ui.finish(process, summaryOf(process.data))); return true;
  };
  await opening; await ui.command('jump', 2); await ui.command('oneTermAtATime');
  assert.equal(ui.panels[0].projection.position, 1);
  assert.equal(ui.panels[0].projection.record.kind, 'remark');
  assert.equal(ui.panels[0].projection.count, 4);
  assert.equal(text(ui.panels[1].projection), text(ui.panels[0].projection), 'Remarks retain committed routing to both panes');
  await ui.command('last'); await ui.command('oneTermAtATime');
  assert.equal(ui.panels[0].projection.position, 3);
});

test('a trace with no visible transformations has one terminal position and all navigation disabled', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  ui.setSetting('racketdap.macroSteps.oneTermAtATime', true);
  ui.setSetting('racketdap.macroSteps.factorCommonContext', true);
  await ui.source('empty-trace'); const opening = ui.open(true); await tick();
  ui.answer(ui.pending[0], a => { a.steps = []; }); await opening;
  for (const action of ['first', 'previous', 'next', 'last']) {
    await ui.command(action);
    assert.equal(ui.panels[0].projection.count, 1);
    assert.equal(ui.panels[0].projection.position, 1);
    assert.equal(ui.contexts['racketdap.macroSteps.atStart'], true);
    assert.equal(ui.contexts['racketdap.macroSteps.atEnd'], true);
    assert.equal(text(ui.panels[0].projection), '(x x)\n');
    assert.equal(text(ui.panels[1].projection), '(x x)\n');
    assert.match(ui.panels[0].title, /^Before - Step 1 of 1 - empty-trace$/);
    assert.match(ui.panels[1].title, /^After - Finished - empty-trace$/);
  }
});

test('errors retain the committed failing program, syntax labels and transformer contexts for every option combination', async t => {
  const program = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    '(define-syntax (outer stx) (local-expand #\'(missing) \'expression null))\n(outer)\n';
  let expected;
  for (const one of [false, true]) {
    const w = await worker(t, program, one);
    const errorPositions = w.summary.steps.map((s, i) => s.kind === 'error' ? i + 1 : null).filter(Boolean);
    assert.equal(errorPositions.length, 1);
    for (const factor of [false, true]) for (const position of [...errorPositions, w.summary.stepCount + 1]) {
      const p = Data.validatePosition(await w.get(position, factor), w.summary, position);
      const diagnostic = p.diagnostics[p.error];
      assert.ok(diagnostic.program);
      if (p.record) assert.deepEqual(diagnostic.program, p.record.before);
      assert.ok(diagnostic.syntax.length);
      assert.ok(diagnostic.contexts.length);
      assert.ok(diagnostic.contexts.every(c => c.label === 'While executing macro transformer in:'));
      const sections = pane => Model.sections({ ...p, pane }).map(({ section, label, kind }) => ({ text: section.text, label, kind }));
      const actual = { before: sections('before'), after: sections('after') };
      if (!expected) expected = actual;
      assert.deepEqual(actual, expected);
      assert.equal(actual.before[0].label, 'Before');
      assert.deepEqual(actual.after.slice(0, 2).map(s => s.label), ['Failing program', 'Implicated syntax']);
      assert.equal(text(p, 'before'), diagnostic.program.text);
      const displayed = Model.sections({ ...p, pane: 'after' });
      const contexts = displayed.filter(s => diagnostic.contexts.some(c => c.section.id === s.section.id));
      assert.equal(contexts.length, diagnostic.contexts.length);
      assert.equal(text(p, 'after'), displayed.map(s =>
        (diagnostic.contexts.some(c => c.section.id === s.section.id) ? '\nWhile executing macro transformer in:\n' : '') + s.section.text).join(''));
      for (const pane of ['before', 'after']) assert.doesNotMatch(text(p, pane), /→  \[|Expansion finished/);
    }
  }
});

test('turning both options off restores the committed pane-local selection and Clear Selection behavior', async t => {
  const { ui, panes: [before, after] } = await splitUI(t);
  await ui.command('oneTermAtATime');
  await ui.command('oneTermAtATime');
  before.send('select', pair('b1')); await tick();
  assert.deepEqual(plain(before.selection.selected), pair('b1'));
  assert.equal(after.selection.selected, null);
  assert.equal(Object.hasOwn(before.selection, 'identity'), false);
  assert.equal(Object.hasOwn(after.selection, 'identity'), false);
  await ui.command('clearSelection');
  assert.deepEqual(plain(before.selection.selected), pair('b1'));
});
