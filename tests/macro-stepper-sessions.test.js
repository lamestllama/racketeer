// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper sessions behavior.
'use strict';
const { tick, plain, load } = require('./support/macro-common');
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const Data = require('../vscode/macro-view-data');
const { decodeTerm } = require('../vscode/macro-stepper-codec');
const { fakeStepper, opened, fakeTimers } = require('./support/macro-stepper');
const { pair } = require('./support/macro-fixtures');
const { fakeSession } = require('./support/macro-worker');

test('the global queue bounds expansions and resident sessions', async () => {
  const ui = fakeStepper();
  await ui.source('A'); const a = ui.open(true); await tick();
  await ui.source('B'); const b = ui.open(true); await tick();
  await ui.source('C'); const c = ui.open(true); await tick();
  assert.equal(ui.pending.length, 2);
  ui.answer(ui.pending[0]); ui.answer(ui.pending[1]); await a; await b; await tick();
  assert.equal(ui.pending.length, 3);
  assert.equal(ui.pending.filter(p => !p.stopped).length, 2);
  assert.ok(ui.pending.slice(0, 2).some(p => p.stopped));
  ui.answer(ui.pending[2]); await c;
  ui.dispose();
});

test('closing a queued expansion removes it before a worker starts', async () => {
  const ui = fakeStepper();
  await ui.source('A'); const a = ui.open(true); await tick();
  await ui.source('B'); const b = ui.open(true); await tick();
  await ui.source('C'); const c = ui.open(true); await tick();
  assert.equal(ui.pending.length, 2);
  ui.panels[4].dispose(); await tick(); await c;
  assert.equal(ui.panels[4].closed, true);
  ui.answer(ui.pending[0]); ui.answer(ui.pending[1]); await a; await b;
  assert.equal(ui.pending.length, 2); ui.dispose();
});

test('recent positions use LRU eviction and a total byte bound', () => {
  const cache = new Data.RecentCache(3, 100);
  for (let n = 1; n <= 3; n++) cache.set(n, { position: n });
  assert.equal(cache.get(1).position, 1);
  cache.set(4, { position: 4 });
  assert.equal(cache.get(2), undefined); assert.equal(cache.entries.size, 3);
  cache.set(5, 'x'.repeat(80)); assert.ok(cache.bytes <= 100);
  cache.set(6, 'x'.repeat(100)); assert.equal(cache.get(6), undefined);
  cache.clear(); assert.equal(cache.entries.size, 0); assert.equal(cache.bytes, 0);
});

test('navigation fetches only misses and selection requests inspection', async () => {
  const ui = fakeStepper();
  try {
    await opened(ui); const process = ui.pending[0], p = ui.panels[0];
    assert.deepEqual(process.queries.map(q => q.mode), ['position']);
    await ui.command('next'); await ui.command('first'); await ui.command('last'); await ui.command('first');
    assert.deepEqual(process.queries.map(q => q.position), [1, 2, 3]);
    p.send('select', pair()); await tick();
    assert.equal(process.queries.at(-1).mode, 'inspect'); assert.equal(process.queries.at(-1).phases, undefined);
    assert.ok(p.selection.properties.scopes); const count = process.queries.length;
    p.send('select', pair('a1')); await tick(); assert.equal(process.queries.length, count);
    const refresh = ui.command('refresh'); await tick(); assert.equal(process.stopped, true);
    ui.answer(ui.pending[1]); await refresh;
    assert.deepEqual(ui.pending[1].queries.map(q => q.mode), ['position']);
    p.dispose(); assert.equal(ui.pending[1].stopped, true);
  } finally { ui.dispose(); }
});

test('session framing resets the 64 MiB answer budget and serializes requests', async () => {
  const f = fakeSession();
  try {
    const first = f.session.start();
    f.reply('{"mode":"sum'); f.reply('mary"}\n'); assert.equal((await first).mode, 'summary');
    const a = f.session.request({ mode: 'position', position: 1 }), b = f.session.request({ mode: 'position', position: 2 });
    await tick(); assert.equal(f.sent.length, 1);
    // Together these replies exceed 64 MiB. Each remains within its own budget.
    const wire = JSON.stringify({ text: 'x'.repeat(34 * 1024 * 1024) }) + '\n';
    f.reply(wire); assert.equal((await a).text.length, 34 * 1024 * 1024);
    await tick(); assert.equal(f.sent.length, 2);
    f.reply(wire); assert.equal((await b).text.length, 34 * 1024 * 1024);
  } finally { await f.session.stop(); }
});

test('idle expiry, query timeout and malformed replies close and reject the fake session', async () => {
  const idle = fakeSession({ idleMs: 20 });
  const first = idle.session.start(); idle.reply('{}\n'); await first;
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(idle.stopped, 1);
  await assert.rejects(idle.session.request({ mode: 'position' }), /expired/);
  for (const malformed of [true, false]) {
    const f = fakeSession({ queryMs: 20 });
    const opening = f.session.start(); f.reply('{}\n'); await opening;
    const pending = f.session.request({ mode: 'inspect' }); await tick();
    if (malformed) f.reply('invalid\n');
    await assert.rejects(pending, malformed ? /unreadable/ : /timed out/);
    assert.equal(f.stopped, 1);
  }
});

test('deactivation and panel closure reject pending position and inspection requests', async () => {
  for (const inspect of [false, true]) {
    const f = fakeSession(); const first = f.session.start(); f.reply('{}\n'); await first;
    const pending = f.session.request({ mode: inspect ? 'inspect' : 'position' }); await tick();
    const rejected = assert.rejects(pending, /closed/); await f.session.stop(); await rejected;
    assert.equal(f.stopped, 1);
  }
  const ui = fakeStepper(); await opened(ui); ui.dispose(); assert.ok(ui.pending.every(p => p.stopped));
});

test('standalone inspection codec preserves zero, nullable coordinates, defaults and label phase', () => {
  const shared = ['label', { sourceId: null, line: 0, column: 0 }, { phase: [0] }, [[2]],
    [[0]], { kind: 'compound', source: [1], scopes: [3], inspectedPhases: [4] }];
  Data.validateShared(shared);
  const term = decodeTerm(shared, 5);
  assert.equal(term.name, null); assert.equal(term.source.line, 0); assert.equal(term.source.column, 0);
  assert.equal(term.source.position, null); assert.equal(term.symbolStatus, 'not-applicable');
  assert.equal(term.scopes[0].phase, 'label'); assert.equal(term.scopes[0].status, 'known');
  assert.deepEqual(term.scopes[0].scopes, []); assert.deepEqual(term.bindings, []);
  assert.equal(term.builtins.tamperStatus, 'unarmed'); assert.deepEqual(term.properties, []);
  assert.throws(() => decodeTerm(shared, -1), /Invalid shared index/);
});

test('an oversized session answer rejects the pending request and closes its lease', async () => {
  const f = fakeSession(), opening = f.session.start();
  const rejected = assert.rejects(opening, /exceeds 64 MiB/);
  for (let n = 0; n < 65; n++) f.reply('x'.repeat(1024 * 1024));
  await rejected; assert.equal(f.stopped, 1);
});

test('two live sessions across views use LRU order, preserve printed state, and restore the captured snapshot on return', async () => {
  const ui = fakeStepper();
  try {
    const source = await opened(ui, 'A'), a = ui.panels[0], first = ui.pending[0];
    await ui.command('next'); await ui.command('last'); a.send('select', pair('b2')); await tick();
    a.send('pin', { action: 'tack', ...pair('b2') }); await tick();
    const printed = a.projection, selection = plain(a.selection.selected), before = await ui.command('_observe');
    await opened(ui, 'B'); const second = ui.pending[1];
    a.reveal(); await tick(); // A is most recently used, even without a worker query.
    await opened(ui, 'C');
    assert.equal(first.stopped, false); assert.equal(second.stopped, true);
    assert.equal(await ui.command('_workerCount'), 2);
    await opened(ui, 'D');
    assert.equal(first.stopped, true); assert.equal(await ui.command('_workerCount'), 2);
    assert.equal(a.projection, printed); assert.deepEqual(plain(a.selection.selected), selection);
    a.reveal(); await tick();
    let s = await ui.command('_observe');
    assert.equal(s.position, 3); assert.equal(s.workerSession, null);
    assert.deepEqual(plain(s.pins), plain(before.pins)); assert.equal(s.generation, before.generation);
    ui.edit(source, '; current buffer differs\n' + source.text);
    const returning = ui.command('morePhases'); await tick(); const replacement = ui.pending.at(-1);
    assert.equal(ui.pending.length, 5); assert.equal(await ui.command('_workerCount'), 2);
    assert.equal(replacement.request.text, first.request.text);
    assert.deepEqual(plain(replacement.request.snapshot), plain(first.request.snapshot));
    ui.answer(replacement); await returning;
    s = await ui.command('_observe');
    assert.equal(s.position, 3); assert.equal(s.generation, before.generation); assert.equal(s.revision, before.revision);
    assert.deepEqual(plain(s.pins), plain(before.pins)); assert.deepEqual(plain(s.selection), selection);
    assert.equal(a.projection, printed); assert.ok(s.properties); assert.equal(s.stale, true);
    a.dispose(); for (const p of ui.panels.slice(1)) p.dispose(); await tick();
    assert.equal(await ui.command('_workerCount'), 0, 'Count works after the last panel is closed');
  } finally { ui.dispose(); }
});

test('session admission awaits worker reaping before starting a third process', async () => {
  const ui = fakeStepper({ stopDelay: true });
  try {
    await opened(ui, 'A'); await opened(ui, 'B');
    await ui.source('C'); const opening = ui.open(true); await tick();
    assert.equal(ui.pending.length, 2); assert.equal(ui.pending[0].stopped, true);
    assert.equal(await ui.command('_workerCount'), 2, 'Stopping sessions remain tracked until exit');
    ui.pending[0].reap(); await tick();
    assert.equal(ui.pending.length, 3); assert.equal(await ui.command('_workerCount'), 2);
    ui.answer(ui.pending[2]); await opening;
  } finally {
    ui.dispose(); for (const p of ui.pending) p.reap?.(); await tick();
  }
});

test('hidden views expire after 60 seconds, visible inactive views stay resident, and on-demand navigation restores them', async () => {
  const timers = fakeTimers(), ui = fakeStepper({ timers });
  try {
    await opened(ui, 'A'); const a = ui.panels[0], first = ui.pending[0], printed = a.projection;
    await opened(ui, 'B');
    assert.equal(a.active, false); assert.equal(a.visible, true);
    await timers.advance(60001); assert.equal(first.stopped, false, 'Visibility differs from keyboard focus');
    a.visible = false; ui.panels[1].visible = false; a.viewState.fire();
    await timers.advance(59999); assert.equal(first.stopped, false);
    a.visible = true; a.viewState.fire();
    await timers.advance(60001); assert.equal(first.stopped, false, 'Returning cancels hidden expiry');
    a.visible = false; ui.panels[1].visible = false; a.viewState.fire();
    await timers.advance(59999); assert.equal(first.stopped, false);
    await timers.advance(1); assert.equal(first.stopped, true);
    assert.equal(await ui.command('_workerCount'), 1); assert.equal(a.projection, printed);
    a.reveal(); await tick();
    const generation = (await ui.command('_observe')).generation, notifications = ui.progress.length;
    const returning = ui.command('next'); await tick();
    assert.equal(ui.pending.length, 3); assert.equal(ui.progress.length, notifications);
    await timers.advance(499); assert.equal(ui.progress.length, notifications);
    await timers.advance(1); assert.equal(ui.progress.length, notifications + 1, 'Slow restore reports progress after half a second');
    ui.answer(ui.pending[2]); await returning;
    assert.equal(a.projection.position, 2); assert.equal((await ui.command('_observe')).generation, generation);
    a.visible = false; ui.panels[1].visible = false; a.viewState.fire(); a.dispose(); await timers.advance(60000);
    assert.equal(await ui.command('_workerCount'), 1, 'Disposal clears hidden timers without recreating a worker');
  } finally { ui.dispose(); }
});

test('a fast restore stays quiet and retains fragment mode and hiding policy', async () => {
  const timers = fakeTimers(), ui = fakeStepper({ timers });
  try {
    await ui.source('fragment'); const opening = ui.open(false); await tick();
    ui.finish(ui.pending[0], { failed: 'Expected a single #lang or module' }); await tick();
    assert.equal(ui.pending[1].request.mode, 'fragment'); ui.answer(ui.pending[1]); await opening;
    const a = ui.panels[0], all = ui.command('showAll'); await tick(); ui.answer(ui.pending[1]); await all;
    await opened(ui, 'B'); await opened(ui, 'C'); a.reveal(); await tick();
    const notifications = ui.progress.length, returning = ui.command('next'); await tick();
    const replacement = ui.pending.at(-1);
    assert.equal(replacement.request.mode, 'fragment'); assert.equal(replacement.request.hiding, 'standard', 'Restoration starts with the original policy, then replays hiding changes');
    ui.answer(replacement); await returning; await timers.advance(501);
    assert.equal(replacement.queries.findLast(q => q.replay && q.mode === 'reexpand').hiding, 'none');
    assert.equal(ui.progress.length, notifications); assert.equal(a.projection.position, 2);
  } finally { ui.dispose(); }
});

test('default sessions remain resident without a request-idle deadline', async () => {
  const timers = fakeTimers();
  const { createMacroSession: createSession } = load({ __setTimeout: timers.setTimeout, __clearTimeout: timers.clearTimeout }, 'vscode/macro-steps/worker-session.js');
  const f = fakeSession({}, createSession);
  try {
    const opening = f.session.start(); f.reply('{}\n'); await opening;
    await timers.advance(60001); assert.equal(f.stopped, 0);
    const query = f.session.request({ mode: 'position' }); await tick(); f.reply('{}\n'); await query;
    assert.equal(f.sent.length, 1);
  } finally { await f.session.stop(); }
});

test('a busy least recently used session finishes its request before eviction, without evicting a newer idle view', async () => {
  const ui = fakeStepper();
  try {
    await opened(ui, 'A'); const a = ui.panels[0], first = ui.pending[0];
    a.send('select', pair()); await tick();
    first.manualInspection = true;
    const inspecting = ui.command('morePhases'); await tick();
    const query = first.queries.at(-1);
    assert.equal(query.mode, 'inspect');
    await opened(ui, 'B'); const second = ui.pending[1];
    await ui.source('C'); const opening = ui.open(true); await tick();
    assert.equal(ui.pending.length, 2, 'Admission waits for the oldest view request');
    assert.equal(first.stopped, false); assert.equal(second.stopped, false);
    ui.finish(first, { schemaVersion: 2, mode: 'inspect', snapshot: query.snapshot, position: query.position,
      term: query.term, shared: first.data.shared, termData: first.data.terms[query.term], sources: first.data.sources });
    await inspecting; await tick();
    assert.equal(first.stopped, true); assert.equal(second.stopped, false); assert.equal(ui.pending.length, 3);
    ui.answer(ui.pending[2]); await opening;
    assert.equal(await ui.command('_workerCount'), 2);
  } finally { ui.dispose(); }
});
