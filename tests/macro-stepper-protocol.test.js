// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper protocol behavior.
'use strict';
const { tick } = require('./support/macro-common');
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const Protocol = require('../vscode/macro-view/protocol');
const Data = require('../vscode/macro-view-data');
const { envelope, message, pair, fixtureAnswer, project, summaryOf } = require('./support/macro-fixtures');
const { fakeStepper, opened } = require('./support/macro-stepper');

test('message authority rejects stale versions, unknown actions, injected paths, geometry and oversized data', () => {
  assert.equal(Protocol.validateAction({ v: 1, type: 'ready', clientInstanceId: 'client' }, envelope).type, 'ready');
  for (const m of [message('navigate', { action: 'next' }), message('select', pair()), message('copyTerm'),
    message('select', { sectionId: null, occurrenceId: null }), message('pin', { action: 'tack', ...pair() })]) assert.equal(Protocol.validateAction(m, envelope), m);
  for (const m of [message('navigate', { action: 'execute' }), message('copyTerm', { text: 'attack' }), message('goToSource', { path: '/tmp/file' }),
    message('pin', { action: 'tack', ...pair(), geometry: [] }), message('navigate', { action: 'next', generation: 1 }),
    message('navigate', { action: 'next', positionRevision: 2 }), message('copyTerm', { v: 2 }),
    message('setRelation', { relation: 'bound' }), message('cancel'), message('presentation', { drawArrows: false }), message('pin', { action: 'untack', ...pair() }), message('copyTerm', { requestId: 'x'.repeat(17000) }),
    message('presentation', { splitFraction: 2 }), { v: 1, type: 'ready', clientInstanceId: 'c', path: '/tmp' }]) assert.throws(() => Protocol.validateAction(m, envelope));
});

test('acknowledged chunk protocol atomically commits Unicode, rejects missing, duplicate and out-of-order chunks', () => {
  const value = { value: '😀\r\n"\\'.repeat(40000) }, encoded = Protocol.chunks(value);
  assert.ok(encoded.chunks.length > 1);
  const begin = { transferId: 't', payloadKind: 'position', totalBytes: encoded.totalBytes, chunkCount: encoded.chunks.length };
  const receive = new Protocol.Receiver();
  assert.equal(receive.begin(begin), -1);
  encoded.chunks.forEach((chunk, sequence) => {
    const msg = message('positionChunk', { transferId: 't', sequence, chunk });
    assert.ok(Protocol.bytes(JSON.stringify(msg)) <= Protocol.CHUNK);
    assert.equal(receive.chunk(msg), sequence);
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/);
  });
  assert.deepEqual(receive.commit({ transferId: 't', totalBytes: encoded.totalBytes }).value, value);
  receive.begin(begin); assert.throws(() => receive.commit({ transferId: 't', totalBytes: encoded.totalBytes }), /Incomplete/);
  receive.begin(begin); assert.throws(() => receive.chunk({ transferId: 't', sequence: 1, chunk: 'x' }), /Out of order/);
  receive.begin(begin); receive.chunk({ transferId: 't', sequence: 0, chunk: encoded.chunks[0] });
  assert.throws(() => receive.chunk({ transferId: 't', sequence: 0, chunk: encoded.chunks[0] }), /Out of order/);
  receive.begin(begin); receive.abort(); assert.throws(() => receive.commit({ transferId: 't', totalBytes: encoded.totalBytes }));
  assert.throws(() => receive.begin({ ...begin, totalBytes: Protocol.LIMIT + 1 }));
  receive.begin(begin); receive.begin({ ...begin, transferId: 'new' });
  assert.throws(() => receive.chunk({ transferId: 't', sequence: 0, chunk: 'x' }));
});

test('stale action envelopes cannot copy, navigate or open a source; source actions derive locations from terms', async () => {
  const ui = fakeStepper(); await opened(ui); const p = ui.panels[0];
  p.send('select', pair()); await tick();
  const stale = { ...p.env };
  await ui.command('next');
  for (const type of ['copyTerm', 'goToSource', 'navigate']) p.incoming.fire({ ...stale, type, v: 1, requestId: 'stale', action: 'next' });
  await tick(); assert.equal(p.projection.position, 2); assert.deepEqual(ui.clipboard, []);
  p.send('select', pair('b2')); await tick();
  const n = ui.window.visibleTextEditors.length;
  p.send('goToSource'); await tick();
  assert.ok(ui.window.visibleTextEditors.length > n);
  assert.equal(ui.window.activeTextEditor.document.uri.toString(), ui.workspace.textDocuments[0].uri.toString());
  ui.dispose();
});

test('host messages also enforce version, revision, allowlisted fields and safe geometry settings', () => {
  const m = message('positionBegin', { transferId: 't', payloadKind: 'position', totalBytes: 1, chunkCount: 1 });
  assert.equal(Protocol.validateHost(m, envelope), m);
  for (const bad of [{ ...m, v: 2 }, { ...m, generation: 1 }, { ...m, sessionId: 'other' },
    { ...m, positionRevision: 1 }, { ...m, injectedHtml: '<p>' }, message('unknown'),
    message('init', { editorSettings: { tabSize: 'expression', lineHeight: 0 } })]) assert.throws(() => Protocol.validateHost(bad, envelope));
  assert.throws(() => Protocol.validateHost(message('positionChunk', { transferId: 't', sequence: 0, chunk: 'x'.repeat(Protocol.CHUNK) }), envelope));
});

test('missing transfer acknowledgements time out, suggest Refresh and never queue more chunks', async () => {
  const ui = fakeStepper({ timeoutMs: 20 }); await opened(ui); const p = ui.panels[0];
  p.ack = false; const chunksBefore = p.messages.filter(m => m.type === 'positionChunk').length;
  await ui.command('next');
  assert.equal(p.messages.filter(m => m.type === 'positionChunk').length, chunksBefore);
  assert.ok(p.messages.some(m => m.type === 'transferAbort' && m.retryable && /timed out/.test(m.reason)));
  p.ack = true; const refresh = ui.command('refresh'); await tick(); ui.answer(ui.pending.at(-1)); await refresh; assert.equal(p.projection.position, 1);
  ui.dispose();
});

test('navigation abandons an in-flight position and stale acknowledgements cannot commit it', async () => {
  const ui = fakeStepper(); await opened(ui); const p = ui.panels[0];
  p.ack = false; const first = ui.command('next'); await tick();
  const old = p.messages.filter(m => m.type === 'positionBegin').at(-1), env = { ...p.env };
  p.ack = true; await ui.command('last'); await first;
  p.incoming.fire({ ...env, v: 1, type: 'transferAck', requestId: 'late', transferId: old.transferId, lastSequence: -1, success: true });
  await tick(); assert.equal(p.projection.position, 3); assert.equal(p.projection.final.id, 'final');
  assert.equal(ui.pending.length, 1); ui.dispose();
});

test('a large requested position round-trips complete programs through bounded chunks', () => {
  const a = fixtureAnswer({}), program = '(x x)\n' + '; expansion context\n'.repeat(9000);
  const p = project(a, 1);
  p.record.before.text = program; p.record.after.text = program;
  const encoded = Protocol.chunks(p);
  assert.ok(encoded.chunks.length > 1);
  const receiver = new Protocol.Receiver(Data.validateProjection);
  receiver.begin({ transferId: 'large', payloadKind: 'position', totalBytes: encoded.totalBytes, chunkCount: encoded.chunks.length });
  encoded.chunks.forEach((chunk, sequence) => receiver.chunk(message('positionChunk', { transferId: 'large', sequence, chunk })));
  const actual = receiver.commit({ transferId: 'large', totalBytes: encoded.totalBytes }).value;
  assert.equal(actual.record.after.text, program); assert.equal(actual.steps, undefined);
});

test('position replies validate snapshots, complete sections, count and error ownership', () => {
  const a = fixtureAnswer({ sourceHash: '0'.repeat(64), sourceVersion: 1 });
  const summary = summaryOf(a), p = project(a, 1);
  Data.validatePosition(p, summary, 1);
  for (const change of [p => p.count++, p => p.position++, p => p.snapshot = { ...p.snapshot, sourceVersion: 2 },
    p => p.record.after = null, p => p.record.before.occurrences[0].syntaxId = 'missing',
    p => p.record.before.edges[0].reference = 'missing']) {
    const bad = structuredClone(p); change(bad); assert.throws(() => Data.validatePosition(bad, summary, 1));
  }
  assert.throws(() => Data.validateAnswer({ ...summary, stepCount: 99 }, a.snapshot));
  assert.throws(() => Data.validateAnswer({ ...summary, steps: a.steps }, a.snapshot));
});

test('the shipped page initializes editor settings and commits positions, selections and colors through its message listener', () => {
  const { fakeMacroPage } = require('./support/macro-page');
  const { plain } = require('./support/macro-common');
  const frames = [];
  let themeChanged, themes = 0;
  const pane = fakeMacroPage('before', { globals: {
    MutationObserver: class { constructor(callback) { themeChanged = callback; } observe() {} },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; }
  } }), { page, editor, messages, listeners, options } = pane;
  Protocol.validateAction(messages[0], {});
  page.env = undefined;
  page.monaco.editor.defineTheme = () => { themes++; };
  const host = (type, fields = {}) => listeners.get('message')({ data: { ...envelope, requestId: 'host', type, ...fields } });
  host('init', { source: 'untitled:page', wholeFile: true, testEnabled: true, editorSettings: { tabSize: 4, fontSize: 19, lineHeight: 0 } });
  assert.deepEqual(plain(page.env), { sessionId: envelope.sessionId, generation: envelope.generation, positionRevision: envelope.positionRevision });
  assert.equal(page.state.source, 'untitled:page');
  const transfer = (value, payloadKind, transferId) => {
    const encoded = Protocol.chunks(value);
    host('positionBegin', { payloadKind, transferId, totalBytes: encoded.totalBytes, chunkCount: encoded.chunks.length });
    encoded.chunks.forEach((chunk, sequence) => host('positionChunk', { transferId, sequence, chunk }));
    host('positionCommit', { transferId, totalBytes: encoded.totalBytes });
    assert.equal(messages.findLast(m => m.type === 'transferAck').success, true);
  };
  const projection = { ...project(fixtureAnswer({}), 1), pane: 'before' };
  transfer(projection, 'position', 'program');
  assert.equal(page.editorModel.getValue(), projection.record.before.text);
  assert.equal(options.fontSize, 19);
  while (frames.length) frames.shift()();
  assert.equal(messages.findLast(m => m.type === 'rendered').mounted, true);
  assert.deepEqual(plain(messages.findLast(m => m.type === 'rendered').sections), ['b1']);
  editor.setPosition({ lineNumber: 1, column: 2 });
  transfer({ selected: pair(), related: [], syntaxId: 'x', properties: null }, 'selection', 'selected');
  assert.deepEqual(plain(page.selected.selected), pair());
  transfer({ tokenSections: {}, tokenStyles: [{ foreground: '#123456', fontStyle: 0 }], themeName: 'Changed' }, 'colors', 'colors');
  assert.equal(page.themeName, 'Changed');
  const previous = themes;
  themeChanged();
  assert.equal(themes, previous + 1);
  assert.equal(options.fontSize, 19);
  host('sourceStatus', { stale: true, reason: 'Source changed', refreshAvailable: true });
  assert.match(page.banner.textContent, /Source changed/);
  host('actionResult', { message: 'Selection ready' });
  assert.equal(page.live.textContent, 'Selection ready');
});

test('a replacement page receives a fresh position transfer through the navigation interface', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  await ui.command('next');
  const panel = ui.panels[0];
  panel.messages.length = 0;
  panel.incoming.fire({ v: 1, type: 'ready', clientInstanceId: 'replacement' });
  await tick(); await tick();
  assert.equal(panel.messages.filter(m => m.type === 'init').length, 1);
  const positions = panel.messages.filter(m => m.type === 'positionBegin' && m.payloadKind === 'position');
  assert.equal(positions.length, 1, 'Replacement pages receive a newly transferred position');
  assert.ok(panel.messages.some(m => m.type === 'positionCommit' && m.transferId === positions[0].transferId));
  assert.equal(panel.projection.position, 2);
});
