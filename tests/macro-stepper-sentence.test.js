// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper sentence behavior.
'use strict';
const { sentenceCases, checkSentenceCase, sentenceFixture, moduleBinding } = require('./support/macro-sentence');
const { root, plain, load } = require('./support/macro-common');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Model = require('../vscode/macro-view/model');
const { fakeMacroConnections } = require('./support/macro-page');
const { pair } = require('./support/macro-fixtures');
const { fakeTimers } = require('./support/macro-stepper');
const { pageScripts } = require('./support/macro-page-startup');

for (const entry of sentenceCases) test(`binding sentence: ${entry[0]}`, () => checkSentenceCase(entry));

test('sentence checks reject broken wording, pane numbers and missing qualifications', () => {
  const source = fs.readFileSync(path.join(root, 'vscode/macro-view/model.js'), 'utf8');
  const mutations = [
    ['refers to', 'points to'], ['is used on', 'is used near'], ['is not used here', 'has no uses'],
    ['comes from', 'originates in'], ['sentence += ` as ', 'sentence += ` named '], [', imported', ', brought'],
    ["binding.originalName !== section.text.slice(...occurrence.range)", 'true'],
    ["through !== origin", 'true'], ['is not bound here', 'has no binding'],
    ['lineNumber(section, occurrence)', '(Number(lineNumber(section, occurrence)) + 1)'],
    ['occurrence.macroScopeGroup > 0', 'occurrence.macroScopeGroup < 0'],
    ['at compile time', 'at runtime'], ['for documentation only', 'for labels'],
    ['at phase ${phase}', 'in phase ${phase}'],
    ["return sentence + '.'", "return sentence + ' (not yet certain at this step).'"],
    ["return sentence + '.'", "return sentence"]
  ];
  for (const [from, to] of mutations) {
    assert.ok(source.includes(from), from);
    const model = load({}, 'vscode/macro-view/model.js', { 'vscode/macro-view/model.js': source.replace(from, to) });
    assert.throws(() => sentenceCases.forEach(entry => checkSentenceCase(entry, model.bindingSentence)), assert.AssertionError, from);
  }
});

for (const side of ['before', 'after']) test(`${side} hover sentences follow names, then selection or tacks, and announce the same text`, () => {
  const pane = fakeMacroConnections(side), { page, handlers } = pane;
  pane.render(sentenceFixture(side));
  const section = Model.sections(page.projection)[0].section;
  const hover = id => handlers.onMouseMove({ target: { position: page.editorModel.getPositionAt(page.partsBySection.get(section.id).offset(section.occurrences.find(o => o.id === id).range[0])) } });
  const check = expected => {
    assert.equal(page.connections.textContent, expected);
    assert.equal(pane.observe().bindingSentence, expected);
    assert.equal(pane.observe().bindingAnnouncement, expected);
  };
  page.connectionsList(); check('');
  hover('use'); check('`tmp` on line 22 refers to `tmp` on line 21.');
  hover('binder'); check('`tmp` on line 21 is used on lines 22 and 23.');
  for (const certainty of ['possible', 'definite']) {
    section.edges.forEach(edge => { edge.certainty = certainty; });
    hover('use'); check('`tmp` on line 22 refers to `tmp` on line 21.');
    hover('binder'); check('`tmp` on line 21 is used on lines 22 and 23.');
  }
  page.selected = { selected: pair(section.id, 'unused') };
  hover('use'); check('`tmp` on line 22 refers to `tmp` on line 21.');
  handlers.onMouseLeave(); check('`unused` on line 24 is not used here.');
  page.selected = {}; page.state.selected = null; page.state.pins = [pair(section.id, 'binder')];
  page.connectionsList(); check('`tmp` on line 21 is used on lines 22 and 23.');
  page.state.pins = []; page.connectionsList(); check('');
});

test('sentences in error contexts use the displayed numbering, restarting at one per section', () => {
  const pane = fakeMacroConnections('after'), p = sentenceFixture('before'), section = p.record.before;
  const padding = { ...section, id: 'padding', text: '\n'.repeat(80), occurrences: [], edges: [], binderOccurrences: [] };
  p.record = { ...p.record, kind: 'error', after: null, error: 'd' }; p.error = 'd';
  p.diagnostics.d = { message: 'failure', program: padding, syntax: [section], contexts: [] };
  pane.render(p);
  const { page } = pane;
  const part = page.partsBySection.get(section.id), use = section.occurrences.find(o => o.id === 'use');
  const position = page.editorModel.getPositionAt(part.offset(use.range[0]));
  assert.ok(position.lineNumber > 80, 'The model line includes earlier error contexts');
  assert.equal(pane.options.lineNumbers(position.lineNumber), '22');
  pane.handlers.onMouseMove({ target: { position } });
  assert.equal(page.connections.textContent, '`tmp` on line 22 refers to `tmp` on line 21.');
});

test('hover inspections debounce, cache facts, ignore departed names and cancel across positions', async () => {
  const timers = fakeTimers(), pane = fakeMacroConnections('before'), { page, handlers } = pane, sent = [];
  Object.assign(page, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    send: (type, target) => sent.push({ type, target: plain(target) }) });
  pane.render(sentenceFixture());
  const section = page.projection.record.before;
  const hover = id => handlers.onMouseMove({ target: { position: page.editorModel.getPositionAt(page.partsBySection.get(section.id).offset(section.occurrences.find(o => o.id === id).range[0])) } });
  hover('import'); await timers.advance(100); hover('renamed'); await timers.advance(149);
  assert.deepEqual(sent, []); assert.equal(page.connections.textContent, '');
  await timers.advance(1);
  assert.deepEqual(sent, [{ type: 'inspect', target: pair('b1', 'renamed') }]);
  page.connectionsList(); await timers.advance(200); assert.equal(sent.length, 1, 'One inspection while a request is pending');
  hover('use');
  page.receiveBindingFacts({ target: pair('b1', 'renamed'), bindings: [moduleBinding] });
  assert.equal(page.connections.textContent, '`tmp` on line 22 refers to `tmp` on line 21.', 'A delayed import answer cannot replace the hovered use');
  hover('renamed');
  assert.equal(page.connections.textContent, '`alias` comes from `racket/private/cond` as `unless`, imported through `racket/base`.');
  assert.equal(page.live.textContent, page.connections.textContent);
  await timers.advance(200); assert.equal(sent.length, 1, 'Cached facts need no worker request');
  hover('unbound'); handlers.onMouseLeave(); await timers.advance(200); assert.equal(sent.length, 1, 'Mouse leave cancels inspection');
  hover('import'); pane.render(sentenceFixture()); await timers.advance(200); assert.equal(sent.length, 1, 'A new position cancels inspection');
  hover('unbound'); await timers.advance(150);
  page.receiveBindingFacts({ target: pair('b1', 'unbound'), bindings: [{ phase: 0, status: 'absent' }] });
  assert.equal(page.connections.textContent, '`zzz` is not bound here.');
  assert.deepEqual(plain(page.selected), { selected: null, related: [], syntaxId: null, properties: null }, 'Hover inspection preserves selection');
});

test('the sentence is a visible bottom paragraph in the editor font and theme foreground', () => {
  const source = pageScripts().filter(([file]) => !/\/(model|geometry|protocol|monaco)\.js$/.test(file)).map(([, source]) => source).join('\n');
  const css = fs.readFileSync(path.join(root, 'vscode/macro-view/view.css'), 'utf8');
  assert.match(source, /const connections = id\(element\('p', ''\), 'connections'\)/);
  assert.match(source, /app.append\(banner, note, work, connections\)/);
  assert.doesNotMatch(source, /connections\.append|connections\.replaceChildren/);
  const style = css.match(/#connections\s*\{([^}]+)\}/)[1];
  assert.match(style, /color: var\(--vscode-editor-foreground\)/);
  assert.match(style, /font-family: var\(--vscode-editor-font-family\)/);
  assert.match(style, /font-size: var\(--vscode-editor-font-size\)/);
  assert.doesNotMatch(style, /position: absolute|clip-path|display: none/);
  assert.match(source, /getOption\(runtime.monaco.editor.EditorOption.fontInfo\)/, 'Language editor font settings also reach the sentence');
});
