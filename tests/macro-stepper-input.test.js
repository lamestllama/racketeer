// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper input behavior.
'use strict';
const { plain, root, tick } = require('./support/macro-common');
const test = require('./support/node-test');
const Model = require('../vscode/macro-view/model');
const assert = require('node:assert/strict');
const Editor = require('../vscode/macro-view/monaco');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Protocol = require('../vscode/macro-view/protocol');
const { fakeMacroPage, fakeMacroConnections, connectMacroDrive } = require('./support/macro-page');
const { project, fixtureAnswer, pair, fakeModel, message, envelope } = require('./support/macro-fixtures');
const { sentenceFixture } = require('./support/macro-sentence');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { pageScripts } = require('./support/macro-page-startup');

test('current term follows the editor cursor and selection start without term boxes', () => {
  for (const side of ['before', 'after']) {
    const pane = fakeMacroConnections(side), sent = [];
    pane.render(project(fixtureAnswer({}), 1));
    pane.page.send = (type, fields) => sent.push(plain({ type, ...fields }));
    const section = Model.sections(pane.page.projection)[0].section;
    assert.equal(typeof pane.handlers.onDidChangeCursorSelection, 'function', 'Monaco selection changes drive the current term');
    const select = (start, end, backwards = false) => {
      pane.editor.setSelection({ startLineNumber: 1, startColumn: start + 1,
        endLineNumber: 1, endColumn: end + 1, backwards });
      assert.deepEqual(sent.at(-1).textSelections, [[start, end]]);
      const expected = Model.hit(section, start);
      assert.deepEqual(sent.at(-1), { type: 'select', sectionId: expected ? section.id : null,
        occurrenceId: expected?.id || null, textSelections: [[start, end]] });
    };
    select(1, 1); // A click leaves an empty native selection.
    select(1, 4); // Dragging keeps the start term, even beyond its range.
    select(1, 4, true); // A backwards selection also uses its start.
    select(2, 4); // Whitespace belongs to the enclosing form.
    select(3, 4); // Word selection targets the identifier.
    select(5, 5); // No containing term at the exclusive program boundary.
    const ds = pane.page.editorModel.getAllDecorations();
    assert.ok(ds.every(d => !/macro-(?:identity|related|occurrence-focus)/.test(d.options.inlineClassName || '')));
    assert.equal(pane.created[0].options.occurrencesHighlight, 'off');
    assert.equal(pane.created[0].options.selectionHighlight, false);
  }
});

test('each pane disables native occurrence, selection and word matching', () => {
  for (const side of ['before', 'after']) {
    const pane = fakeMacroConnections(side);
    pane.render(sentenceFixture(side));
    const options = pane.created[0].options;
    assert.equal(options.occurrencesHighlight, 'off');
    assert.equal(options.selectionHighlight, false);
    assert.equal(options.wordBasedSuggestions, 'off');
  }
});

test('each pane observes only binding highlight decorations', () => {
  for (const side of ['before', 'after']) {
    const pane = fakeMacroConnections(side), p = sentenceFixture(side), section = p.record[side];
    const start = section.text.length;
    section.text += 'tmp\n';
    section.occurrences.push({ id: 'unrelated', syntaxId: 'unrelated', parentId: null,
      range: [start, start + 3], delimiterRanges: [], macroScopeGroup: 0, phase: 0 });
    p.terms.unrelated = { kind: 'identifier', name: 'tmp' };
    pane.render(p);
    pane.page.focusPair(pair(section.id, 'use'));
    const getDecorations = pane.page.editorModel.getAllDecorations;
    const ds = getDecorations();
    const expected = ds.filter(d => ['macro-word-highlight', 'macro-word-highlight-strong'].includes(d.options.className));
    assert.equal(expected.length, 4, 'The separate identifier with the same spelling has no binding highlight');
    pane.page.editorModel.getAllDecorations = () => [...ds,
      ...['macro-hover', 'macro-before', 'macro-binder', 'wordHighlight', 'wordHighlightStrong',
        'selectionHighlight', 'macro-word-highlight-extra'].map(className => ({ range: ds[0].range, options: { className } }))];
    const dom = pane.observe();
    assert.equal(dom.relatedCount, expected.length);
    assert.deepEqual(dom.occurrenceHighlights, plain(expected.map(d => ({ range: d.range, className: d.options.className }))));
    pane.page.editorModel.getAllDecorations = getDecorations;
    pane.page.focusPair(pair(section.id, 'unrelated'));
    assert.equal(pane.observe().relatedCount, 0, 'An identifier without binding edges has no occurrence highlights');
  }
});

test('binding occurrences follow edges, include sibling uses and exclude equal text or identity elsewhere', () => {
  const p = sentenceFixture(), section = p.record.before;
  // A repeated spelling and relation key alone cannot establish a connection.
  for (const term of Object.values(p.terms)) term.relations = { bound: 'same' };
  section.edges.push({ ...section.edges[0], id: 'duplicate' });
  const expected = ['binder', 'use', 'same-line', 'later'].map(id => pair(section.id, id));
  assert.deepEqual(Model.bindingOccurrences(p, pair(section.id, 'use')), expected);
  assert.deepEqual(Model.bindingOccurrences(p, pair(section.id, 'binder')), expected);
  assert.deepEqual(Model.bindingOccurrences(p, pair(section.id, 'unused')), []);
  assert.deepEqual(Model.bindingOccurrences(p, pair(section.id, 'missing')), []);
  const combined = Editor.compose(Model.sections(p));
  const ds = Editor.decorations(fakeModel(combined.text), combined.parts, { related: expected, syntaxId: 'binder', focused: expected });
  const byClass = cls => ds.filter(d => d.options.className === cls);
  assert.equal(byClass('macro-word-highlight-strong').length, 1);
  assert.equal(byClass('macro-word-highlight').length, 3);
  assert.ok(ds.every(d => !/macro-(?:identity|related|occurrence-focus)/.test(d.options.inlineClassName || '')));
});

test('native Copy preserves editor text selection and copies the current term at an empty cursor', () => {
  const pane = fakeMacroConnections('before'), { page, editor, documentListeners } = pane;
  pane.render(project(fixtureAnswer({}), 1));
  const { type, fn: copy, capture } = documentListeners.get('copy');
  assert.equal(type, 'copy'); assert.equal(capture, true);
  assert.ok(pageScripts().filter(([file]) => !/\/(model|geometry|protocol|monaco)\.js$/.test(file)).map(([, source]) => source).join('\n').includes("document.addEventListener('copy'"), 'Empty-cursor Copy has a native handler');
  const event = () => ({ clipboardData: { setData(type, text) { this[type] = text; } }, prevented: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} });
  editor.setPosition({ lineNumber: 1, column: 1 });
  let e = event(); copy(e);
  assert.equal(e.prevented, true); assert.equal(e.clipboardData['text/plain'], '(x x)');
  editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 });
  e = event(); copy(e); assert.equal(e.prevented, false, 'Monaco handles selected text without interference');
  editor.setPosition({ lineNumber: 1, column: 6 });
  e = event(); copy(e); assert.equal(e.prevented, false, 'No term at the caret leaves native Copy alone');
});

test('occurrence styles use theme word highlights and borders only in high contrast', () => {
  const css = fs.readFileSync(path.join(root, 'vscode/macro-view/view.css'), 'utf8');
  assert.doesNotMatch(css, /macro-(?:identity|related|occurrence-focus)\b/);
  for (const [cls, color] of [['macro-word-highlight', 'wordHighlight'], ['macro-word-highlight-strong', 'wordHighlightStrong']]) {
    assert.match(css, new RegExp(`\\.${cls} \\{ background: var\\(--vscode-editor-${color}Background\\); \\}`));
    for (const theme of ['vscode-high-contrast', 'vscode-high-contrast-light']) {
      assert.match(css, new RegExp(`\\.${theme} \\.monaco-editor \\.${cls}[^}]*border: 1px solid var\\(--vscode-editor-${color}Border\\)`));
    }
  }
});

test('text selection messages accept bounded offsets and reject malformed or out-of-model ranges', async t => {
  for (const ranges of [[[0, 2]], [[1, 1]], []]) {
    Protocol.validateAction(message('select', { ...pair(), textSelections: ranges }), envelope);
  }
  for (const ranges of [[[-1, 2]], [[2, 1]], [[0, 1.5]], [[0]], 'text', Array(257).fill([0, 1])]) {
    assert.throws(() => Protocol.validateAction(message('select', { ...pair(), textSelections: ranges }), envelope));
  }
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const panel = ui.panels[0];
  panel.send('select', { ...pair(), textSelections: [[0, 999]] }); await tick();
  assert.equal(panel.selection.selected, null);
  assert.match(panel.messages.at(-1).message, /Invalid text selection/);
});

test('Copy uses native text selections, including within the same current term, and otherwise the term', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const panel = ui.panels[0];
  for (const [textSelections, expected] of [[[[0, 4]], '(x x'], [[[0, 2]], '(x'], [[[1, 2], [3, 4]], 'x\nx'], [[[0, 0]], '(x x)']]) {
    panel.send('select', { ...pair('b1', 'root'), textSelections }); await tick();
    await ui.command('copyTerm');
    assert.equal(ui.clipboard.at(-1), expected);
  }
  panel.send('select', { sectionId: null, occurrenceId: null, textSelections: [[5, 6]] }); await tick();
  await ui.command('copyTerm'); assert.equal(ui.clipboard.at(-1), '\n');
  assert.equal(ui.contexts['racketdap.macroSteps.canCopy'], true);
});

test('capture takes step keys before Monaco and the host keeps F10 for the debugger', async () => {
  const ui = fakeStepper(); await opened(ui);
  const panel = ui.panels[0], sent = [], listeners = [];
  let textFocus = true, monacoKeys = 0;
  // A key travels through document capture, Monaco's target handler, then
  // document bubbling. Monaco consumes it before a bubbling handler can run.
  const monaco = { keydown(e) { monacoKeys++; e.preventDefault(); e.stopImmediatePropagation(); } };
  const { page, documentListeners } = fakeMacroPage();
  page.editor = { hasTextFocus: () => textFocus };
  page.state = { busy: false };
  page.send = (type, fields) => { sent.push({ type, ...fields }); panel.send(type, fields); };
  const listener = documentListeners.get('keydown');
  assert.equal(listener.type, 'keydown');
  listeners.push({ fn: listener.fn, capture: listener.capture === true });
  const key = async (key, extra = {}) => {
    let stopped = false, prevented = false;
    const e = { key, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; }, ...extra };
    for (const l of listeners.filter(l => l.capture)) { if (!stopped) l.fn(e); }
    const taken = stopped;
    if (!stopped) monaco.keydown(e);
    for (const l of listeners.filter(l => !l.capture)) { if (!stopped) l.fn(e); }
    await tick();
    return { taken, prevented };
  };
  for (const [name, modifiers, position] of [
    ['F10', {}, 2], ['ArrowLeft', { altKey: true }, 1], ['ArrowRight', { altKey: true }, 2]
  ]) {
    assert.deepEqual(await key(name, modifiers), { taken: true, prevented: true });
    assert.equal(panel.projection.position, position);
  }
  assert.equal(monacoKeys, 0, 'Monaco must not move its cursor for step keys');
  assert.deepEqual(plain(sent), [{ type: 'navigate', action: 'next', key: 'F10' },
    { type: 'navigate', action: 'previous' }, { type: 'navigate', action: 'next' }]);
  ui.debug.activeDebugSession = {};
  await key('F10'); assert.equal(panel.projection.position, 2);
  assert.deepEqual(ui.executed, ['workbench.action.debug.stepOver']);
  await key('ArrowLeft', { altKey: true }); assert.equal(panel.projection.position, 1);
  await ui.command('next'); assert.equal(panel.projection.position, 2, 'Title buttons still step during debugging');
  ui.debug.activeDebugSession = undefined;
  await key('F10'); assert.equal(panel.projection.position, 3);
  const count = sent.length;
  for (const [name, modifiers] of [['f', { ctrlKey: true }], ['ArrowRight', {}],
    ['F10', { shiftKey: true }], ['F10', { altKey: true }], ['ArrowLeft', { altKey: true, metaKey: true }]]) {
    assert.equal((await key(name, modifiers)).taken, false);
  }
  textFocus = false; assert.equal((await key('F10')).taken, false);
  assert.equal(sent.length, count);
  textFocus = true; page.state.busy = true;
  await key('ArrowLeft', { altKey: true }); assert.equal(sent.length, count);
  ui.debug.activeDebugSession = {};
  await key('F10'); assert.equal(ui.executed.length, 2, 'Debug stepping works while expansion is busy');
});

test('drive keys answer once across navigation, rendering and page replacement', async t => {
  const ui = fakeStepper({ timeoutMs: 500 }); await opened(ui);
  t.after(() => ui.dispose());
  await ui.command('next');
  const panel = ui.panels[0], replies = [], frames = [], listeners = {}, tasks = [];
  let handled = false, disposed = false, monacoKeys = 0;
  const pane = fakeMacroPage(), { page, documentListeners } = pane;
  assert.equal(documentListeners.get('keydown').capture, true);
  listeners.keydown = documentListeners.get('keydown').fn;
  listeners.pagehide = pane.listeners.get('pagehide');
  Object.assign(page, { env: { ...panel.env }, serial: 0, testEnabled: true, loading: false,
    state: { busy: false }, clientInstanceId: 'client', navigationSequence: 0,
    vscode: { postMessage(m) {
      if (m.type === 'testResult') {
        assert.equal(disposed, false);
        m.observation.handled = handled; replies.push(m);
      }
      panel.incoming.fire(m);
    } },
    editor: Object.assign(pane.editor, { dispose() { disposed = true; } }), tokenProvider: null,
    editorSurface: Object.assign(page.editorSurface, { dispatchEvent(e) {
      handled = false; listeners.keydown(e);
      // Fake Monaco consumes any key that reaches its target listener.
      if (!e.stopped) { monacoKeys++; e.preventDefault(); e.stopImmediatePropagation(); }
      handled = true;
    } }),
    requestAnimationFrame(fn) { frames.push(fn); }
  });
  pane.page.renderPosition({ ...panel.projection, pane: 'before' });
  page.KeyboardEvent = class { constructor(type, fields) { Object.assign(this, { type }, fields); }
    preventDefault() {} stopImmediatePropagation() { this.stopped = true; } };
  const post = panel.webview.postMessage;
  panel.webview.postMessage = async m => {
    await post(m);
    if (m.type === 'positionCommit' && m.payloadKind !== 'selection') page.projection = panel.projection;
    if (m.type === 'testDrive') tasks.push(page.testDrive(m));
  };
  for (const [key, altKey, position] of [['ArrowLeft', true, 1], ['F10', false, 2], ['ArrowRight', true, 3]]) {
    page.env = { ...panel.env };
    const revision = page.env.positionRevision, before = replies.length;
    const answer = ui.command('_drive', { type: 'key', key, altKey });
    await tick();
    assert.equal(panel.projection.position, position, 'The driven key navigated');
    assert.ok(panel.env.positionRevision > revision);
    // A render can update the page envelope before its deferred answer runs.
    if (key === 'ArrowRight') page.env = { ...panel.env };
    while (frames.length) { frames.shift()(); await tick(); }
    const result = await answer;
    assert.ok(result, `The navigating ${key} drive received its answer`);
    assert.equal(result.handled, true, 'The answer follows key handling');
    assert.equal(result.position, position);
    assert.equal(replies.length, before + 1);
  }
  assert.equal(monacoKeys, 0);
  page.env = { ...panel.env };
  const before = replies.length;
  const answers = [ui.command('_drive', { type: 'key', key: 'ArrowLeft', altKey: true }),
    ui.command('_drive', { type: 'observe' })];
  await tick();
  listeners.pagehide();
  assert.equal(disposed, true);
  assert.equal(replies.length, before + 2, 'Every pending drive answers before editor disposal');
  for (const answer of answers) assert.ok(await answer);
  // Resuming old continuations must not send another answer or inspect disposed editors.
  while (frames.length) { frames.shift()(); await tick(); }
  await Promise.all(tasks);
  assert.equal(replies.length, before + 2);
});

test('Escape and clicks outside the editor preserve the current term and leave native selection to Monaco', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const panel = ui.panels[0], source = pageScripts().filter(([file]) => !/\/(model|geometry|protocol|monaco)\.js$/.test(file)).map(([, source]) => source).join('\n');
  const { page, documentListeners } = fakeMacroPage();
  page.editor = { hasTextFocus: () => true }; page.state = {}; page.send = () => {};
  const listeners = { keydown: documentListeners.get('keydown').fn };
  panel.send('select', pair()); await tick();
  let taken = false;
  listeners.keydown({ key: 'Escape', preventDefault() { taken = true; }, stopImmediatePropagation() {} });
  assert.equal(taken, false, 'Monaco handles Escape');
  assert.doesNotMatch(source, /document\.addEventListener\('click'/);
  await ui.command('clearSelection');
  assert.equal(panel.messages.at(-1).type, 'collapseSelection');
  assert.deepEqual(plain(panel.selection.selected), pair());
});

test('current term uses the actual caret in empty space and is independent of pointer hit testing', () => {
  const pane = fakeMacroConnections('before'), sent = [];
  pane.render(project(fixtureAnswer({}), 1));
  pane.page.monaco.editor.MouseTargetType = { CONTENT_TEXT: 6, CONTENT_EMPTY: 7 };
  pane.page.send = (type, fields) => sent.push(plain({ type, ...fields }));
  const position = { lineNumber: 1, column: 3 };
  pane.editor.setPosition(position);
  assert.equal(sent.at(-1).occurrenceId, 'root', 'Whitespace resolves to its enclosing term');
  assert.equal(pane.page.atPointer({ type: 7, position }), null, 'Empty space supplies no hover boxes');
  pane.editor.setPosition({ lineNumber: 1, column: 6 });
  assert.equal(sent.at(-1).occurrenceId, null, 'The program end has no containing term');
});

test('source click targets belong to the driven pane and resolve to the requested occurrence', () => {
  const source = fs.readFileSync(path.join(root, 'tests/vscode-macro-stepper.js'), 'utf8');
  const page = vm.createContext({ Model });
  vm.runInContext(source.slice(source.indexOf('function appearances('), source.indexOf('function horizontalStep(')), page);
  const projection = project(fixtureAnswer({}), 1);
  projection.sources.main = { kind: 'untitled', value: 'untitled:source' };
  for (const term of Object.values(projection.terms)) term.source = { sourceId: 'main' };
  for (const { section } of Model.sections(projection)) {
    // A parent with source metadata starts at the same character as its child.
    section.occurrences[0].range = [1, 4]; section.occurrences[0].delimiterRanges = [];
  }
  for (const side of ['before', 'after']) {
    const p = { ...projection, pane: side }, section = Model.sections(p)[0].section;
    const chosen = page.sourceAppearance(p, [section.id], 'untitled:source');
    assert.deepEqual(plain(chosen.target), pair(section.id, 'root'));
    assert.equal(Model.clickOffset(section, chosen.occurrence), 2, 'A parent can own a character beyond its first child');
    section.occurrences[0].range = [1, 2];
    const clickable = page.sourceAppearance(p, [section.id], 'untitled:source');
    assert.deepEqual(plain(clickable.target), pair(section.id));
    assert.equal(Model.clickOffset(section, section.occurrences[0]), null, 'A fully covered wrapper has no unique character');
    assert.equal(page.sourceAppearance(p, ['missing'], 'untitled:source'), undefined);
  }
});

test('cursor and selection start drive all term actions in each pane', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  const document = await opened(ui);
  for (const [index, panel] of ui.panels.entries()) {
    const pane = connectMacroDrive(panel, index ? 'after' : 'before');
    panel.reveal();
    const section = Model.sections(panel.projection)[0].section;
    pane.editor.setSelection({ startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 5 }); await tick();
    assert.deepEqual(plain(panel.selection.selected), pair(section.id, 'r'));
    await ui.command('properties'); assert.equal((await ui.command('_observe')).propertiesVisible, true);
    await ui.command('tack'); assert.deepEqual(plain((await ui.command('_observe')).pins), [pair(section.id, 'r')]);
    await ui.command('copyTerm'); assert.equal(ui.clipboard.at(-1), 'x');
    await ui.command('definition');
    const binder = panel.messages.findLast(m => m.type === 'focusTarget').target;
    assert.deepEqual(plain(binder), pair(section.id, 'b'));
    pane.page.focusPair(binder); await tick();
    assert.deepEqual(plain(panel.selection.selected), pair(section.id, 'b'));
    let offered;
    ui.window.showQuickPick = async choices => { offered = choices; return choices.find(c => c.id === 'r'); };
    await ui.command('references');
    assert.deepEqual(plain(offered.map(c => c.id)), ['b', 'r']);
    const use = panel.messages.findLast(m => m.type === 'focusTarget').target;
    pane.page.focusPair(use); await tick();
    assert.deepEqual(plain(panel.selection.selected), pair(section.id, 'r'));
    // Moving the pointer alone cannot replace the cursor term for an action.
    pane.handlers.onMouseMove({ target: { position: pane.page.editorModel.getPositionAt(0) } });
    await ui.command('goToSource'); assert.equal(ui.window.activeTextEditor.document, document);
    const ds = pane.page.editorModel.getAllDecorations();
    assert.ok(ds.every(d => !/macro-(?:identity|related|occurrence-focus)/.test(d.options.inlineClassName || '')));
    assert.equal(ds.filter(d => d.options.className === 'macro-word-highlight-strong').length, 1);
    assert.equal(ds.filter(d => d.options.className === 'macro-word-highlight').length, 1);
  }
});

test('target drives reveal owned characters after a properties resize or scrolling before placing the pointer', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui);
  await ui.command('last');
  for (const [index, panel] of ui.panels.entries()) {
    const side = index === 0 ? 'before' : 'after', pane = connectMacroDrive(panel, side);
    const { page, editor, viewport, pointerNode } = pane;
    const section = Model.sections(page.projection)[0].section;
    const prefix = '\n'.repeat(40) + ' '.repeat(65);
    section.text = prefix + '(x x)\n'; section.focus = [];
    for (const o of section.occurrences) {
      o.range = o.range.map(n => n + prefix.length);
      o.delimiterRanges = o.delimiterRanges.map(r => r.map(n => n + prefix.length));
    }
    // A parent shares its start with a child and owns only its closing character.
    section.occurrences[0].range[0]++;
    section.occurrences[0].delimiterRanges[0] = [prefix.length + 1, prefix.length + 2];
    section.occurrences[1].range[1]++;
    pane.render(panel.projection);
    panel.reveal();
    await ui.command('properties');
    page.inspector.hidden = false;
    assert.equal((await ui.command('_observe')).propertiesVisible, true);
    for (const type of ['hover', 'select']) for (const hidden of ['panel', 'scroll', 'right edge']) {
      viewport.width = 860; editor.layout();
      editor.setScrollPosition({ scrollTop: 800, scrollLeft: 0 });
      if (hidden === 'panel') viewport.width = 260; // DOM resizes ahead of Monaco's automatic layout.
      if (hidden === 'scroll') editor.setScrollPosition({ scrollTop: 0, scrollLeft: 800 });
      if (hidden === 'right edge') { viewport.width = 612; editor.layout(); }
      const target = pair(section.id, 'root'), offset = Model.clickOffset(section, section.occurrences[0]);
      assert.equal(offset, prefix.length + 4, 'The pointer must use the parent’s closing character');
      const pos = page.editorModel.getPositionAt(offset), end = page.editorModel.getPositionAt(offset + 1);
      const initial = editor.getScrolledVisiblePosition(pos);
      assert.equal(page.document.elementFromPoint(initial.left + 4, initial.top + 10), null, `${side} ${hidden}: initially hidden`);
      const hit = editor.getTargetAtClientPoint, dispatch = pointerNode.dispatchEvent;
      let hits = 0, pointers = 0;
      editor.getTargetAtClientPoint = (x, y) => {
        hits++;
        const start = editor.getScrolledVisiblePosition(pos), finish = editor.getScrolledVisiblePosition(end);
        assert.ok(start.top >= 0 && start.top + start.height <= viewport.height - 10, 'The target line is visible before the hit check');
        assert.ok(start.left >= 40 && finish.left <= viewport.width - 20, 'The owned character is clear of the properties panel and scrollbar');
        assert.ok(x > start.left && x < finish.left, 'The point lies inside the owned character');
        return hit(x, y);
      };
      pointerNode.dispatchEvent = e => { pointers++; dispatch(e); };
      const result = await ui.command('_drive', { type, target });
      editor.getTargetAtClientPoint = hit; pointerNode.dispatchEvent = dispatch;
      assert.equal(result.driveError, undefined, `${side} ${type} ${hidden}: ${result.driveError}`);
      assert.equal(hits, 1); assert.ok(pointers > 0);
      assert.equal(result.propertiesVisible, true, 'Revealing syntax keeps the properties panel open');
      if (type === 'hover') assert.deepEqual(plain(page.hover), target);
      else assert.deepEqual(plain(result.selected), target);
    }
    let pointers = 0;
    pointerNode.dispatchEvent = () => { pointers++; };
    editor.getTargetAtClientPoint = () => ({ position: page.editorModel.getPositionAt(prefix.length + 1) });
    const result = await ui.command('_drive', { type: 'hover', target: pair(section.id, 'root') });
    const facts = JSON.parse(result.driveError);
    assert.equal(facts.message, 'Pointer does not hit the requested occurrence');
    assert.deepEqual(facts.target, { ...pair(section.id, 'root'), text: section.text.slice(...section.occurrences[0].range),
      range: section.occurrences[0].range });
    assert.deepEqual(facts.pane, { side, visible: true, active: true, documentVisible: true, focused: true, editorTextFocused: true });
    const offset = Model.clickOffset(section, section.occurrences[0]);
    const position = page.editorModel.getPositionAt(offset), end = page.editorModel.getPositionAt(offset + 1);
    assert.equal(facts.character.text, ')'); assert.equal(facts.character.offset, offset);
    assert.deepEqual(facts.character.position, plain(position)); assert.deepEqual(facts.character.endPosition, plain(end));
    const startBox = editor.getScrolledVisiblePosition(position), endBox = editor.getScrolledVisiblePosition(end);
    assert.deepEqual(facts.character.scrolledVisiblePosition, plain(startBox));
    assert.deepEqual(facts.character.endScrolledVisiblePosition, plain(endBox));
    assert.deepEqual(facts.character.clientRect, { left: startBox.left, top: startBox.top, right: endBox.left,
      bottom: startBox.top + startBox.height, width: endBox.left - startBox.left, height: startBox.height });
    assert.deepEqual(facts.pointer, { clientX: startBox.left + (endBox.left - startBox.left) / 4, clientY: startBox.top + startBox.height / 2 });
    assert.deepEqual(facts.editor.visibleRanges, plain(editor.getVisibleRanges()));
    assert.equal(facts.editor.scrollTop, editor.getScrollTop()); assert.equal(facts.editor.scrollLeft, editor.getScrollLeft());
    assert.deepEqual(facts.propertiesPanel, { visible: true, rect: plain(page.inspector.getBoundingClientRect()) });
    assert.deepEqual(facts.elementFromPoint, { tag: 'SPAN', classes: 'mtk1', inEditorSurface: true, occurrence: pair(section.id, 'b') });
    assert.deepEqual(facts.hitTest, { type: null, position: plain(page.editorModel.getPositionAt(prefix.length + 1)),
      range: null, mouseColumn: null, occurrence: pair(section.id, 'b') });
    assert.equal(pointers, 0, 'A wrong hit still rejects the drive before any pointer event');
  }
});

test('clicks replace an existing occurrence selection, including a parent at its own closing character', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui);
  const panel = ui.panels[0], pane = connectMacroDrive(panel, 'before');
  const { editor, pointerNode } = pane;
  const section = Model.sections(panel.projection)[0].section;
  // The parent starts alongside a child and owns only the closing delimiter.
  // Retain the parent's overlapping delimiter metadata to check innermost hits.
  section.occurrences[0].range = [1, 5];
  section.occurrences[0].delimiterRanges = [[1, 2], [4, 5]];
  section.occurrences[1].range = [1, 3];
  pane.render(panel.projection);
  const select = async occurrenceId => {
    const target = pair(section.id, occurrenceId);
    const result = await ui.command('_drive', { type: 'select', target });
    assert.equal(result.driveError, undefined, result.driveError);
    assert.deepEqual(plain(result.selected), target);
    assert.deepEqual(plain(panel.selection.selected), target, 'The host replaces its previous selection');
  };
  await select('b');
  editor.setScrollPosition({ scrollTop: 500, scrollLeft: 200 });
  await select('r');
  // A click remains a syntax selection when Monaco has selected text (for
  // example after a repeated click). It must not preserve the previous term.
  await select('root');
  assert.equal(Model.clickOffset(section, section.occurrences[0]), 4);
  editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
  for (const offset of [1, 2, 3, 4]) {
    for (const fraction of [.25, .75]) {
      pointerNode.dispatchEvent({ type: 'mousedown', clientX: 40 + (offset + fraction) * 8, clientY: 10 });
      await tick();
      assert.deepEqual(plain(panel.selection.selected), Model.hit(section, Math.round(offset + fraction)) ? pair(section.id, Model.hit(section, Math.round(offset + fraction)).id) : null,
        `The caret nearest character ${offset}, fraction ${fraction} determines the current term`);
    }
  }
});

test('target drives reach the other pane and keep selection and source actions there', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  const document = await opened(ui), received = [];
  for (const [index, panel] of ui.panels.entries()) connectMacroDrive(panel, index === 0 ? 'before' : 'after', received);
  // Give the destination a different revision: its reply must use its own envelope.
  ui.panels[1].incoming.fire({ v: 1, type: 'ready', clientInstanceId: 'replacement' }); await tick();
  assert.notEqual(ui.panels[0].env.positionRevision, ui.panels[1].env.positionRevision);
  for (const position of [1, 2, 3]) {
    await ui.command('jump', position);
    for (const pane of ui.panels) {
      const other = ui.panels.find(p => p !== pane);
      const sectionId = Model.sections(pane.projection)[0].section.id, target = pair(sectionId);
      const previous = plain(other.selection.selected);
      other.reveal();
      assert.equal(Model.find(other.projection, target), null, 'The active pane does not display the target');
      for (const type of ['select', 'hover']) {
        other.reveal();
        const result = await ui.command('_drive', { type, target }); await tick();
        assert.ok(result, 'The destination answers the drive');
        assert.equal(received.at(-1).panel === pane, true, 'The target pane receives the drive');
        if (type === 'hover') assert.ok(result.boxes.some(box => box.sectionId === target.sectionId && box.occurrenceId === target.occurrenceId), JSON.stringify(result));
        else assert.deepEqual(plain(result.selected), target);
        assert.equal(pane.active, true, 'Following commands address the destination');
      }
      assert.deepEqual(plain(pane.selection.selected), target);
      assert.deepEqual(plain(other.selection.selected), previous, 'The other pane retains its selection');
      assert.deepEqual(plain((await ui.command('_observe')).selection), target);
      await ui.command('copyTerm'); assert.equal(ui.clipboard.at(-1), 'x');
      await ui.command('goToSource'); assert.equal(ui.window.activeTextEditor.document, document);
      assert.equal(ui.follows.at(-1).options.preserveFocus, false, 'Go to source focuses the buffer');
      pane.reveal();
      await ui.command('_drive', { type: 'observe' }); assert.equal(received.at(-1).panel, pane);
    }
  }
  // With no rewrites both panes display the same section; keep the active one.
  const refresh = ui.command('refresh'); await tick(); ui.answer(ui.pending.at(-1), a => { a.steps = []; }); await refresh;
  for (const pane of ui.panels) {
    pane.reveal();
    assert.deepEqual(plain((await ui.command('_drive', { type: 'select', target: pair('final') })).selected), pair('final'));
    assert.equal(received.at(-1).panel, pane, 'Shared sections stay in the active pane');
  }
  assert.equal(await ui.command('_drive', { type: 'select', target: pair('missing') }), null);
});

test('page reveal drives reach the focus through the input module interface', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const panel = ui.panels[0], pane = connectMacroDrive(panel, 'before'), positions = [];
  pane.editor.revealPositionInCenterIfOutsideViewport = position => positions.push(plain(position));
  const result = await ui.command('_drive', { type: 'revealBeforeFocus' });
  assert.equal(result.driveError, undefined);
  assert.deepEqual(positions, [{ lineNumber: 1, column: 2 }]);
});
