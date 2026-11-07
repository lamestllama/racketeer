// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks kept edge groups and immediate remembered arrow controls across panes.
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { fakeMacroConnections } = require('./support/macro-page');
const { pair } = require('./support/macro-fixtures');
const { tick, plain } = require('./support/macro-common');
const Model = require('../vscode/macro-view/model');
const Protocol = require('../vscode/macro-view/protocol');

const stateOf = panel => panel.messages.filter(m => m.type === 'state').at(-1);
function connect(panel) {
  const pane = fakeMacroConnections(panel.projection.pane);
  pane.page.env = { ...panel.env };
  pane.render(panel.projection);
  const post = panel.webview.postMessage;
  panel.webview.postMessage = async message => {
    await post(message);
    if (message.type === 'state') pane.listeners.get('message')({ data: message });
    return true;
  };
  pane.listeners.get('message')({ data: stateOf(panel) });
  return pane;
}
async function select(panel, occurrenceId) {
  panel.reveal();
  const section = Model.sections(panel.projection)[0].section;
  const target = pair(section.id, occurrenceId);
  panel.send('select', target); await tick();
  return target;
}

test('Release Kept Arrows releases incident edges through either endpoint and leaves unrelated groups', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await ui.source('fan'); const opening = ui.open(true); await tick();
  ui.answer(ui.pending[0], answer => {
    for (const section of [...answer.steps.flatMap(step => [step.before, step.after]), answer.final]) {
      section.text = '(x x x x x)\n';
      section.occurrences[0].range = [0, 11]; section.occurrences[0].delimiterRanges = [[0, 1], [10, 11]];
      for (const [id, offset] of [['s', 5], ['c', 7], ['t', 9]]) {
        section.occurrences.push({ ...section.occurrences[2], id, range: [offset, offset + 1] });
      }
      section.binderOccurrences.push('c');
      section.edges.push({ ...section.edges[0], id: 'fan', reference: 's' },
        { ...section.edges[0], id: 'other', binder: 'c', reference: 't' });
    }
  });
  await opening;
  const panel = ui.panels[0], pane = connect(panel), section = Model.sections(panel.projection)[0].section;
  const kept = () => Model.keptEdges(pane.page.projection, pane.page.state.pins, section.id).map(e => e.id).sort();
  await select(panel, 'b'); await ui.command('tack');
  await select(panel, 'c'); await ui.command('tack');
  assert.deepEqual(plain(kept()), ['edge', 'fan', 'other']);
  pane.page.hover = null;
  assert.equal(pane.observe().arrows.length, 3);
  await select(panel, 'r');
  assert.equal(ui.contexts['racketdap.macroSteps.hasKeptArrows'], true);
  assert.equal(ui.contexts['racketdap.macroSteps.canKeepArrows'], false);
  pane.page.hover = pair(section.id, 'r');
  await ui.command('release');
  assert.deepEqual(plain(kept()), ['fan', 'other']);
  assert.equal(pane.observe().arrows.length, 3, 'Released hovered edge remains transient');
  pane.page.hover = null;
  assert.equal(pane.observe().arrows.length, 2);
  await select(panel, 'b');
  assert.equal(ui.contexts['racketdap.macroSteps.hasKeptArrows'], true);
  assert.equal(ui.contexts['racketdap.macroSteps.canKeepArrows'], true, 'A partially kept fan enables both actions');
  pane.page.setTermContext(pane.page.syntax, pair(section.id, 'b'));
  const context = JSON.parse(pane.page.syntax.getAttribute('data-vscode-context'));
  assert.equal(context['racketdap.macroSteps.hasKeptArrows'], true);
  assert.equal(context['racketdap.macroSteps.canKeepArrows'], true);
  await ui.command('alwaysSuffixMarkedIdentifiers');
  assert.deepEqual(plain(kept()), ['fan', 'other'], 'Suffix redraw preserves the remaining kept subset');
  await ui.command('tack'); assert.deepEqual(plain(kept()), ['edge', 'fan', 'other']);
  await ui.command('release'); assert.deepEqual(plain(kept()), ['other']);
  await select(panel, 't'); await ui.command('release'); assert.deepEqual(plain(kept()), []);
  await select(panel, 'b'); await ui.command('tack'); await ui.command('next');
  assert.deepEqual(plain(stateOf(panel).pins), [], 'A step change clears kept edges');
});

test('Draw Binding Arrows changes every open pane immediately and preserves other display behaviour', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui, 'A'); await opened(ui, 'B');
  const panes = ui.panels.map(connect);
  for (const [i, panel] of ui.panels.entries()) {
    const target = await select(panel, 'b'); await ui.command('tack');
    panes[i].page.focusPair(target); panes[i].page.connectionsList();
    panes[i].page.tokenSections = { [target.sectionId]: [{ start: 1, end: 2, style: 0, group: 1 }] };
  }
  const before = panes.map(pane => ({ decorations: plain(pane.page.editorModel.getAllDecorations()),
    selected: plain(pane.page.selected), sentence: pane.page.connections.textContent,
    tokens: plain(pane.page.tokenSections), projection: pane.page.projection }));
  const requests = ui.pending.map(worker => worker.queries.length);
  await ui.command('drawBindingArrows');
  assert.equal(ui.settings.get('racketdap.macroSteps.drawBindingArrows'), false);
  for (const [i, pane] of panes.entries()) {
    assert.equal(pane.page.state.drawBindingArrows, false);
    assert.deepEqual(plain(pane.page.state.pins), []);
    assert.equal(pane.page.drawn.length, 0, 'State delivery purges the overlay before another frame');
    assert.equal(pane.page.arrowLayer.querySelectorAll('text').length, 0);
    assert.equal(pane.page.arrowLayer.children.some(n => n.attributes.class?.startsWith('binding-arrow')), false);
    assert.ok(pane.page.boxes.length, 'Hover boxes remain');
    assert.deepEqual(plain(pane.page.selected), before[i].selected);
    assert.equal(pane.page.connections.textContent, before[i].sentence);
    assert.equal(pane.page.projection, before[i].projection);
    assert.deepEqual(plain(pane.page.tokenSections), before[i].tokens);
    assert.deepEqual(plain(pane.page.editorModel.getAllDecorations()), before[i].decorations,
      'Binder underlines, occurrence highlights, change backgrounds and hover decorations remain');
    assert.equal(pane.page.drawn.length, 0);
    assert.equal(stateOf(ui.panels[i]).pins.length, 0);
  }
  assert.deepEqual(ui.pending.map(worker => worker.queries.length), requests, 'The toggle never rebuilds terms');
  await opened(ui, 'C');
  for (const panel of ui.panels.slice(-2)) assert.equal(stateOf(panel).drawBindingArrows, false, 'New panes use the saved setting');
  await ui.command('drawBindingArrows');
  for (const pane of panes) {
    assert.equal(pane.page.drawn.length, 1, 'Enabling redraws immediately from the current hover');
    assert.equal(pane.page.state.pins.length, 0, 'Cleared kept arrows stay cleared');
    pane.page.hover = null; pane.page.draw(); assert.equal(pane.page.drawn.length, 0);
  }
  ui.setSetting('racketdap.macroSteps.drawBindingArrows', false); await tick();
  for (const panel of ui.panels) assert.equal(stateOf(panel).drawBindingArrows, false, 'Settings editor updates reach every pane');
});

test('arrow state and release actions validate their protocol fields', () => {
  const envelope = { v: 1, sessionId: 's', generation: 1, positionRevision: 1, requestId: 'r' };
  const state = { ...envelope, type: 'state', position: 1, count: 1, selected: null,
    pins: [{ ...pair(), edgeIds: ['edge'] }], drawBindingArrows: false };
  assert.doesNotThrow(() => Protocol.validateHost(state));
  assert.throws(() => Protocol.validateHost({ ...state, drawBindingArrows: 'false' }));
  assert.throws(() => Protocol.validateHost({ ...state, pins: [{ ...pair(), edgeIds: [42] }] }));
  const action = { ...envelope, type: 'pin', action: 'release', ...pair() };
  assert.doesNotThrow(() => Protocol.validateAction(action, envelope));
  assert.throws(() => Protocol.validateAction({ ...action, occurrenceId: null }, envelope));
});
