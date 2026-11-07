// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper view model behavior.
'use strict';
const { root, plain, tick } = require('./support/macro-common');
const test = require('./support/node-test');
const Editor = require('../vscode/macro-view/monaco');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Model = require('../vscode/macro-view/model');
const Data = require('../vscode/macro-view-data');
const { decodeTerm } = require('../vscode/macro-stepper-codec');
const { project, fixtureAnswer, pair, summaryOf, fakeModel } = require('./support/macro-fixtures');
const { fakeTimers, fakeStepper, opened } = require('./support/macro-stepper');
const { fakeMacroPage, fakeMacroConnections, connectMacroDrive } = require('./support/macro-page');
const { pageScripts } = require('./support/macro-page-startup');

test('properties beside a wide editor respect the editor minimum and panel maximum', () => {
  for (const width of [506, 520, 640, 900, 1600]) for (const fraction of [-1, .2, 1 / 3, .7, 2]) {
    const layout = Editor.propertiesLayout(width, 600, fraction);
    assert.equal(layout.below, false);
    assert.ok(width - 6 - layout.panelSize >= 320, `editor minimum at ${width}`);
    assert.ok(layout.panelSize <= width * .4, `panel maximum at ${width}`);
    assert.ok(layout.panelSize >= 180, 'Properties remain readable');
    assert.equal(layout.columns, `minmax(320px, 1fr) 6px ${layout.panelSize}px`);
    assert.equal(layout.rows, 'minmax(0, 1fr)');
  }
});

test('properties move below a narrow editor and hiding restores the full editor', () => {
  for (const width of [58, 240, 320, 450, 505]) for (const fraction of [-1, 1 / 3, 2]) {
    const layout = Editor.propertiesLayout(width, 600, fraction);
    assert.equal(layout.below, true);
    assert.equal(layout.columns, 'minmax(0, 1fr)');
    assert.equal(layout.rows, `minmax(0, 1fr) 6px ${layout.panelSize}px`);
    assert.ok(layout.panelSize >= 0 && layout.panelSize <= 600 * .4);
    const hidden = Editor.propertiesLayout(width, 600, fraction, false);
    assert.equal(hidden.below, false);
    assert.equal(hidden.columns, 'minmax(0, 1fr)');
    assert.equal(hidden.rows, 'minmax(0, 1fr)');
  }
});

test('properties changes and pane or window resizing relayout Monaco with bounded dragging', () => {
  const attributes = {}, classes = new Set(), observed = [];
  let width = 900, height = 600, layouts = 0, grid, resize;
  const pane = fakeMacroPage('before', { globals: {
    ResizeObserver: class { constructor(callback) { resize = callback; } observe(node) { observed.push(node); } }
  } }), { page } = pane, work = page.work;
  work.getBoundingClientRect = () => ({ width, height, right: width, bottom: height });
  work.classList.toggle = (name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); };
  page.divider.setAttribute = (name, value) => { attributes[name] = value; };
  const handlers = page.divider.listeners, windowHandlers = Object.fromEntries(pane.listeners);
  page.state = { propertiesVisible: false, splitFraction: .7 };
  page.editor = pane.editor; page.editor.layout = () => { layouts++; };
  page.rule = (_name, css) => { grid = css; }; page.resize = resize;
  function changed(action) { const before = layouts; action(); assert.ok(layouts > before, 'Monaco relayouts on every change'); }
  changed(() => page.updateState());
  assert.ok(grid.includes('grid-template-rows: minmax(0, 1fr)'));
  changed(() => { page.state.propertiesVisible = true; page.updateState(); });
  assert.equal(page.inspector.hidden, false);
  assert.equal(attributes['aria-orientation'], 'vertical');
  changed(() => handlers.pointermove({ pointerId: 1, clientX: 0 }));
  assert.ok(page.state.splitFraction <= .4);
  changed(() => handlers.pointermove({ pointerId: 1, clientX: width }));
  assert.ok(page.state.splitFraction >= .2);
  changed(() => handlers.keydown({ key: 'ArrowLeft', preventDefault() {} }));
  assert.ok(observed.includes(work) && observed.includes(page.syntax));
  changed(() => { width = 500; page.resize(); });
  assert.ok(classes.has('properties-below'));
  assert.equal(attributes['aria-orientation'], 'horizontal');
  assert.ok(grid.includes('grid-template-columns: minmax(0, 1fr)'));
  changed(() => handlers.pointermove({ pointerId: 1, clientY: 0 }));
  assert.ok(page.state.splitFraction <= .4);
  changed(() => handlers.pointermove({ pointerId: 1, clientY: height }));
  assert.ok(page.state.splitFraction >= .2);
  changed(() => handlers.keydown({ key: 'ArrowUp', preventDefault() {} }));
  changed(() => { height = 400; page.resize(); });
  changed(() => { width = 520; windowHandlers.resize(); });
  assert.equal(classes.has('properties-below'), false);
  assert.ok(width - 6 - width * page.state.splitFraction >= 320);
  changed(() => { page.state.propertiesVisible = false; page.updateState(); });
  assert.equal(page.inspector.hidden, true);
  assert.equal(classes.has('no-properties'), true);
});

test('hover boxes include every connected occurrence, deduplicate, clear and persist while tacked', () => {
  const p = project(fixtureAnswer({}), 1), section = p.record.before;
  section.occurrences.push({ ...section.occurrences[2], id: 'r2' });
  section.edges.push({ id: 'possible', binder: 'b', reference: 'r2', certainty: 'possible', phase: null });
  const targets = Model.hoverBoxes(p, pair());
  assert.deepEqual(targets, [pair('b1', 'b'), pair('b1', 'r'), pair('b1', 'r2')]);
  assert.deepEqual(Model.hoverBoxes(p, pair('b1', 'r')), [pair('b1', 'b'), pair('b1', 'r')]);
  assert.deepEqual(Model.hoverBoxes(p, null), []);
  assert.deepEqual(Model.hoverBoxes(p, pair('b1', 'root')), []);
  assert.deepEqual(Model.hoverBoxes(p, pair('foreign')), []);
  assert.deepEqual(Model.hoverBoxes(p, null, [pair()]), targets);
  assert.deepEqual(Model.hoverBoxes(p, pair(), [pair()]), targets);
  assert.equal(Model.hoverBoxes(p, pair('a1'), [pair()]).length, 5, 'Sections retain separate occurrences');
});

test('error and stopped projections retain selectable diagnostic syntax and outer-to-inner context', () => {
  const a = fixtureAnswer({});
  const before = a.steps[0].before;
  a.steps = [{ ...a.steps[0], kind: 'error', after: null, error: 'd' }]; a.final = null; a.error = 'd';
  a.diagnostics.d = { id: 'd', message: 'bad syntax', program: before, syntax: [{ ...before, id: 'implicated' }],
    contexts: ['outer', 'inner'].map(label => ({ label, section: { ...before, id: label } })) };
  const stopped = project(a, 2);
  assert.equal(stopped.error, 'd'); assert.equal(stopped.final, null);
  assert.deepEqual(Model.sections(stopped).map(s => s.label), ['Failing program', 'Implicated syntax', 'outer', 'inner']);
  assert.equal(Model.copy(stopped, pair('inner', 'b')), 'x');
  assert.equal(project(a, 1).record.after, null);
});

test('lift remarks validate and retain selectable contents and transformer contexts in both panes', () => {
  const snapshot = { sourceHash: 'a'.repeat(64), sourceVersion: 1 }, a = fixtureAnswer(snapshot);
  const before = a.steps[0].before;
  a.steps[0] = { ...a.steps[0], kind: 'remark', label: 'Lift', macro: null, after: null,
    contexts: [{ label: 'While executing macro transformer in:', section: { ...before, id: 'transformer' } }] };
  const summary = Data.validateAnswer(summaryOf(a), snapshot);
  const position = Data.validatePosition(project(a, 1), summary, 1);
  for (const pane of [undefined, 'before', 'after']) {
    const p = { ...position, pane };
    assert.deepEqual(Model.sections(p).map(s => s.section.id), ['b1', 'transformer']);
    assert.equal(Model.copy(p, pair('b1', 'b')), 'x');
    assert.equal(Model.copy(p, pair('transformer', 'b')), 'x');
  }
  assert.throws(() => Data.validatePosition({ ...position, record: { ...position.record, after: before } }, summary, 1), /Invalid position program/);
});

test('UTF-16 sections reject split scalars, dangling identities, invalid parents and foreign endpoints', () => {
  const a = fixtureAnswer({}), s = a.final;
  assert.equal(Model.validRange('😀\r\n\tx', [2, 6]), true);
  assert.equal(Model.validRange('😀', [1, 2]), false);
  assert.equal(Model.validRange('x', [0, 2]), false);
  assert.equal(Model.validRange('x', [0.5, 1]), false);
  for (const change of [s => s.focus.push([-1, 1]), s => s.occurrences[0].syntaxId = 'unknown',
    s => s.occurrences[1].parentId = 'missing', s => s.occurrences[0].parentId = 'root',
    s => s.edges[0].reference = 'other-section', s => s.edges[0].phase = null,
    s => s.occurrences[0].macroScopeGroup = -1, s => s.occurrences[0].macroScopeGroup = 1.5,
    s => delete s.occurrences[0].macroScopeGroup]) {
    const bad = structuredClone(s); change(bad); assert.throws(() => Model.validateSection(bad, a.terms));
  }
  assert.throws(() => Data.validateShared([[[0]]]));
  assert.throws(() => Data.validateAnswer({ ...summaryOf(a), schemaVersion: 1 }, a.snapshot), /Incompatible/);
  assert.throws(() => Data.validateAnswer(summaryOf(a), { changed: true }), /Incompatible/);
  assert.throws(() => Data.validateAnswer({ ...summaryOf(a), capabilities: [] }, a.snapshot), /Incompatible/);
});

test('layout owns delimiters, enclosing whitespace, coincident wrappers, parents and every identity appearance', () => {
  const a = fixtureAnswer({}), p = project(a, 1), s = p.record.before;
  assert.equal(Model.hit(s, 0).id, 'root'); assert.equal(Model.hit(s, 4).id, 'root');
  assert.equal(Model.hit(s, 1).id, 'b'); assert.equal(Model.hit(s, 2).id, 'root'); assert.equal(Model.hit(s, 5), null);
  s.occurrences.push({ ...s.occurrences[1], id: 'inner', parentId: 'b' });
  assert.equal(Model.hit(s, 1).id, 'inner');
  assert.equal(Model.move(s, 'inner', 'up').id, 'b'); assert.equal(Model.move(s, 'b', 'down').id, 'inner');
  assert.equal(Model.move(s, 'b', 'right').id, 'r'); assert.equal(Model.move(s, 'r', 'left').id, 'b');
  assert.equal(Model.related(p, pair(), 'bound').length, 5); assert.equal(Model.related(p, pair(), 'free').length, 5);
  assert.deepEqual(Model.related(p, pair(), 'none'), []); assert.deepEqual(Model.related(p, pair('b1', 'root'), 'bound'), []);
  assert.equal(Model.copy(p, pair('b1', 'root')), '(x x)');
  assert.throws(() => Model.copy(p, pair('missing')), /No syntax/);
  assert.deepEqual(Model.lineStarts('😀\r\n\tx\n'), [0, 4, 7]); assert.equal(Model.lineAt([0, 4, 7], 6), 1);
});

test('navigation validation counts completion and rejects fractions, negatives and out-of-range input', () => {
  for (const x of ['end', 3, '3']) assert.equal(Model.jump(x, 3), 3);
  for (const x of [0, -1, 4, 1.5, '1.0', '1e0', '', 'no', null, NaN]) assert.throws(() => Model.jump(x, 3));
});

test('one composed Monaco model retains complete programs and maps marks to decorations', () => {
  const p = project(fixtureAnswer({}), 1);
  const combined = Editor.compose(Model.sections(p)), model = fakeModel(combined.text);
  assert.equal(combined.text, p.record.before.text + p.record.after.text);
  assert.deepEqual(combined.parts.map(p => [p.start, p.end]), [[0, 6], [6, 12]]);
  const marks = { syntaxId: 'x', related: [pair('a1', 'r')], boxes: [pair('b1', 'b'), pair('b1', 'r')], focused: [pair('a1', 'b')] };
  const ds = Editor.decorations(model, combined.parts, marks);
  const ranges = cls => ds.filter(d => (d.options.inlineClassName || d.options.className) === cls).map(d => d.range);
  assert.deepEqual(ranges('macro-before'), [
    { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 3 },
    { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 5 }]);
  assert.deepEqual(ranges('macro-after').map(r => r.startLineNumber), [2, 2]);
  assert.deepEqual(ranges('macro-binder').map(r => [r.startLineNumber, r.startColumn, r.endColumn]), [[1, 2, 3], [2, 2, 3]]);
  assert.deepEqual(ranges('macro-identity'), []);
  assert.deepEqual(ranges('macro-related'), []);
  assert.deepEqual(ranges('macro-word-highlight'), [{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 5 }]);
  assert.deepEqual(ranges('macro-hover').map(r => r.startColumn), [2, 4]);
  assert.deepEqual(ranges('macro-occurrence-focus'), []);
  const crlf = Editor.compose([{ section: { text: '😀\r\nx', id: 'unicode' } }]);
  assert.equal(crlf.text, '😀\nx\n'); assert.equal(crlf.parts[0].offset(4), 3);
  assert.deepEqual(Editor.range(fakeModel(crlf.text), crlf.parts[0], [4, 5]), { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 });
});

test('the inspector source location is a source link with no raw coordinates', () => {
  const node = (tag, value = '') => ({ tag, value, children: [], dataset: {}, handlers: {},
    get textContent() { return this.value + this.children.map(c => c.textContent).join(''); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) { this.handlers[type] = handler; }, contains: () => false,
    querySelectorAll: () => [], querySelector(selector) { return this.children.find(c => selector === '.property' && c.className === 'property'); }
  });
  const a = fixtureAnswer({}), term = decodeTerm(a.shared, a.terms.x);
  term.source = { sourceId: 'main', line: 18, column: 3, position: 999, span: 37 };
  const inspector = node('aside'), sent = [];
  const { page } = fakeMacroPage();
  Object.assign(page, { inspector, selected: { properties: term,
    sourceLocation: '/project/sample.rkt, Ln 18, Col 4 to Ln 18, Col 41' }, expanded: null,
    projection: { sources: { main: { value: '/project/sample.rkt', kind: 'file' } } },
    M: Model, element(tag, text, cls) { return Object.assign(node(tag, text), { className: cls }); },
    id(node, value) { node.id = value; return node; },
    document: { activeElement: null }, persist() {}, send(type) { sent.push(type); }
  });
  page.renderInspector();
  const group = inspector.children.find(c => c.dataset.name === 'source');
  const link = group.querySelector('.property').children[0];
  assert.equal(link.tag, 'a'); assert.equal(link.href, '#');
  assert.equal(link.textContent, page.selected.sourceLocation);
  link.handlers.click({ preventDefault() {} }); assert.deepEqual(sent, ['goToSource']);
  assert.doesNotMatch(inspector.textContent, /position:|span:|sourceId|column:|line:|999|Unavailable source/);
});

test('position notes, transfers and busy states never add text above either pane', async () => {
  const timers = fakeTimers();
  const { page } = fakeMacroPage('before', { globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
  page.projection = {};
  for (const side of ['before', 'after']) for (const kind of ['loading', 'busy']) {
    page.projection.pane = side;
    if (kind === 'loading') page.loading = true; else page.state.busy = true;
    page.updateStatus(); await timers.advance(299);
    assert.equal(page.note.textContent, '', kind);
    page.loading = page.state.busy = false; page.updateStatus(); await timers.advance(1);
    assert.equal(page.note.textContent, '', 'A fast transfer never shows loading or busy text');
    if (kind === 'loading') page.loading = true; else page.state.busy = true;
    page.updateStatus(); await timers.advance(299); assert.equal(page.note.textContent, '');
    await timers.advance(1000); assert.equal(page.note.textContent, '', 'Slow work also leaves the pane quiet');
    page.loading = page.state.busy = false; page.updateStatus(); assert.equal(page.note.textContent, '');
  }
  for (const text of ['No macro step on that line; showing the first Standard position.',
    'The invocation anchor was clamped to the current source.',
    'Source unavailable: snapshot only. Refresh is disabled.', 'Refresh to expand the current source']) {
    page.state.note = text; page.updateStatus();
    assert.equal(page.note.textContent, '', text);
  }
  page.projection = { pane: 'after', error: 'd', diagnostics: { d: { message: 'bad syntax' } } };
  page.updateStatus(); assert.equal(page.note.textContent, 'bad syntax');
  page.projection.pane = 'before'; page.updateStatus(); assert.equal(page.note.textContent, '');
  page.state.error = 'Reader failure'; page.updateStatus(); assert.equal(page.note.textContent, 'Reader failure');
  page.state.error = null; page.updateStatus(); assert.equal(page.note.textContent, '');
});

test('minimal Monaco edits retain the common prefix and suffix with undo disabled', () => {
  const cases = [
    ['prefix', 'abc\nkeep\n', 'XYZabc\nkeep\n', 0, 0, 'XYZ'],
    ['suffix', 'keep\nabc', 'keep\nabcXYZ', 8, 8, 'XYZ'],
    ['middle', 'keep\nold\ntail\n', 'keep\nnew\ntail\n', 5, 8, 'new'],
    ['identical', 'same\n', 'same\n', 5, 5, ''],
    ['empty insertion', '', 'new', 0, 0, 'new'],
    ['empty deletion', 'old', '', 0, 3, ''],
    ['both empty', '', '', 0, 0, ''],
    ['scalar boundary', 'a😀z', 'a😁z', 1, 3, '😁']
  ];
  for (const [name, old, text, start, end, middle] of cases) {
    const pane = fakeMacroPage(), model = pane.page.monaco.editor.createModel(old, 'macro-preview');
    const a = model.getPositionAt(start), b = model.getPositionAt(end);
    const result = Editor.editText(model, text);
    assert.deepEqual(pane.edits, [{ undo: false, operations: [{ range: {
      startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column
    }, text: middle }] }], name);
    assert.equal(model.getValue(), text, name);
    assert.equal(result.identical, old === text, name);
  }
});

for (const side of ['before', 'after']) test(`${side} stepping replaces decorations in one call and edits only the changed middle`, () => {
  const pane = fakeMacroPage(side), a = fixtureAnswer({});
  a.steps[0][side].text = 'prefix\n(x x)\nsuffix\n';
  a.steps[1][side].text = 'prefix\n(y x)\nsuffix\n';
  pane.page.renderPosition({ ...project(a, 1), pane: side });
  const previousIds = plain(pane.page.decorationIds), calls = pane.decorationCalls.length;
  assert.ok(previousIds.length);
  pane.page.renderPosition({ ...project(a, 2), pane: side });
  assert.equal(pane.decorationCalls.length - calls, 1, 'No intermediate clearing of decorations');
  assert.deepEqual(pane.decorationCalls.at(-1).old, previousIds);
  assert.ok(pane.decorationCalls.at(-1).values.length, 'Replacement marks arrive in the same call');
  assert.deepEqual(pane.edits, [{ undo: false, operations: [{ range: {
    startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 3
  }, text: 'y' }] }]);
});

test('the view observes real model calls, changed lines and retained rendered elements', () => {
  const pane = fakeMacroConnections('before'), { page } = pane;
  page.testEnabled = true;
  const lines = [0, 20, 40, 60].map(top => ({ getBoundingClientRect: () => ({ top }) }));
  page.editorSurface.querySelectorAll = selector => selector === '.view-lines > .view-line' ? lines : [];
  const a = fixtureAnswer({});
  a.steps[0].before.text = 'prefix\n(x x)\nsuffix\n';
  a.steps[1].before.text = 'prefix\n(y x)\nsuffix\n';
  pane.render(project(a, 1)); pane.render(project(a, 2));
  const edit = pane.observe().modelEdit;
  assert.equal(edit.count, 1); assert.equal(edit.changes.length, 1);
  assert.deepEqual(edit.changes[0].range, edit.range);
  assert.deepEqual(edit.retained.map(line => line.oldLine), [1, 3, 4]);
  assert.ok(edit.retained.every(line => line.sameElement));
  lines[0] = { getBoundingClientRect: () => ({ top: 0 }) };
  assert.equal(pane.observe().modelEdit.retained[0].sameElement, false, 'Replacing a real node is observable');
  pane.render(project(a, 2));
  assert.equal(pane.observe().modelEdit.count, 1, 'An identical position still calls the model once');
  assert.equal(pane.observe().modelEdit.changes.length, 0, 'An empty edit emits no content change');
});

test('each pane keeps one editor and model with no position headings or view zones', () => {
  for (const side of ['before', 'after']) {
    const { page, zones, created, models, options, disposed, textFocus } = fakeMacroPage(side);
    for (const n of [1, 2, 3]) {
      const p = { ...project(fixtureAnswer({}), n), pane: side };
      page.renderPosition(p);
      const combined = Editor.compose(Model.sections(p));
      assert.equal(models[0].getValue(), combined.text);
      assert.equal(options.lineNumbers(1), '1');
    }
    assert.equal(created.length, 1); assert.equal(models.length, 1, 'Navigation never detaches the focused Monaco view');
    assert.equal(created[0].options.readOnly, true); assert.equal(created[0].options.contextmenu, false);
    assert.equal(created[0].options.wordWrap, 'off'); assert.equal(created[0].options.folding, true);
    assert.equal(zones.length, 0); assert.equal(disposed.length, 0); assert.equal(textFocus(), true);
  }
  const source = pageScripts().filter(([file]) => !/\/(model|geometry|protocol|monaco)\.js$/.test(file)).map(([, source]) => source).join('\n');
  assert.doesNotMatch(source, /changeViewZones|Expansion finished|Expansion stopped/);
});

test('each multiline error context restarts Monaco line numbers at one in After', () => {
  const { page, models, options } = fakeMacroPage('after');
  const a = fixtureAnswer({}, '(x\n x)\n'), before = a.steps[0].before;
  a.steps = [{ ...a.steps[0], kind: 'error', after: null, error: 'd' }]; a.final = null; a.error = 'd';
  a.diagnostics.d = { message: 'bad syntax', program: before, syntax: [{ ...before, id: 'implicated' }],
    contexts: ['outer', 'inner'].map(label => ({ label, section: { ...before, id: label } })) };
  for (const position of [1, 2]) {
    const p = { ...project(a, position), pane: 'after' }; page.renderPosition(p);
    const combined = Editor.compose(Model.sections(p));
    for (const part of combined.parts) {
      const line = models[0].getPositionAt(part.start).lineNumber;
      assert.equal(options.lineNumbers(line), '1'); assert.equal(options.lineNumbers(line + 1), '2');
    }
    assert.equal(page.note.textContent, 'bad syntax');
  }
});

test('paired panes preserve independent wheel scroll across stepping, hiding, Refresh and completion', () => {
  const before = fakeMacroPage('before'), after = fakeMacroPage('after');
  const position = (side, n, line = 70) => {
    const p = project(fixtureAnswer({}), n), text = (' '.repeat(40) + '(x x)\n').repeat(180);
    for (const { section } of Model.sections(p)) { section.text = text; section.focus = [[(line - 1) * 46 + 41, (line - 1) * 46 + 42]]; }
    if (n === 3 && side === 'before') p.terminalBefore = { ...p.final, id: 'last-before' };
    return { ...p, pane: side };
  };
  for (const [pane, side, top, left] of [[before, 'before', 1200, 160], [after, 'after', 1100, 80]]) {
    pane.page.renderPosition(position(side, 1));
    pane.editor.setScrollPosition({ scrollTop: top, scrollLeft: left });
    const count = pane.reveals.length;
    for (const generation of [1, 2, 3]) {
      pane.page.env.generation = generation; pane.page.renderPosition(position(side, 2));
      assert.equal(pane.editor.getScrollTop(), top); assert.equal(pane.editor.getScrollLeft(), left);
      assert.equal(pane.reveals.length, count, 'A visible focus leaves this pane alone');
    }
    pane.page.renderPosition(position(side, 3));
    assert.equal(pane.editor.getScrollTop(), top, 'Completion preserves the viewport');
    const noFocus = position(side, 2); noFocus.record[side].focus = [];
    pane.page.renderPosition(noFocus); assert.equal(pane.editor.getScrollTop(), top);
    pane.page.renderPosition(position(side, 2, 140));
    assert.deepEqual(pane.reveals.at(-1), { line: 140, mode: 1 });
    assert.equal(pane.editor.getScrollLeft(), left, 'Vertical centring preserves horizontal scroll');
    assert.equal(pane.models.length, 1, 'Wheel scrolling must not be followed by model detach/refocus at line one');
  }
  before.editor.setScrollLeft(1000);
  const beforeTop = before.editor.getScrollTop();
  before.page.renderPosition(position('before', 2, 140));
  assert.equal(before.editor.getScrollTop(), beforeTop, 'Horizontal reveal leaves vertical scroll alone');
  assert.equal(before.editor.getScrollLeft(), 328, 'An offscreen start is revealed at the left edge of its own pane');
  assert.equal(after.editor.getScrollLeft(), 80, 'The other pane keeps its horizontal scroll');
  const afterTop = after.editor.getScrollTop();
  before.page.renderPosition(position('before', 1, 20));
  assert.equal(after.editor.getScrollTop(), afterTop, 'Only Before moves when its focus leaves the viewport');
  for (const side of ['before', 'after']) {
    const restored = fakeMacroPage(side); restored.page.restoring = true;
    Object.assign(restored.page.saved, { source: 'untitled:scroll', scroll: [1200, 160] });
    restored.page.renderPosition(position(side, 1));
    assert.equal(restored.editor.getScrollTop(), 1200); assert.equal(restored.editor.getScrollLeft(), 160);
  }
});

test('horizontal stepping reveals only the focus start with the smallest scroll in either pane', () => {
  const position = (side, n, column, endColumn = column + 1, line = 70) => {
    const p = project(fixtureAnswer({}), n), row = ' '.repeat(300) + '(x x)\n';
    for (const { section } of Model.sections(p)) {
      section.text = row.repeat(180);
      section.focus = [[(line - 1) * row.length + column - 1, (line - 1) * row.length + endColumn - 1]];
    }
    return { ...p, pane: side };
  };
  const cases = [
    { name: 'visible start and offscreen end', left: 160, column: 42, end: 301, expected: 160 },
    { name: 'start at left edge', left: 160, column: 21, expected: 160 },
    { name: 'start just inside right edge', left: 161, column: 121, expected: 161 },
    { name: 'start at exclusive right edge', left: 160, column: 121, expected: 161 },
    { name: 'start beyond right edge', left: 160, column: 151, expected: 401 },
    { name: 'start before left edge', left: 400, column: 42, expected: 328 },
    { name: 'start at column one', left: 160, column: 1, expected: 0 }
  ];
  for (const side of ['before', 'after']) for (const c of cases) for (const line of [70, 140]) {
    const pane = fakeMacroPage(side);
    pane.page.renderPosition(position(side, 1, 42));
    pane.editor.setScrollPosition({ scrollTop: 1200, scrollLeft: c.left });
    pane.page.renderPosition(position(side, 2, c.column, c.end, line));
    const facts = plain(pane.page.focusReveal), start = (c.column - 1) * 8;
    const message = `${side}: ${c.name}, line ${line}: ${JSON.stringify(facts)}`;
    assert.deepEqual(facts.before, { focusStart: { lineNumber: line, column: c.column, left: start },
      horizontalRange: { start: c.left, end: c.left + 800 } }, message);
    assert.equal(pane.editor.getScrollLeft(), c.expected, message);
    assert.deepEqual(facts.after, { focusStart: facts.before.focusStart,
      horizontalRange: { start: c.expected, end: c.expected + 800 } }, message);
    assert.equal(pane.editor.getScrollTop(), line === 70 ? 1200 : 2600, message);
    assert.equal(pane.reveals.length, line === 70 ? 1 : 2, message);
  }
});

test('range index matches logical hit intervals including long containing syntax and distant pages', () => {
  const s = fixtureAnswer({}).final;
  const index = new Model.IntervalIndex(s.occurrences);
  for (let start = 0; start < s.text.length; start++) for (let end = start + 1; end <= s.text.length; end++) {
    const actual = index.query(start, end).map(o => o.id).sort();
    const expected = s.occurrences.filter(o => o.range[0] < end && o.range[1] > start).map(o => o.id).sort();
    assert.deepEqual(actual, expected);
  }
  const p = project(fixtureAnswer({}), 1);
  assert.equal(Model.hit(s, 1, index.query(1, 2), index.byId).id, 'b');
  assert.equal(Model.related(p, pair(), 'bound').length, 4);
});

for (const side of ['before', 'after']) for (const flags of [false, true]) test(`${side} title navigation immediately after focus with delayed ${flags ? 'panel flags' : 'view notifications'}`, async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui, 'A'); const pairA = ui.panels.slice();
  await opened(ui, 'B'); const pairB = ui.panels.slice(2);
  await ui.command('next');
  const target = pairA[side === 'before' ? 0 : 1], other = pairA.find(p => p !== target);
  other.reveal(); await ui.command('next');
  const revisions = pairA.map(p => p.env.positionRevision);
  ui.deferFocus(flags);
  // _focusPane is the command used by focusSide in the editor suite. The
  // selected tab moves immediately; view notifications (and sometimes the
  // panel flags) lag behind.
  await ui.command('_focusPane', side);
  assert.equal(target.active, !flags);
  await ui.command('first');
  for (const [index, p] of pairA.entries()) {
    assert.equal(p.projection.position, 1, 'The command reaches the newly focused pair');
    assert.equal(p.env.positionRevision, revisions[index] + 1, 'Exactly one navigation is applied');
  }
  assert.equal((await ui.command('_observe')).side, side);
  // A second command before notification must still use this pair, even when
  // the cached pane belongs to another source altogether.
  pairB[0].active = true; other.active = false;
  pairB[0].viewState.fire();
  await ui.command('next');
  assert.equal(target.projection.position, 2);
  assert.ok(pairB.every(p => p.projection.position === 2), 'The other source is untouched');
  ui.flushFocus();
  assert.equal((await ui.command('_observe')).side, side);
});

for (const side of ['before', 'after']) test(`${side} navigation after a pending scroll restoration and position transfer runs each request once`, async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui);
  const panel = ui.panels[side === 'before' ? 0 : 1]; panel.reveal();
  const pane = connectMacroDrive(panel, side), frames = [];
  pane.page.requestAnimationFrame = fn => frames.push(fn);
  const start = { ...panel.env };
  // A view-state restore may still have rendering work pending when the
  // settle drive starts. It must neither consume navigation nor replay it.
  const restore = pane.editor.restoreViewState;
  pane.editor.restoreViewState = view => {
    restore(view);
    frames.push(() => pane.editor.setScrollPosition({ scrollTop: 1185, scrollLeft: 152 }));
  };
  panel.ack = false;
  const moving = ui.command('next'); await tick();
  const begin = panel.messages.filter(m => m.type === 'positionBegin').at(-1);
  assert.ok(begin.positionRevision > start.positionRevision);
  // Finish the position payload but hold its acknowledgement. renderPosition
  // has now restored the view, while its deferred frame has not run.
  panel.send('transferAck', { transferId: begin.transferId, lastSequence: -1, success: true }); await tick();
  const chunk = panel.messages.filter(m => m.type === 'positionChunk').at(-1);
  panel.send('transferAck', { transferId: begin.transferId, lastSequence: chunk.sequence, success: true }); await tick();
  assert.equal(panel.projection.position, 2);
  assert.ok(frames.length > 0, 'Scroll restoration is still pending');
  const settling = ui.command('_drive', { type: 'settle' }); await tick();
  const revision = panel.env.positionRevision;
  panel.ack = true;
  await ui.command('first'); await moving;
  assert.equal(panel.projection.position, 1, 'Title navigation supersedes the restoring position');
  // Both keys were sent from the same displayed revision, before the new
  // state could arrive. They must advance the shared position twice.
  const send = (action, navigationSequence, extra = {}) => panel.incoming.fire({
    ...start, v: 1, type: 'navigate', requestId: `queued-${navigationSequence}`,
    clientInstanceId: 'client', navigationSequence, action, ...extra
  });
  send('next', 1); send('next', 2); await tick();
  assert.equal(panel.projection.position, 3, 'Queued navigation survives a display revision change');
  const committed = panel.env.positionRevision;
  send('next', 2); send('previous', 1); await tick();
  assert.equal(panel.env.positionRevision, committed, 'Replayed requests never act twice');
  assert.equal(committed, revision + 3, 'One title command and two keys each act once');
  while (frames.length) { frames.shift()(); await tick(); }
  assert.ok(await settling, 'The settle drive answers against its original envelope');
  assert.ok(ui.panels.every(p => p.projection.position === 3), 'Late restoration cannot replace navigation');
  send('previous', 3, { generation: start.generation - 1 }); await tick();
  assert.equal(panel.projection.position, 3, 'An older expansion remains stale');
  // Page replacement invalidates the old navigation identity independently
  // of its display revision. The other pane keeps its own live sequence.
  panel.incoming.fire({ v: 1, type: 'ready', clientInstanceId: 'replacement' }); await tick();
  send('previous', 3, { positionRevision: panel.env.positionRevision }); await tick();
  assert.equal(panel.projection.position, 3, 'A replaced page cannot navigate');
});

for (const closed of [0, 1]) test(`closing ${closed === 0 ? 'Before' : 'After'} closes the pair and stops its worker`, async () => {
  const ui = fakeStepper();
  try {
    await opened(ui); const worker = ui.pending[0];
    ui.panels[closed].dispose(); await tick();
    assert.ok(ui.panels.every(p => p.closed)); assert.equal(worker.stopped, true);
    assert.equal(await ui.command('_workerCount'), 0);
  } finally { ui.dispose(); }
});

for (const side of ['before', 'after']) test(`${side} native menu arguments use the cursor term and reject old, foreign or other-pane targets`, async () => {
  const ui = fakeStepper();
  try {
    const d = await opened(ui), p = ui.panels[side === 'before' ? 0 : 1]; p.reveal();
    const first = side === 'before' ? 'b1' : 'a1';
    const clicked = { ...p.env, ...pair(first, 'root') };
    p.send('select', pair(first, 'root')); await tick();
    await ui.command('copyTerm', clicked); assert.deepEqual(ui.clipboard, ['(x x)']);
    assert.deepEqual(plain(p.selection.selected), pair(first, 'root'));
    await ui.command('properties', clicked); assert.equal((await ui.command('_observe')).propertiesVisible, true);
    await ui.command('properties', clicked); assert.equal((await ui.command('_observe')).propertiesVisible, false);
    const identifier = { ...p.env, ...pair(first, 'r') };
    p.send('select', pair(first, 'r')); await tick();
    await ui.command('tack', identifier); assert.deepEqual(plain((await ui.command('_observe')).pins), [pair(first, 'r')]);
    p.send('select', pair(first, 'b')); await tick();
    await ui.command('tack', { ...identifier, occurrenceId: 'b' });
    assert.equal((await ui.command('_observe')).pins.length, 2);
    await ui.command('untackAll', clicked); assert.deepEqual(plain((await ui.command('_observe')).pins), []);
    assert.equal(ui.contexts['racketdap.macroSteps.hasPins'], false);
    assert.deepEqual(plain(p.selection.selected), pair(first, 'b'), 'Clearing arrows keeps the current selection');
    const before = ui.clipboard.length;
    await ui.command('copyTerm', { ...identifier, sectionId: side === 'before' ? 'a1' : 'b1' });
    await ui.command('copyTerm', { ...identifier, sessionId: 'foreign' });
    await ui.command('copyTerm', { ...identifier, occurrenceId: 'missing' });
    await ui.command('next'); await ui.command('copyTerm', identifier);
    assert.equal(ui.clipboard.length, before);
    const source = { ...p.env, ...pair(side === 'before' ? 'b2' : 'a2') };
    p.send('select', { sectionId: source.sectionId, occurrenceId: source.occurrenceId }); await tick();
    await ui.command('goToSource', source); assert.equal(ui.window.activeTextEditor.document, d);
  } finally { ui.dispose(); }
});

test('shared page state preserves its accessors when composed and exposes writes to both owners', () => {
  const { context } = fakeMacroPage();
  const state = context.MacroView.createState({}), composed = {};
  Object.defineProperties(composed, Object.getOwnPropertyDescriptors(state));
  for (const name of [
    'env', 'serial', 'navigationSequence', 'state', 'projection', 'editor', 'expanded', 'tokenStyles',
    'editorModel', 'tokenSections', 'tokenProvider', 'themeName', 'editorSettings', 'themeSignature',
    'hover', 'renderingPosition', 'testEnabled', 'lineSnapshot', 'modelEdits', 'modelChanges',
    'selected', 'focused', 'sections', 'positionEdit', 'focusReveal', 'decorationIds', 'restoring',
    'frame', 'drawn', 'boxes', 'inspectionTimer', 'inspectionTarget', 'loading'
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(composed, name);
    assert.equal(typeof descriptor?.get, 'function', `${name} exposes shared reads`);
    assert.equal(typeof descriptor?.set, 'function', `${name} exposes shared writes`);
    const original = state[name], value = {};
    composed[name] = value;
    assert.equal(state[name], value, `${name} writes reach the state owner`);
    state[name] = original;
    assert.equal(composed[name], original, `${name} owner writes reach composed components`);
  }
});
