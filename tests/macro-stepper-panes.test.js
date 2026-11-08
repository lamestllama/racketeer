// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper panes behavior.
'use strict';
const { tick, plain, root } = require('./support/macro-common');
const test = require('./support/node-test');
const { until } = require('./support/wait');
const assert = require('node:assert/strict');
const Model = require('../vscode/macro-view/model');
const Protocol = require('../vscode/macro-view/protocol');
const fs = require('node:fs');
const path = require('node:path');
const Editor = require('../vscode/macro-view/monaco');
const os = require('node:os');
const { decodeTerm } = require('../vscode/macro-stepper-codec');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { pair, fakeModel, fixtureAnswer } = require('./support/macro-fixtures');
const { moduleBinding } = require('./support/macro-sentence');
const { fakeMacroPage } = require('./support/macro-page');

test('panel opens beside source, sends one position, counts terminal, selects, copies and inspects properties', async () => {
  const ui = fakeStepper(), d = await opened(ui), p = ui.panels[0];
  assert.equal(p.type, 'racketeer.macroSteps'); assert.equal(p.options.retainContextWhenHidden, true); assert.equal(p.options.enableFindWidget, false);
  assert.equal(p.events[0], 'html', 'CSP is installed before webview options or listeners');
  assert.equal(p.events.filter(e => e === 'html').length, 1);
  assert.match(p.html, /nonce-/); assert.equal(p.webview.options.enableCommandUris, false);
  assert.equal(p.projection.position, 1); assert.equal(p.projection.count, 3); assert.equal(p.projection.steps, undefined);
  assert.equal(p.active, true, 'Source following preserves panel focus');
  assert.equal(ui.follows.at(-1).document, d); assert.equal(p.active, true);
  await ui.command('last'); assert.equal(Model.sections(p.projection)[0].section.id, 'final');
  assert.deepEqual(ui.pending[0].queries.filter(q => q.mode === 'position').map(q => q.position), [1, 3],
    'Jumping to completion does not render an unvisited last reduction');
  await ui.command('next'); assert.equal(p.projection.position, 3);
  await ui.command('first'); await ui.command('previous'); assert.equal(p.projection.position, 1);
  p.send('select', pair()); await tick();
  assert.equal(p.selection.properties.kind, 'identifier'); assert.equal(p.selection.related.length, 2);
  await ui.command('copyTerm'); assert.deepEqual(ui.clipboard, ['x']);
  assert.equal(p.selection.related.length, 2, 'Selection keeps the default identifier relation');
  await ui.command('properties'); assert.equal(p.messages.filter(m => m.type === 'state').at(-1).propertiesVisible, true);
  p.send('pin', { action: 'tack', ...pair() }); await tick();
  assert.equal(p.messages.filter(m => m.type === 'state').at(-1).pins.length, 1);
  await ui.command('next'); assert.equal(p.projection.position, 2);
  assert.deepEqual(p.selection.selected, null); assert.deepEqual(plain(p.messages.filter(m => m.type === 'state').at(-1).pins), []);
  await ui.command('jump', 'bad'); assert.equal(p.projection.position, 2);
  assert.match(p.messages.filter(m => m.type === 'actionResult').at(-1).message, /step/);
  p.send('select', { sectionId: 'foreign', occurrenceId: 'b' }); await tick();
  assert.equal(p.selection.selected, null);
  ui.dispose();
});

test('selection sends a source label computed through the captured text', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  const document = await opened(ui, 'sample.rkt'), pane = ui.panels[0];
  pane.send('select', pair()); await tick();
  const location = pane.selection.properties.source;
  const [start, end] = Model.sourceOffsets(document.text, location.line, location.column, location.span);
  const point = offset => { const p = document.positionAt(offset); return `Ln ${p.line + 1}, Col ${p.character + 1}`; };
  assert.equal(pane.selection.sourceLocation, `untitled:sample.rkt, ${point(start)} to ${point(end)}`);
});

test('hover inspection uses the retained worker and caches binding facts without selecting in either pane', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('imports'); const opening = ui.open(true); await tick();
  ui.answer(ui.pending[0], a => {
    const share = value => {
      if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
      const entry = Array.isArray(value) ? value.map(share) : typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, share(item)])) : value;
      return [a.shared.push(entry) - 1];
    };
    const term = { ...a.shared[a.terms.x], bindings: share([moduleBinding]) };
    a.terms.x = a.shared.push(term) - 1;
  });
  await opening;
  const process = ui.pending[0];
  for (const pane of ui.panels) {
    const section = Model.sections(pane.projection)[0].section, target = pair(section.id, 'r');
    const selectionTransfers = pane.messages.filter(m => m.type === 'positionBegin' && m.payloadKind === 'selection').length;
    for (let n = 0; n < 2; n++) {
      pane.send('inspect', target); await tick();
      const result = pane.messages.filter(m => m.type === 'bindingFacts').at(-1);
      Protocol.validateHost(result, pane.env);
      assert.deepEqual(plain(result.target), target);
      assert.equal(result.bindings[0].definedIn, moduleBinding.definedIn);
      assert.equal(result.bindings[0].importedFrom, moduleBinding.importedFrom);
      assert.equal(pane.selection.selected, null);
      assert.equal(pane.messages.filter(m => m.type === 'positionBegin' && m.payloadKind === 'selection').length, selectionTransfers);
    }
    const before = pane.messages.filter(m => m.type === 'bindingFacts').length;
    pane.send('inspect', pair('foreign')); await tick();
    pane.send('inspect', pair(section.id, 'root')); await tick();
    assert.equal(pane.messages.filter(m => m.type === 'bindingFacts').length, before, 'Only local names may be inspected');
  }
  assert.equal(process.queries.filter(q => q.mode === 'inspect').length, 1, 'Both panes reuse the existing inspection cache');
  assert.equal(ui.pending.length, 1, 'Inspection does not expand again');
  const pane = ui.panels[0], oldEnv = { ...pane.env };
  await ui.command('next');
  const count = process.queries.length;
  pane.incoming.fire({ ...oldEnv, v: 1, type: 'inspect', requestId: 'old-hover', ...pair() }); await tick();
  assert.equal(process.queries.length, count, 'An old hover cannot inspect a new position');
});

test('inspection replies for a replaced position never reach the pane', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui); const pane = ui.panels[0], process = ui.pending[0];
  process.manualInspection = true;
  pane.send('inspect', pair()); await tick();
  const query = process.queries.at(-1), before = pane.messages.filter(m => m.type === 'bindingFacts').length;
  const moving = ui.command('next'); await tick();
  ui.finish(process, { schemaVersion: 2, mode: 'inspect', snapshot: query.snapshot, position: query.position,
    term: query.term, shared: process.data.shared, termData: process.data.terms[query.term], sources: process.data.sources });
  await moving; await tick();
  assert.equal(pane.messages.filter(m => m.type === 'bindingFacts').length, before);
  assert.equal(pane.projection.position, 2);
});

test('Monaco positions select final, before, after and error syntax and update the properties protocol', async () => {
  const ui = fakeStepper();
  try {
    await opened(ui);
    const panel = ui.panels[0];
    const pane = fakeMacroPage(), { page } = pane, inspector = page.inspector;
    page.send = (type, fields) => panel.send(type, fields);
    const validate = panel.receiver.validate;
    panel.receiver.validate = (value, kind) => { const result = validate(value, kind);
      if (kind === 'selection') { page.selected = result; page.renderInspector(); } return result; };
    async function select(sectionId) {
      page.projection = panel.projection;
      const combined = Editor.compose(Model.sections(panel.projection));
      page.editorModel = fakeModel(combined.text);
      page.partsBySection = new Map(combined.parts.map(p => [p.section.id, { ...p, rangeIndex: new Model.IntervalIndex(p.section.occurrences) }]));
      const part = page.partsBySection.get(sectionId), position = page.editorModel.getPositionAt(part.offset(1));
      const pairAtPosition = page.atPointer({ position });
      assert.deepEqual(plain(pairAtPosition), pair(sectionId));
      page.editor = pane.editor;
      page.editor.getSelections = () => []; page.editor.getSelection = () => null;
      page.editor.getPosition = () => position;
      page.updateCurrentTerm(); await tick();
      assert.deepEqual(plain(panel.selection.selected), pair(sectionId));
      assert.equal(panel.selection.properties.kind, 'identifier');
      assert.doesNotMatch(inspector.textContent, /identifier · x/); assert.match(inspector.textContent, /Apparent identifier binding/);
    }
    await ui.command('next'); await ui.command('last'); await select('b2');
    await ui.command('first'); await select('b1');
    const refresh = ui.command('refresh'); await tick();
    ui.answer(ui.pending.at(-1), a => {
      const before = a.steps[0].before;
      a.steps = [{ ...a.steps[0], kind: 'error', after: null, error: 'd' }]; a.final = null; a.error = 'd';
      a.diagnostics.d = { message: 'bad syntax', program: before, syntax: [{ ...before, id: 'implicated' }],
        contexts: [{ label: 'Error context', section: { ...before, id: 'context' } }] };
    });
    await refresh; await select('b1');
    await ui.command('last'); await select('b1');
    page.editor.getPosition = () => page.editorModel.getPositionAt(page.editorModel.getValue().length);
    page.updateCurrentTerm(); await tick(); assert.equal(panel.selection.selected, null); assert.match(inspector.textContent, /No term at cursor/);
  } finally { ui.dispose(); }
});

test('dirty source warns immediately, undo clears it, old positions remain interactive and Refresh re-captures without saving', async () => {
  const ui = fakeStepper(), d = await opened(ui), p = ui.panels[0], original = d.text;
  ui.edit(d, '; changed\n' + original); await tick();
  assert.equal(p.title, 'Before - Step 1 of 3 - A'); assert.equal(p.messages.filter(m => m.type === 'sourceStatus').at(-1).stale, true);
  assert.equal(ui.decorations.at(-1).ranges.length, 0);
  await ui.command('next'); assert.equal(p.projection.position, 2);
  ui.edit(d, original); await tick(); assert.equal(p.title, `Before - Step ${p.projection.position} of 3 - A`);
  ui.edit(d, original + '; refreshed\n');
  const refresh = ui.command('refresh'); await tick();
  assert.equal(ui.pending.at(-1).request.text, d.text); assert.equal(ui.pending.at(-1).request.schemaVersion, 2);
  ui.answer(ui.pending.at(-1)); await refresh;
  assert.equal(p.projection.position, 1); assert.equal(p.title, `Before - Step ${p.projection.position} of 3 - A`);
  assert.equal(d.text, original + '; refreshed\n');
  ui.dispose();
});

test('replacement generations cancel older work; background panels cannot change active contexts or follow source', async () => {
  const ui = fakeStepper(), a = await ui.source('A');
  const first = ui.open(true); await tick(); const old = ui.pending.at(-1);
  ui.edit(a, a.text + '; newer\n');
  const second = ui.open(true); await tick(); const next = ui.pending.at(-1);
  assert.notEqual(next, old); assert.equal(old.stopped, true);
  ui.answer(next); await second; ui.answer(old); await first;
  assert.equal(ui.panels.length, 2);
  const toggle = ui.command('showAll'); await tick(); const background = ui.pending.at(-1);
  await opened(ui, 'B'); await ui.command('last');
  const before = { ...ui.contexts }, follows = ui.follows.length;
  ui.answer(background); await toggle;
  assert.deepEqual(ui.contexts, before); assert.equal(ui.follows.length, follows);
  assert.equal(ui.panels[0].projection.position, 1); assert.equal(ui.panels[2].projection.position, 3);
  ui.dispose();
});

test('busy cancellation restores an accepted snapshot, failed refresh explains failure, and disposal stops owned processes', async () => {
  const ui = fakeStepper(), d = await opened(ui), p = ui.panels[0];
  const refresh = ui.command('refresh'); await tick(); const pending = ui.pending.at(-1);
  assert.equal(ui.progress.at(-1).cancellable, true, 'The progress notification retains Cancel');
  pending.handlers.output('{"unfinished":'); ui.cancel(); await refresh;
  assert.equal(p.projection.position, 1); assert.equal(pending.stopped, true);
  const failed = ui.command('refresh'); await tick(); ui.finish(ui.pending.at(-1), { failed: 'reader failure' }); await failed;
  assert.equal(p.projection.position, 1); assert.match(p.messages.filter(m => m.type === 'state').at(-1).error, /reader failure/);
  const request = ui.command('refresh'); await tick(); p.dispose(); await request;
  assert.equal(ui.pending.at(-1).stopped, true);
  ui.workspace.isTrusted = false; await ui.window.showTextDocument(d);
  await assert.rejects(ui.open(true), /Trust/);
  ui.dispose();
});

test('recreated page receives authoritative position, selection and pins; transfer rejection and replacement stay bounded', async () => {
  const ui = fakeStepper(); await opened(ui); const p = ui.panels[0];
  await ui.command('next'); await ui.command('last'); p.send('select', pair('b2')); await tick(); p.send('pin', { action: 'tack', ...pair('b2') }); await tick();
  p.incoming.fire({ v: 1, type: 'ready', clientInstanceId: 'recreated' }); await tick(); await tick();
  assert.equal(p.projection.position, 3); assert.deepEqual(p.selection.selected, pair('b2'));
  assert.equal(p.messages.filter(m => m.type === 'state').at(-1).pins.length, 1);
  p.ack = false;
  const moving = ui.command('first'); await tick();
  const begin = p.messages.filter(m => m.type === 'positionBegin').at(-1);
  assert.equal(begin.payloadKind, 'position', 'The pending transfer is a position, even while the other pane posts state');
  p.send('transferAck', { transferId: begin.transferId, lastSequence: -1, success: false, reason: 'test rejection' });
  await moving;
  assert.ok(p.messages.some(m => m.type === 'transferAbort' && /test rejection/.test(m.reason)));
  p.ack = true; await ui.command('next'); assert.equal(p.projection.position, 2);
  assert.equal(ui.pending.length, 1, 'Navigation never expands again');
  ui.dispose();
});

test('a line without a macro keeps both panes free of position notes while stepping', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('A');
  const editor = ui.window.activeTextEditor;
  editor.selection = new editor.selection.constructor(0, 0, 0, 0);
  const opening = ui.open(false); await tick();
  const process = ui.pending.at(-1);
  ui.answer(process); await tick();
  assert.equal(process.queries.at(-1).hiding, 'line');
  ui.answer(process); await tick();
  assert.equal(process.queries.at(-1).hiding, 'standard');
  ui.answer(process); await opening;
  for (const action of ['next', 'last', 'previous', 'first']) {
    await ui.command(action);
    for (const pane of ui.panels) {
      const state = pane.messages.filter(m => m.type === 'state').at(-1);
      assert.equal(state.note, undefined, pane.title);
      assert.equal(state.error, null);
    }
  }
});

test('More phases queries retained syntax without re-expanding and merges empty versus uninspected scopes', async () => {
  const ui = fakeStepper(); await opened(ui); const p = ui.panels[0], process = ui.pending[0];
  p.send('select', pair()); await tick();
  process.manualInspection = true;
  const inspecting = ui.command('morePhases'); await tick();
  assert.equal(process.queries.filter(q => q.mode === 'inspect').length, 2); const query = process.queries.at(-1);
  assert.equal(query.mode, 'inspect'); assert.equal(query.term, 'x'); assert.deepEqual(plain(query.phases), [1, -1, 'label']);
  assert.equal(query.text, undefined); assert.equal(query.hiding, undefined);
  const shared = ['label', [1, -1, [0]], { phase: 1 }, { phase: -1 }, { phase: [0] },
    [[2], [3], [4]], { kind: 'identifier', inspectedPhases: [1], scopes: [5] }];
  ui.finish(process, { schemaVersion: 2, mode: 'inspect', snapshot: query.snapshot, position: query.position, term: 'x', shared, termData: 6 });
  await inspecting;
  assert.deepEqual(p.selection.properties.inspectedPhases, [0, 1, -1, 'label']);
  const scopes = p.selection.properties.scopes.find(s => s.phase === 1); assert.equal(scopes.status, 'known'); assert.deepEqual(scopes.scopes, []);
  assert.equal(p.selection.properties.scopes.find(s => s.phase === 9), undefined);
  assert.equal(ui.pending.length, 1);
  await process.stop(); await ui.command('morePhases');
  assert.equal(ui.pending.length, 1, 'Already inspected phases remain available from the cache');
  const returning = ui.command('next'); await tick();
  assert.equal(ui.pending.length, 2, 'An uncached position restores an expired session');
  ui.answer(ui.pending.at(-1)); await returning;
  assert.equal(p.projection.position, 2); ui.dispose();
});

test('first-load failure and restored placeholders explain missing context without running automatically', async () => {
  const ui = fakeStepper(); const d = await ui.source('A'), opening = ui.open(true); await tick();
  ui.finish(ui.pending.at(-1), { failed: 'Reader failure', failureCode: 'source' }); await opening;
  const p = ui.panels[0]; assert.match(p.messages.filter(m => m.type === 'state').at(-1).error, /Reader failure/);
  assert.equal(p.title, 'Before - Error - A');
  p.dispose(); const count = ui.pending.length;
  const restored = ui.window.createWebviewPanel('racketeer.macroSteps', 'Macro steps', {}, {});
  await ui.serializer().deserializeWebviewPanel(restored, { source: d.uri.toString(), wholeFile: true, range: [2, 0, 2, 0] });
  await tick(); assert.equal(ui.pending.length, count);
  assert.equal(restored.messages.filter(m => m.type === 'state').at(-1).note, undefined);
  assert.equal(restored.projection, undefined); ui.dispose();
});

test('dependency provenance permits automatic following only while its fingerprint matches', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-macro-source-')), file = path.join(directory, 'dependency.rkt');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const text = '(x)\n'; fs.writeFileSync(file, text);
  const ui = fakeStepper(), dep = await ui.source('dependency'); dep.uri = dep.uri.constructor.file(file); dep.text = text;
  const main = await ui.source('main'), opening = ui.open(true); await tick();
  ui.answer(ui.pending.at(-1), a => {
    a.sources.dep = { kind: 'file', value: file, fingerprint: require('node:crypto').createHash('sha256').update(text).digest('hex') };
    a.steps[0].source = { sourceId: 'dep', line: 1, column: 0, span: 3, position: 1 };
  });
  await opening;
  assert.equal(ui.follows.at(-1).document, dep); assert.equal(ui.panels[0].active, true);
  ui.edit(dep, '; changed\n' + text); await tick();
  assert.equal((await ui.command('_observe')).stale, true); assert.equal(ui.decorations.at(-1).ranges.length, 0);
  ui.edit(dep, text); await tick(); assert.equal((await ui.command('_observe')).stale, false);
  dep.isClosed = true; fs.writeFileSync(file, '; disk edit\n' + text); ui.edit(main, main.text);
  await until(async () => (await ui.command('_observe')).stale);
  assert.equal((await ui.command('_observe')).stale, true); assert.equal(ui.pending.length, 1);
  ui.dispose();
});

test('the details More phases link requests inspection of the selected term', () => {
  const sent = [];
  const node = (tag, text) => ({ tag, textContent: text, children: [], dataset: {}, listeners: {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    querySelector() { return this.children.find(child => child.tag === 'div'); },
    querySelectorAll() { return []; }, contains() { return false; }
  });
  const inspector = node('aside'), term = decodeTerm(fixtureAnswer({}).shared, 3);
  const { page } = fakeMacroPage();
  Object.assign(page, { inspector, expanded: null, selected: { properties: term }, projection: { sources: {} },
    document: { activeElement: null }, state: { busy: false }, M: Model, element: node,
    id(element, id) { element.id = id; return element; }, send: type => sent.push(type), persist() {}
  });
  page.renderInspector();
  const scopes = inspector.children.find(child => child.dataset.name === 'scopes');
  const link = scopes.querySelector('.property').children[0].children.find(child => child.id === 'more-phases');
  assert.equal(link?.tag, 'a'); assert.equal(link.textContent, 'more phases'); assert.equal(link.href, '#');
  let prevented = false;
  link.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(sent, ['morePhases']);
  page.state.busy = true; link.listeners.click({ preventDefault() {} }); assert.equal(sent.length, 1);
  page.selected.properties = null; page.renderInspector();
  assert.ok(!inspector.children.some(child => child.dataset.name === 'scopes'));
});

test('pair titles, programs and positions follow navigation, hiding, completion and errors', async () => {
  const ui = fakeStepper();
  try {
    const d = await opened(ui, 'macro-expansion.rkt'), [before, after] = ui.panels;
    assert.equal(ui.panels.length, 2); assert.equal(before.viewColumn, 2); assert.equal(after.viewColumn, 3);
    const check = (number, error = false, zero = false) => {
      assert.equal(before.projection.position, number); assert.equal(after.projection.position, number);
      const suffix = ' - macro-expansion.rkt', count = zero ? 1 : 3;
      assert.equal(before.title, `Before - Step ${number} of ${count}${suffix}`);
      const metadata = after.projection.record;
      assert.equal(after.title, `After - ${error ? 'Error' : metadata ? `[${metadata.label}] ${metadata.macro}` : 'Finished'}${suffix}`);
      assert.deepEqual(Model.sections(before.projection).map(s => s.section.id), [zero ? 'final' : `b${Math.min(number, 2)}`]);
      if (!error) assert.deepEqual(Model.sections(after.projection).map(s => s.section.id), [number === 3 || zero ? 'final' : `a${number}`]);
    };
    check(1);
    for (const [name, value, n] of [['next', undefined, 2], ['next', undefined, 3], ['next', undefined, 3],
      ['previous', undefined, 2], ['first', undefined, 1], ['previous', undefined, 1], ['last', undefined, 3], ['jump', 2, 2]]) {
      await ui.command(name, value); check(n);
    }
    // A moved pair is updated in place from either active pane.
    before.viewColumn = 5; after.viewColumn = 7; after.reveal(); await ui.command('first'); check(1);
    assert.equal(before.viewColumn, 5); assert.equal(after.viewColumn, 7);
    ui.edit(d, d.text + '; changed\n');
    for (const pane of [before, after]) assert.equal(pane.messages.filter(m => m.type === 'sourceStatus').at(-1).stale, true);
    const hide = ui.command('showAll'); await tick(); ui.answer(ui.pending[0]); await hide; check(1);
    const refresh = ui.command('refresh'); await tick();
    ui.answer(ui.pending.at(-1), a => {
      a.steps[1].kind = 'error'; a.steps[1].after = null; a.steps[1].error = 'error'; a.final = null; a.error = 'error';
      a.diagnostics.error = { message: 'bad syntax', program: a.steps[1].before, syntax: [],
        contexts: [{ label: 'Error context', section: { ...a.steps[1].before, id: 'context' } }] };
    });
    await refresh; check(1); await ui.command('next'); check(2, true); await ui.command('last'); check(3, true);
    assert.ok(Model.sections(after.projection).some(s => s.section.id === 'context'));
    after.send('select', pair('context')); await tick();
    assert.equal(after.selection.properties.kind, 'identifier');
    assert.equal(before.messages.filter(m => m.type === 'state').at(-1).selected, null);
    const zero = ui.command('refresh'); await tick(); ui.answer(ui.pending.at(-1), a => { a.steps = []; }); await zero; check(1, false, true);
    assert.equal(await ui.command('_workerCount'), 1, 'The pair owns one worker');
  } finally { ui.dispose(); }
});

test('selection, properties and binding actions stay local to each pane through completion', async () => {
  const ui = fakeStepper();
  try {
    await opened(ui);
    const paneState = pane => pane.messages.filter(m => m.type === 'state').at(-1);
    for (const position of [1, 2, 3]) {
      await ui.command('jump', position);
      for (const pane of ui.panels) {
        pane.reveal();
        const other = ui.panels.find(p => p !== pane), previousSelection = paneState(other).selected;
        const section = Model.sections(pane.projection)[0].section;
        pane.send('select', pair(section.id)); await tick();
        assert.equal(pane.selection.properties.kind, 'identifier');
        assert.deepEqual(plain(paneState(other).selected), plain(previousSelection));
        const otherProperties = paneState(other).propertiesVisible;
        await ui.command('properties');
        assert.equal(paneState(other).propertiesVisible, otherProperties, 'Properties open only in the selected pane');
        await ui.command('copyTerm'); assert.equal(ui.clipboard.at(-1), 'x');
        await ui.command('tack'); assert.equal(paneState(pane).pins.length, 1);
        assert.ok(pane.selection.related.every(p => p.sectionId === section.id));
        await ui.command('untackAll'); assert.equal(paneState(pane).pins.length, 0);
        if (position === 3 && pane === ui.panels[0]) {
          assert.ok(ui.pending[0].queries.some(q => q.mode === 'inspect' && q.position === 2), 'Finished Before inspects the last step');
        }
      }
    }
  } finally { ui.dispose(); }
});

test('restoring a moved pair adopts both saved panels without rearranging or expanding', async () => {
  const ui = fakeStepper();
  try {
    const d = await ui.source('saved.rkt');
    const before = ui.window.createWebviewPanel('racketeer.macroSteps', 'Before', {}, {}); before.viewColumn = 5;
    await ui.serializer().deserializeWebviewPanel(before, { source: d.uri.toString(), side: 'before', wholeFile: true });
    const after = ui.window.createWebviewPanel('racketeer.macroSteps', 'After', {}, {}); after.viewColumn = 7;
    await ui.serializer().deserializeWebviewPanel(after, { source: d.uri.toString(), side: 'after', wholeFile: true });
    await tick(); assert.equal(ui.pending.length, 0); assert.equal(ui.panels.length, 2);
    assert.equal(before.viewColumn, 5); assert.equal(after.viewColumn, 7);
    const refresh = ui.command('refresh'); await tick(); ui.answer(ui.pending[0]); await refresh;
    assert.equal(before.projection.position, 1); assert.equal(after.projection.position, 1);
    const beforeRevision = before.env.positionRevision, afterRevision = after.env.positionRevision;
    const oldEnvelope = { ...before.env };
    before.incoming.fire({ v: 1, type: 'ready', clientInstanceId: 'recreated-before' }); await tick();
    assert.ok(before.env.positionRevision > beforeRevision); assert.equal(after.env.positionRevision, afterRevision);
    before.incoming.fire({ ...oldEnvelope, v: 1, type: 'navigate', action: 'next', requestId: 'old-page' }); await tick();
    assert.equal(before.projection.position, 1); assert.equal(after.projection.position, 1);
    after.dispose(); assert.equal(before.closed, true);
  } finally { ui.dispose(); }
});
