// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tick, plain } = require('./support/macro-common');
const { fixtureAnswer, project, pair, fakeModel } = require('./support/macro-fixtures');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { fakeMacroPage } = require('./support/macro-page');
const Editor = require('../vscode/macro-view/monaco');
const Model = require('../vscode/macro-view/model');
const Protocol = require('../vscode/macro-view/protocol');

const kinds = ['armed', 'disarmed', 'tainted'];
const glyphs = { codicons: ['\uea75', '\ueb74', '\uea86'], unicode: ['🔒', '🔓', '💥'] };
function markFixture(answer) {
  for (const s of [...answer.steps.flatMap(s => [s.before, s.after]), answer.final]) {
    s.occurrences.forEach((o, i) => { o.taint = kinds[i % 3]; o.taintCount = 1; });
  }
  return answer;
}
function marks(decorations) { return decorations.filter(d => d.options.description === 'macro-taint'); }

test('all three classifications are anchored at exact occurrence starts in every display and setting', () => {
  const a = markFixture(fixtureAnswer({})), p = project(a, 1);
  const context = { ...p.record.before, id: 'context' };
  p.record.commonContext = context;
  p.record.contexts = [{ label: 'While executing macro transformer in:', section: { ...context, id: 'transformer' } }];
  const projections = [p, { ...p, record: { ...p.record, kind: 'remark', after: null, commonContext: undefined } },
    { ...p, record: null, final: a.final },
    { ...p, record: null, error: 'error', diagnostics: { error: { message: 'literal 💥', program: context,
      syntax: [{ ...context, id: 'error-syntax' }], contexts: p.record.contexts } } }];
  for (const p of projections) for (const pane of ['before', 'after']) {
    const combined = Editor.compose(Model.sections({ ...p, pane })), model = fakeModel(combined.text);
    for (const taintIcons of ['codicons', 'unicode', 'none']) {
      const ds = marks(Editor.decorations(model, combined.parts, { taintIcons }));
      const expected = taintIcons === 'none' ? [] : combined.parts.flatMap(part => part.section.occurrences.map(o => {
        const start = model.getPositionAt(part.offset(o.range[0]));
        return { range: { startLineNumber: start.lineNumber, startColumn: start.column,
          endLineNumber: start.lineNumber, endColumn: start.column }, content: glyphs[taintIcons][kinds.indexOf(o.taint)],
          cls: `macro-taint macro-taint-${o.taint}${taintIcons === 'codicons' ? ' macro-taint-codicon' : ''}` };
      }));
      assert.deepEqual(ds.map(d => ({ range: d.range, content: d.options.before.content, cls: d.options.before.inlineClassName })), expected);
      assert.ok(ds.every(d => d.options.before.cursorStops === 1 && d.options.before.inlineClassNameAffectsLetterSpacing));
      assert.equal(model.getValue(), combined.text);
    }
  }
  const ordinary = project(fixtureAnswer({}), 1);
  const combined = Editor.compose(Model.sections(ordinary));
  assert.deepEqual(marks(Editor.decorations(fakeModel(combined.text), combined.parts)), []);
  const defaults = Editor.compose(Model.sections(p));
  assert.equal(marks(Editor.decorations(fakeModel(defaults.text), defaults.parts))[0].options.before.content, glyphs.codicons[0]);
});

test('protocol rejects malformed mark metadata and keeps ordinary occurrences compatible', () => {
  const state = { v: 1, type: 'state', sessionId: 'session', generation: 1, positionRevision: 1,
    requestId: 'setting', position: 1, count: 1, selected: null, pins: [] };
  for (const taintIcons of ['codicons', 'unicode', 'none']) assert.doesNotThrow(() => Protocol.validateHost({ ...state, taintIcons }));
  for (const taintIcons of [false, null, 'snips', 1]) assert.throws(() => Protocol.validateHost({ ...state, taintIcons }), /state/);
  const a = fixtureAnswer({}), section = a.steps[0].before;
  assert.doesNotThrow(() => Model.validateSection(section, a.terms));
  for (const fields of [{ taint: 'unarmed', taintCount: 1 }, { taint: 'tainted' },
    { taint: 'armed', taintCount: 0 }, { taint: 'disarmed', taintCount: 1.5 }, { taintCount: 1 }]) {
    const copy = structuredClone(section); Object.assign(copy.occurrences[0], fields);
    assert.throws(() => Model.validateSection(copy, a.terms), /taint/);
  }
  const copy = structuredClone(section); Object.assign(copy.occurrences[0], { taint: 'tainted', taintCount: 3 });
  assert.doesNotThrow(() => Model.validateSection(copy, a.terms));
  const combined = Editor.compose([{ section: copy }]);
  assert.equal(marks(Editor.decorations(fakeModel(combined.text), combined.parts))[0].options.before.content, '\uea86'.repeat(3));
});

test('shipped page state changes only decorations, retaining model, selection, line numbers, suffixes and copying', () => {
  const a = markFixture(fixtureAnswer({})), p = project(a, 1);
  const ui = fakeMacroPage('before'); const { page, editor, models, edits, listeners, options } = ui;
  page.renderPosition({ ...p, pane: 'before', tokenSections: {}, tokenStyles: [], themeName: 'test' });
  editor.setSelection({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 });
  const model = page.editorModel, text = model.getValue(), selection = plain(editor.getSelection());
  const lineNumbers = Array.from({ length: model.getLineCount() }, (_, i) => options.lineNumbers(i + 1));
  const copied = Model.copy(p, pair('b1', 'b'));
  const editCount = edits.length, modelCount = models.length;
  const properties = { builtins: { tamperStatus: 'unarmed' } };
  page.selected.properties = properties;
  for (const mode of ['none', 'unicode', 'codicons']) {
    listeners.get('message')({ data: { v: 1, type: 'state', ...page.env, requestId: 'setting', position: 1, count: 3, selected: null, pins: [], taintIcons: mode } });
    assert.equal(page.state.taintIcons, mode);
    const decorated = marks(model.getAllDecorations());
    assert.equal(decorated.length, mode === 'none' ? 0 : p.record.before.occurrences.length);
    if (decorated.length) assert.equal(decorated[0].options.before.content, glyphs[mode][0]);
    assert.equal(page.editorModel, model);
    assert.equal(model.getValue(), text);
    assert.deepEqual(plain(editor.getSelection()), selection);
    assert.equal(Model.copy(p, pair('b1', 'b')), copied);
    assert.deepEqual(Array.from({ length: model.getLineCount() }, (_, i) => options.lineNumbers(i + 1)), lineNumbers);
    assert.equal(edits.length, editCount); assert.equal(models.length, modelCount);
    assert.equal(page.selected.properties, properties);
  }
});

for (const mode of ['codicons', 'unicode', 'none']) test(`remembered ${mode} choice reaches every open pane without expansion or selection changes`, async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui, 'first'); await opened(ui, 'second');
  const before = ui.panels[0]; before.reveal();
  before.send('select', { ...pair('b1', 'b'), textSelections: [[1, 4]] }); await tick();
  await ui.command('copyTerm'); const copied = ui.clipboard.at(-1);
  const projections = ui.panels.map(p => p.projection);
  const pending = ui.pending.length, queries = ui.pending.map(p => p.queries.length);
  let seen;
  ui.window.showQuickPick = async (items, options) => {
    seen = { items: plain(items), options: plain(options) };
    return items.find(i => i.value === mode);
  };
  await ui.command('taintIcons'); await tick();
  assert.equal(seen.options.title, 'Taint Icons');
  assert.deepEqual(seen.items.map(i => [i.label, i.value]), [['Codicons', 'codicons'], ['Unicode', 'unicode'], ['Do not show', 'none']]);
  assert.equal(seen.items[0].picked, true);
  assert.deepEqual(ui.settingUpdates.at(-1), { key: 'racketdap.macroSteps.taintIcons', value: mode, target: 1 });
  for (const [i, pane] of ui.panels.entries()) {
    assert.equal(pane.messages.filter(m => m.type === 'state').at(-1).taintIcons, mode);
    assert.equal(pane.projection, projections[i]);
  }
  await ui.command('copyTerm'); assert.equal(ui.clipboard.at(-1), copied);
  assert.deepEqual(plain(before.selection.selected), pair('b1', 'b'));
  assert.equal(ui.pending.length, pending);
  assert.deepEqual(ui.pending.map(p => p.queries.length), queries);
  await opened(ui, 'third');
  for (const pane of ui.panels.slice(-2)) assert.equal(pane.messages.filter(m => m.type === 'state').at(-1).taintIcons, mode);
  // A fresh extension instance reads the same stored value.
  const restarted = fakeStepper(); t.after(() => restarted.dispose());
  restarted.setSetting('racketdap.macroSteps.taintIcons', ui.settings.get('racketdap.macroSteps.taintIcons'));
  await opened(restarted, 'restored');
  for (const pane of restarted.panels) assert.equal(pane.messages.filter(m => m.type === 'state').at(-1).taintIcons, mode);
});

test('settings editor updates and cancelled picker preserve their expected state', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  ui.setSetting('racketdap.macroSteps.taintIcons', 'unicode'); await tick();
  for (const pane of ui.panels) assert.equal(pane.messages.filter(m => m.type === 'state').at(-1).taintIcons, 'unicode');
  ui.window.showQuickPick = async () => undefined;
  await ui.command('taintIcons');
  assert.equal(ui.settingUpdates.length, 0);
});

test('manifest exposes remembered choices alongside pane options and Codicons use theme variables', () => {
  const c = require('../vscode/package.json').contributes, command = 'racketdap.macroSteps.taintIcons';
  assert.equal(c.commands.find(c => c.command === command).title, 'Taint Icons');
  assert.deepEqual(c.configuration.properties[command].enum, ['codicons', 'unicode', 'none']);
  assert.equal(c.configuration.properties[command].default, 'codicons');
  assert.equal(c.menus['editor/title'].find(c => c.command === command).group, '4_macroOptions@7');
  assert.ok(c.menus.commandPalette.some(c => c.command === command && c.when !== 'false'));
  const css = fs.readFileSync(require.resolve('../vscode/macro-view/view.css'), 'utf8');
  for (const [kind, color] of [['armed', 'yellow'], ['disarmed', 'green'], ['tainted', 'red']]) {
    assert.match(css, new RegExp(`\\.macro-taint-${kind}\\s*\\{[^}]*color:\\s*var\\(--vscode-charts-${color}\\)`));
  }
  assert.match(css, /\.macro-taint-codicon\s*\{[^}]*font-family:\s*codicon/);
  assert.match(css, /\.macro-taint\s*\{[^}]*user-select:\s*none/);
  const library = fs.readFileSync(require.resolve('../vscode/node_modules/monaco-editor/esm/vs/base/common/codiconsLibrary.js'), 'utf8');
  for (const [i, name] of ['lock', 'unlock', 'zap'].entries()) {
    assert.match(library, new RegExp(`${name}: register\\('${name}', 0x${glyphs.codicons[i].charCodeAt(0).toString(16)}\\)`));
  }
});
