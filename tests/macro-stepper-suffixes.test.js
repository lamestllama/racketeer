// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks window-local suffix controls and selection-preserving redraws.
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { tick, plain, root } = require('./support/macro-common');
const { fakeMacroPage } = require('./support/macro-page');
const { fixtureAnswer, project, pair } = require('./support/macro-fixtures');
const Protocol = require('../vscode/macro-view/protocol');
const { createMacroProcess } = require('../vscode/macro-process');
const { decodeTerm } = require('../vscode/macro-stepper-codec');

function commitPosition({ page, listeners, messages }, frames, value) {
  const encoded = Protocol.chunks(value), transferId = `redraw${messages.length}`;
  const host = (type, fields) => listeners.get('message')({ data: { ...page.env, v: 1, type, requestId: transferId, ...fields } });
  host('positionBegin', { transferId, payloadKind: 'position', totalBytes: encoded.totalBytes, chunkCount: encoded.chunks.length });
  encoded.chunks.forEach((chunk, sequence) => host('positionChunk', { transferId, sequence, chunk }));
  host('positionCommit', { transferId, totalBytes: encoded.totalBytes });
  while (frames.length) frames.shift()();
  assert.ok(messages.some(m => m.type === 'rendered' && m.transferId === transferId), page.live.textContent);
}

test('suffix checkbox redraws both panes without an expansion, reset, or saved setting', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const worker = ui.pending[0], [before, after] = ui.panels;
  assert.equal(ui.contexts['racketdap.macroSteps.alwaysSuffixMarkedIdentifiers'], false);
  before.send('select', { ...pair('b1', 'b') }); await tick();
  const selection = before.selection.selected, position = before.projection.position;
  await ui.command('alwaysSuffixMarkedIdentifiers');
  assert.equal(ui.contexts['racketdap.macroSteps.alwaysSuffixMarkedIdentifiers'], true);
  assert.equal(before.projection.position, position); assert.equal(after.projection.position, position);
  assert.deepEqual(before.selection.selected, selection);
  assert.equal(before.projection.preserveSelection, true);
  assert.equal(after.projection.preserveSelection, true);
  assert.equal(worker.queries.at(-1).suffixOption, 'always');
  await ui.command('alwaysSuffixMarkedIdentifiers');
  assert.equal(worker.queries.filter(q => q.mode === 'position').at(-1).suffixOption, 'over-limit');
  assert.ok(worker.queries.every(q => !['configure', 'reexpand'].includes(q.mode)));
  assert.equal(ui.pending.length, 1); assert.equal(ui.settings.size, 0);
  await ui.command('alwaysSuffixMarkedIdentifiers');
  await opened(ui, 'independent');
  assert.equal(ui.contexts['racketdap.macroSteps.alwaysSuffixMarkedIdentifiers'], false);
  before.reveal();
  assert.equal(ui.contexts['racketdap.macroSteps.alwaysSuffixMarkedIdentifiers'], true);
});

test('a suffix redraw retains selection, scope numbers, pins, and the existing editor', () => {
  const { page, editor, created } = fakeMacroPage('before');
  const p = { ...project(fixtureAnswer({}), 1), pane: 'before' };
  page.renderPosition(p);
  const focused = pair('b1', 'b'), selected = { selected: focused, related: [pair('b1', 'r')], syntaxId: 'x', properties: null };
  page.focused = focused; page.hover = focused; page.selected = selected;
  page.state.pins = [focused];
  const groups = p.record.before.occurrences.map(o => o.macroScopeGroup);
  editor.setScrollPosition({ scrollTop: 80, scrollLeft: 32 });
  page.renderPosition({ ...p, preserveSelection: true });
  assert.deepEqual(plain(page.focused), focused); assert.deepEqual(plain(page.selected), selected);
  assert.deepEqual(plain(page.state.pins), [focused]);
  assert.deepEqual(plain(page.projection.record.before.occurrences.map(o => o.macroScopeGroup)), groups);
  assert.equal(editor.getScrollTop(), 80); assert.equal(editor.getScrollLeft(), 32);
  assert.equal(created.length, 1);
});

for (const side of ['before', 'after']) for (const selection of [false, true]) {
  test(`${side}: suffix insertion and removal keep the second occurrence through position commit (${selection ? 'selection' : 'caret'})`, () => {
    const frames = [];
    const pane = fakeMacroPage(side, { globals: { requestAnimationFrame: fn => { frames.push(fn); return frames.length; } } });
    const { page, editor } = pane;
    const commit = value => commitPosition(pane, frames, value);
    const projection = always => {
      const a = fixtureAnswer({});
      for (const step of a.steps) for (const section of [step.before, step.after]) {
        section.text = always ? '(x:1 x:1)\n' : '(x x)\n';
        section.occurrences[0].range = [0, always ? 9 : 5];
        section.occurrences[0].delimiterRanges = [[0, 1], [always ? 8 : 4, always ? 9 : 5]];
        section.occurrences[2].range = [always ? 5 : 3, always ? 6 : 4];
        section.focus = [section.occurrences[1].range, section.occurrences[2].range];
        for (const o of section.occurrences.slice(1)) o.macroScopeGroup = 1;
      }
      return { ...project(a, 1), pane: side, preserveSelection: true };
    };
    commit(projection(false));
    const sectionId = side === 'before' ? 'b1' : 'a1', target = pair(sectionId, 'r');
    page.focusPair(target);
    if (selection) {
      const part = page.partsBySection.get(sectionId);
      editor.setSelection(page.E.range(page.editorModel, part, [3, 4]));
    }
    const a = fixtureAnswer({});
    page.selected.properties = decodeTerm(a.shared, a.terms.x);
    const selected = plain(page.selected);
    page.state.pins = [target];
    editor.setScrollPosition({ scrollTop: 80, scrollLeft: 32 });
    for (const always of [true, false]) {
      commit(projection(always));
      assert.deepEqual(plain(page.focused), target);
      assert.deepEqual(plain(page.selected), selected);
      assert.deepEqual(plain(page.state.pins), [target]);
      const part = page.partsBySection.get(sectionId), range = always ? [5, 6] : [3, 4];
      const expected = page.E.range(page.editorModel, part, range);
      assert.deepEqual(plain(editor.getSelection().getStartPosition()), { lineNumber: expected.startLineNumber, column: expected.startColumn });
      assert.equal(editor.getSelection().isEmpty(), !selection);
      if (selection) assert.deepEqual(plain(editor.getSelection().getEndPosition()), { lineNumber: expected.endLineNumber, column: expected.endColumn });
      assert.equal(editor.getScrollTop(), 80); assert.equal(editor.getScrollLeft(), 32);
    }
    assert.equal(pane.created.length, 1);
  });
}

for (const side of ['before', 'after']) for (const initialSuffix of [false, true]) {
  for (const kind of ['partial first name', 'partial last name', 'several occurrences', 'after suffixes']) {
    test(`${side}: ${initialSuffix ? 'removing' : 'inserting'} suffixes preserves ${kind} through position commit`, () => {
      const frames = [];
      const pane = fakeMacroPage(side, { globals: { requestAnimationFrame: fn => { frames.push(fn); return frames.length; } } });
      const { page, editor } = pane, sectionId = side === 'before' ? 'b1' : 'a1';
      const projection = suffixed => {
        const a = fixtureAnswer({}), names = ['longname', 'middle', 'tailname'];
        for (const step of a.steps) for (const section of [step.before, step.after]) {
          section.text = `(${names.map(name => name + (suffixed ? ':1' : '')).join(' ')})\n`;
          section.occurrences.push({ ...section.occurrences[2], id: 'last' });
          const root = section.occurrences[0], end = section.text.length - 1;
          root.range = [0, end]; root.delimiterRanges = [[0, 1], [end - 1, end]];
          let offset = 1;
          names.forEach((name, i) => {
            const o = section.occurrences[i + 1];
            o.range = [offset, offset + name.length];
            o.colorRange = [offset, offset + name.length + (suffixed ? 2 : 0)];
            o.macroScopeGroup = 1;
            offset = o.colorRange[1] + 1;
          });
          section.focus = section.occurrences.slice(1).map(o => o.range);
        }
        return { ...project(a, 1), pane: side, preserveSelection: true };
      };
      const selectedRange = () => {
        const [first, middle, last] = page.partsBySection.get(sectionId).section.occurrences.slice(1);
        if (kind === 'partial first name') return [first.range[0], first.range[0] + 4];
        if (kind === 'partial last name') return [last.range[0], last.range[0] + 4];
        if (kind === 'several occurrences') return [first.range[0] + 4, last.range[0] + 4];
        return [middle.colorRange[1], last.colorRange[1] + 1];
      };
      const range = () => page.E.range(page.editorModel, page.partsBySection.get(sectionId), selectedRange());
      const selectedText = suffixed => {
        if (kind === 'partial first name') return 'long';
        if (kind === 'partial last name') return 'tail';
        if (kind === 'several occurrences') return suffixed ? 'name:1 middle:1 tail' : 'name middle tail';
        return suffixed ? ' tailname:1)' : ' tailname)';
      };
      commitPosition(pane, frames, projection(initialSuffix));
      editor.setSelection(range());
      assert.equal(page.editorModel.getValueInRange(editor.getSelection()), selectedText(initialSuffix));
      for (const suffixed of [!initialSuffix, initialSuffix]) {
        commitPosition(pane, frames, projection(suffixed));
        const expected = range(), actual = editor.getSelection();
        assert.deepEqual(plain(actual.getStartPosition()), { lineNumber: expected.startLineNumber, column: expected.startColumn });
        assert.deepEqual(plain(actual.getEndPosition()), { lineNumber: expected.endLineNumber, column: expected.endColumn });
        assert.equal(page.editorModel.getValueInRange(actual), selectedText(suffixed));
      }
    });
  }
}

test('suffix redraw preserves actual group numbers after worker replacement and nonsequential display', async t => {
  const workers = [];
  const ui = fakeStepper({ workerFactory(command, helper, input, handlers) {
    const worker = createMacroProcess(command, helper, { ...input, cwd: root, directory: root }, handlers);
    workers.push(worker); return worker;
  } });
  t.after(() => ui.dispose());
  const document = await ui.source('suffix-history');
  document.text = '#lang racket/base\n' +
    '(define-syntax-rule (one) (two))\n' +
    '(define-syntax-rule (two) (three))\n' +
    '(define-syntax-rule (three) (four))\n' +
    '(define-syntax-rule (four) (quote done))\n(one)\n';
  await ui.open(true);
  const after = ui.panels[1], before = ui.panels[0];
  const numbers = new Map();
  const displayed = () => [before, after].map(p => {
    const section = p === before ? p.projection.record.before : p.projection.record.after;
    return { text: section.text, groups: section.occurrences.map(o => o.macroScopeGroup) };
  });
  // First encounter is deliberately different from expansion order.
  for (const position of [4, 2, 3, 1]) {
    await ui.command('jump', position);
    numbers.set(position, displayed().map(s => s.groups));
  }
  assert.equal(new Set([...numbers.values()].flat(2).filter(n => n > 0)).size, 4);
  await ui.command('alwaysSuffixMarkedIdentifiers');
  const suffixed = new Map();
  for (const position of [1, 2, 3, 4]) {
    await ui.command('jump', position);
    const value = displayed();
    assert.deepEqual(value.map(s => s.groups), numbers.get(position));
    assert.match(value[1].text, /:[1-9][0-9]*/);
    const name = ['two', 'three', 'four', 'done'][position - 1];
    const section = after.projection.record.after;
    const occurrence = section.occurrences.find(o => section.text.slice(...o.range) === name && o.macroScopeGroup > 0);
    assert.equal(occurrence.macroScopeGroup, [1, 4, 2, 3][position - 1]);
    suffixed.set(position, value);
  }
  assert.equal(workers.length, 1);
  await workers[0].stop();
  // An uncached final position reconstructs the worker and replays history.
  await ui.command('last');
  assert.equal(workers.length, 2);
  await ui.command('alwaysSuffixMarkedIdentifiers');
  await ui.command('alwaysSuffixMarkedIdentifiers');
  for (const position of [1, 2, 3, 4]) {
    await ui.command('jump', position);
    assert.deepEqual(displayed(), suffixed.get(position));
  }
});
