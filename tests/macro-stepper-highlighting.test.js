// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks immediate change-background updates and preservation of other decorations.
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { tick, plain, racket, helper } = require('./support/macro-common');
const { fakeMacroConnections } = require('./support/macro-page');
const { fixtureAnswer, project, pair } = require('./support/macro-fixtures');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const { request } = require('./support/macro-worker');

test('highlight checkbox is saved, applied to both panes, and follows Settings changes', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const worker = ui.pending[0], before = ui.panels[0], projection = before.projection;
  const queries = worker.queries.length;
  assert.equal(ui.contexts['racketdap.macroSteps.highlightRedexContractum'], true);
  await ui.command('highlightRedexContractum');
  assert.equal(ui.contexts['racketdap.macroSteps.highlightRedexContractum'], false);
  assert.equal(ui.settings.get('racketdap.macroSteps.highlightRedexContractum'), false);
  for (const pane of ui.panels) assert.equal(pane.messages.filter(m => m.type === 'state').at(-1).highlightRedexContractum, false);
  assert.equal(worker.queries.length, queries); assert.equal(before.projection, projection);
  ui.setSetting('racketdap.macroSteps.highlightRedexContractum', true); await tick();
  assert.equal(ui.contexts['racketdap.macroSteps.highlightRedexContractum'], true);
  assert.equal(worker.queries.length, queries);
  await ui.command('highlightRedexContractum');
  await opened(ui, 'new');
  assert.equal(ui.contexts['racketdap.macroSteps.highlightRedexContractum'], false);
});

for (const side of ['before', 'after']) test(`${side}: off removes only change backgrounds; on restores them`, () => {
  const pane = fakeMacroConnections(side), { page, editor, listeners, decorationCalls } = pane;
  const p = project(fixtureAnswer({}), 1);
  pane.render(p);
  const sectionId = side === 'before' ? 'b1' : 'a1', focused = pair(sectionId, 'b');
  page.focused = focused; page.hover = focused; page.state.pins = [focused];
  page.selected = { selected: focused, related: [pair(sectionId, 'r')], syntaxId: 'x', properties: null };
  page.updateDecorations(); page.draw();
  const original = plain(decorationCalls.at(-1).values), projection = page.projection;
  const other = values => values.filter(d => !/^macro-(before|after)$/.test(d.options.description));
  const changes = values => values.filter(d => /^macro-(before|after)$/.test(d.options.description));
  const snapshot = () => plain({ focused: page.focused, selected: page.selected, pins: page.state.pins,
    groups: page.sections.map(s => s.section.occurrences.map(o => o.macroScopeGroup)),
    text: page.editorModel.getValue(), tokens: page.tokenSections, styles: page.tokenStyles,
    position: page.projection.position, arrows: page.drawn, boxes: page.boxes, selection: editor.getSelection() });
  const originalState = snapshot();
  assert.ok(changes(original).length); assert.ok(page.drawn.length); assert.ok(other(original).length);
  const state = enabled => listeners.get('message')({ data: { ...page.env, v: 1, type: 'state', requestId: 'setting',
    position: 1, count: 3, selected: focused, pins: [focused], highlightRedexContractum: enabled } });
  state(false); page.draw();
  assert.equal(page.state.highlightRedexContractum, false);
  assert.equal(changes(decorationCalls.at(-1).values).length, 0);
  assert.deepEqual(other(decorationCalls.at(-1).values), other(original));
  assert.deepEqual(snapshot(), originalState); assert.equal(page.projection, projection);
  state(true); page.draw();
  assert.deepEqual(decorationCalls.at(-1).values, original);
  assert.deepEqual(snapshot(), originalState);
});

test('remark snippets, errors and final terms have no change or frontier background', () => {
  for (const kind of ['remark', 'error', 'final']) {
    const pane = fakeMacroConnections('after'), a = fixtureAnswer({});
    if (kind === 'final') a.final.focus = [[1, 2]];
    else {
      a.steps[0].kind = kind; a.steps[0].after = null;
      if (kind === 'error') {
        a.steps[0].error = 'failure';
        a.diagnostics.failure = { message: 'failure', program: a.steps[0].before, syntax: [a.steps[0].before], contexts: [] };
      }
    }
    pane.render(project(a, kind === 'final' ? 3 : 1));
    assert.ok(pane.page.sections.length);
    assert.ok(pane.decorationCalls.at(-1).values.every(d => !/^macro-(before|after|frontier)$/.test(d.options.description)));
  }
});

test('transformer contexts retain Before focus on remarks, and obey the checkbox', () => {
  const pane = fakeMacroConnections('before'), a = fixtureAnswer({});
  a.steps[0].kind = 'remark'; a.steps[0].after = null;
  a.steps[0].contexts = [{ label: 'While executing macro transformer in:', section: a.steps[1].before }];
  pane.render(project(a, 1));
  const changes = () => pane.decorationCalls.at(-1).values.filter(d => d.options.description === 'macro-before');
  assert.equal(changes().length, a.steps[1].before.focus.length);
  pane.page.state.highlightRedexContractum = false; pane.page.updateDecorations();
  assert.equal(changes().length, 0);
});

test('schema-2 renamings decorate the exact Before and After ranges for every admitted kind', async () => {
  const local = 'Introduce scope for local bindings', block = 'Introduce scope for internal definition context';
  const resolve = 'Resolve variable (remove extra scopes)';
  // Independent printed offsets cover whole operands as well as identifiers.
  // Keep the schema-1 structural assertions in the companion Racket tests.
  const cases = [
    ['(lambda (x) x)', [
      [local, [[22, 25], [26, 27]]], [block, [[26, 27]]], [resolve, [[26, 27]]]
    ]],
    ["(case-lambda [(x) x] [() 'seed])", [
      [local, [[14, 17], [18, 19]]], [block, [[18, 19]]], [resolve, [[18, 19]]],
      [local, [[22, 24], [25, 30]]], [block, [[25, 30]]]
    ]],
    ['(let ([x 1]) x)', [
      [local, [[14, 17], [18, 19], [22, 23]], [[15, 16], [18, 19], [22, 23]]],
      [block, [[30, 31]]], [resolve, [[30, 31]]]
    ]],
    ["(letrec-syntaxes+values ([(m) (lambda (stx) (quote-syntax seed))]) ([(x) 'value]) x)", [
      [local, [[26, 29], [56, 90], [119, 122], [123, 129], [134, 135]],
        [[27, 28], [56, 90], [120, 121], [123, 129], [134, 135]]],
      [local, [[64, 69], [70, 89]]], [block, [[70, 89]]], [block, [[134, 135]]], [resolve, [[134, 135]]]
    ]],
    ["(module demo '#%kernel (#%module-begin (define-values (f) (lambda () (define-values (x) 'seed) x))))", [
      ['Introduce scope for module', [[25, 109]]], ['Introduce scope for module body', [[25, 109]]],
      [local, [[76, 78], [79, 104], [105, 106]]], [block, [[79, 104], [105, 106]]],
      ['Shift the self module-path-index', [[1, 7], [8, 12], [13, 22], [25, 110]], [[0, 111]]]
    ]]
  ];
  for (const [text, expected] of cases) {
    const snapshot = { sourceHash: 'b'.repeat(64), sourceVersion: 1 };
    const worker = createMacroSession(racket, helper, { ...request(text), schemaVersion: 2, session: true,
      snapshot, hiding: 'none', includeRenamingSteps: true });
    try {
      const summary = await worker.start();
      assert.equal(summary.failed, undefined);
      const steps = summary.steps.map((step, i) => ({ ...step, position: i + 1 }))
        .filter(step => /^(Introduce scope|Resolve variable|Shift the self)/.test(step.label));
      assert.deepEqual(steps.map(step => step.label), expected.map(([label]) => label));
      for (const [i, step] of steps.entries()) {
        const projection = await worker.request({ mode: 'position', snapshot, position: step.position, panes: true });
        for (const side of ['before', 'after']) {
          const ranges = expected[i][side === 'after' ? 2 : 1] || expected[i][1];
          const section = projection.record[side];
          assert.deepEqual(section.focus, ranges, `${text}: ${step.label} ${side} worker focus`);
          const pane = fakeMacroConnections(side), { page, listeners, decorationCalls } = pane;
          pane.render({ ...projection, tokenSections: {}, tokenStyles: [], themeName: 'renaming' });
          const backgrounds = () => decorationCalls.at(-1).values.filter(d => /^macro-(before|after|frontier)$/.test(d.options.description));
          const wanted = ranges.map(([start, end]) => {
            const a = page.editorModel.getPositionAt(start), b = page.editorModel.getPositionAt(end);
            return { range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column },
              options: { description: `macro-${side}`, inlineClassName: `macro-${side}`, stickiness: 1 } };
          });
          assert.deepEqual(backgrounds(), wanted, `${text}: ${step.label} ${side} visible backgrounds`);
          const state = enabled => listeners.get('message')({ data: { ...page.env, v: 1, type: 'state', requestId: 'setting',
            position: projection.position, count: projection.count, selected: null, pins: [], highlightRedexContractum: enabled } });
          state(false); assert.deepEqual(backgrounds(), []);
          state(true); assert.deepEqual(backgrounds(), wanted);
        }
      }
    } finally { await worker.stop(); }
  }
});
