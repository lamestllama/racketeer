// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeStepper, opened, fakeTimers } = require('./support/macro-stepper');
const { tick, root, racket, helper, plain } = require('./support/macro-common');
const { pair, fixtureAnswer, project } = require('./support/macro-fixtures');
const { fakeMacroPage } = require('./support/macro-page');
const { request } = require('./support/macro-worker');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const Data = require('../vscode/macro-view-data');
const Protocol = require('../vscode/macro-view/protocol');
const { workerOverride } = require('./support/macro-racket-proof');

async function check(sources) {
  const timers = fakeTimers(), ui = fakeStepper({ sources, timers });
  try {
    await opened(ui);
    const source = ui.panels[0], process = ui.pending[0];
    source.send('select', pair()); await tick();
    await ui.command('alwaysSuffixMarkedIdentifiers');
    await ui.command('next');
    ui.setSetting('racketdap.macroSteps.oneTermAtATime', true);
    const original = plain(await ui.command('_observe'));
    await ui.command('duplicate');
    assert.equal(ui.pending.length, 1, 'Duplication does not start another expansion');
    assert.equal(ui.panels.length, 4);
    const copy = ui.panels[2];
    const initial = await ui.command('_observe');
    assert.equal(initial.position, 1);
    assert.equal(initial.selection, null);
    assert.equal(copy.projection.suppressSelection, true);
    assert.equal(ui.panels[3].projection.suppressSelection, true);
    assert.equal(copy.messages.filter(m => m.type === 'state').at(-1).oneTermAtATime, true);
    assert.notEqual(copy.messages.find(m => m.type === 'init').pairId, source.messages.find(m => m.type === 'init').pairId);
    assert.deepEqual(plain(initial.pins), []);
    const duplicate = process.queries.find(q => q.mode === 'duplicate');
    assert.equal(duplicate.hiding, 'none');
    assert.deepEqual(plain(duplicate.custom.rules), []);
    assert.ok(Object.entries(duplicate.custom).filter(([k]) => k !== 'rules').every(([, value]) => value));
    assert.equal(process.queries.at(-1).suffixOption, 'over-limit');
    assert.equal(process.queries.at(-1).view, duplicate.newView);
    await ui.command('last');
    source.reveal();
    assert.equal((await ui.command('_observe')).position, original.position);
    const reset = ui.command('resetMarkNumbering'); await tick(); ui.answer(process); await reset;
    assert.equal(process.queries.filter(q => q.mode === 'configure').at(-1).view, undefined);
    copy.reveal(); assert.equal((await ui.command('_observe')).position, 3);
    await ui.command('highlightRedexContractum');
    source.reveal(); assert.equal(source.projection.highlightRedexContractum, undefined);
    assert.equal(source.messages.filter(m => m.type === 'state').at(-1).highlightRedexContractum, true);
    copy.visible = ui.panels[3].visible = source.visible = ui.panels[1].visible = false;
    copy.viewState.fire(); await timers.advance(60001);
    assert.equal(process.stopped, false, 'A duplicated recording stays resident');
    source.dispose(); await tick();
    assert.equal(copy.closed, undefined); assert.equal(process.stopped, false);
    copy.reveal(); await ui.command('first'); assert.equal((await ui.command('_observe')).position, 1);
    await ui.command('duplicateCurrentTerm');
    assert.equal(ui.pending.length, 1); assert.equal(ui.panels.length, 6);
    await ui.command('removeSelectedTerm');
    assert.equal((await ui.command('_observe')).count, undefined);
    assert.equal((await ui.command('_observe')).selection, null);
    assert.equal(process.stopped, false);
    await ui.command('duplicateCurrentTerm'); assert.equal(ui.panels.length, 6);
    await ui.command('duplicate'); assert.equal(ui.panels.length, 8);
    assert.equal((await ui.command('_observe')).count, undefined);
    copy.dispose(); await tick(); assert.equal(process.stopped, true);
    const restored = [];
    for (const pairId of ['duplicate:restored-a', 'duplicate:restored-b']) {
      for (const side of ['before', 'after']) {
        const panel = ui.window.createWebviewPanel('racketeer.macroSteps', side, { viewColumn: 2 }, {});
        restored.push(panel);
        await ui.serializer().deserializeWebviewPanel(panel, { source: 'untitled:A', side, pairId, wholeFile: true });
      }
    }
    await tick();
    restored[0].dispose();
    assert.equal(restored[1].closed, true);
    assert.equal(restored[2].closed, undefined);
    assert.equal(restored[3].closed, undefined);
  } finally { ui.dispose(); }
}
test('duplicate pairs navigate independently and retain their recording until the last term is released', () => check());
test('duplication regression proof rejects inheriting the source position', async () => {
  const file = 'vscode/macro-steps/panes.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  for (const broken of [source.replace('copy.data = summary;', 'copy.position = v.position; copy.data = summary;'),
    source.replace('runtime.views.get(key), side = saved.side', 'runtime.views.get(source.toString()), side = saved.side')]) {
    assert.notEqual(broken, source);
    await assert.rejects(check({ [file]: broken }), assert.AssertionError);
  }
});
async function checkWorker(t, worker = helper) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-duplicate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'effects');
  const program = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    `(begin-for-syntax (call-with-output-file ${JSON.stringify(marker)} (lambda (out) (display "once" out)) #:exists 'append))\n` +
    '(define-syntax-rule (m x) (let ([tmp x]) tmp))\n(m 1)\n(m 2)\n';
  const snapshot = { sourceHash: 'a'.repeat(64), sourceVersion: 1 };
  const session = createMacroSession(racket, worker, { ...request(program, 'module'), schemaVersion: 2, session: true, snapshot, nextGroup: 23 });
  t.after(() => session.stop());
  const summary = await session.start();
  const effects = fs.readFileSync(marker, 'utf8');
  assert.ok(effects.length > 0);
  const ask = query => session.request({ snapshot, ...query });
  const a = await ask({ mode: 'position', position: 1, suffixOption: 'always' });
  assert.ok(a.nextGroup > 23);
  const duplicate = Data.validateAnswer(await ask({ mode: 'duplicate', newView: 'copy', hiding: 'none', oneTermAtATime: true }), snapshot);
  assert.equal(duplicate.nextGroup, 1);
  assert.ok(duplicate.stepCount > summary.stepCount);
  const b = Data.validatePosition(await ask({ mode: 'position', view: 'copy', position: duplicate.steps.findIndex(step => step.macro === 'm') + 2 }), duplicate, duplicate.steps.findIndex(step => step.macro === 'm') + 2);
  const groups = b.record.after.occurrences.map(o => o.macroScopeGroup).filter(g => g > 0);
  assert.equal(Math.min(...groups), 1);
  assert.deepEqual((await ask({ mode: 'position', position: 1, suffixOption: 'always' })).record, a.record);
  await ask({ mode: 'configure', view: 'copy', grouping: 'all' });
  assert.deepEqual((await ask({ mode: 'position', position: 1, suffixOption: 'always' })).record, a.record);
  await ask({ mode: 'closeView' });
  assert.equal((await ask({ mode: 'position', view: 'copy', position: 2 })).failed, undefined);
  assert.equal((await ask({ mode: 'position', position: 1 })).failureCode, 'incompatible');
  assert.equal(fs.readFileSync(marker, 'utf8'), effects);
}
test('worker duplicate reuses the recording with fresh numbering, options and independent policies', checkWorker);
test('worker duplication proof rejects inheriting the source partition', async t => {
  const file = 'racketdap/tools/macro-steps/session.rkt', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace('(set! partition (new-foreground-partition))', '(void)');
  assert.notEqual(broken, source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-duplicate-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const driver = path.join(directory, 'worker.rkt');
  fs.writeFileSync(driver, workerOverride(file, broken));
  await assert.rejects(checkWorker(t, driver), assert.AssertionError);
});

function checkClearedPage(sources) {
  const { page, listeners } = fakeMacroPage('after', { sources });
  const projection = { ...project(fixtureAnswer({}), 1), pane: 'after', tokenSections: {}, tokenStyles: [], themeName: 'test' };
  page.renderPosition(projection);
  assert.ok(page.editorModel.getValue().length > 0);
  listeners.get('message')({ data: { ...page.env, v: 1, type: 'clear', requestId: 'clear' } });
  assert.equal(page.editorModel.getValue(), '');
  assert.equal(page.projection, null);
  assert.equal(page.selected.selected, null);
  assert.equal(page.partsBySection.size, 0);
  assert.equal(page.connections.textContent, '');
}
test('removing a term clears the page text, syntax, decorations and binding sentence', () => checkClearedPage());
test('term removal proof rejects leaving the old text in the page', () => {
  const file = 'vscode/macro-view/messages.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace("case 'clear':", "case 'unusedClear':");
  assert.notEqual(broken, source);
  assert.throws(() => checkClearedPage({ [file]: broken }), assert.AssertionError);
});

async function checkFailure(sources) {
  const ui = fakeStepper({ sources });
  try {
    await opened(ui);
    const process = ui.pending[0], send = process.send;
    process.send = query => {
      if (query.mode !== 'duplicate') return send(query);
      queueMicrotask(() => ui.finish(process, { failed: 'Duplicate detail marker', failureCode: 'memory' }));
      return true;
    };
    let creations = 0;
    ui.window.createWebviewPanel = () => { creations++; throw Error('Unexpected duplicate pane creation'); };
    await ui.command('duplicate');
    assert.equal(creations, 0);
    assert.equal(ui.panels.length, 2);
    assert.equal((await ui.command('_observe')).position, 1);
    assert.ok(ui.panels[0].messages.some(m => m.type === 'actionResult' && m.message === 'Duplicate detail marker'));
  } finally { ui.dispose(); }
}
test('a failed duplicate leaves the source pair intact and opens no partial pair', () => checkFailure());
test('duplicate failure proof rejects treating a failure as a new summary', async () => {
  const file = 'vscode/macro-steps/session.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace("if (query.mode === 'duplicate') {", "if (query.mode === 'duplicate' && !answer?.failed) {");
  assert.notEqual(broken, source);
  await assert.rejects(checkFailure({ [file]: broken }), assert.AssertionError);
});

async function checkEvicted(sources) {
  const ui = fakeStepper({ sources });
  try {
    await opened(ui); await ui.pending[0].stop();
    const duplicating = ui.command('duplicate'); await tick();
    if (ui.pending.length > 1) ui.answer(ui.pending.at(-1));
    await duplicating;
    assert.equal(ui.pending.length, 1);
    assert.equal(ui.panels.length, 2);
    assert.ok(ui.panels[0].messages.some(m => m.type === 'actionResult' && /recorded expansion is no longer available/.test(m.message)));
  } finally { ui.dispose(); }
}
test('duplicating an evicted recording reports its absence without executing the source again', () => checkEvicted());
test('evicted duplication proof rejects re-expanding the source to make a copy', async () => {
  const file = 'vscode/macro-steps/session.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace("if (query.mode === 'duplicate' && !recording.worker) throw Error(unavailableRecording);", '')
    .replace("if (query.mode === 'duplicate') throw Error(unavailableRecording);", '');
  assert.notEqual(broken, source);
  await assert.rejects(checkEvicted({ [file]: broken }), assert.AssertionError);
});

function checkInitialSelection(sources) {
  const frames = [];
  const { page, listeners, messages } = fakeMacroPage('after', { sources, globals: {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }
  } });
  const projection = { ...project(fixtureAnswer({}), 1), pane: 'after', tokenSections: {}, tokenStyles: [], themeName: 'test', suppressSelection: true };
  const encoded = Protocol.chunks(projection);
  const send = (type, fields) => listeners.get('message')({ data: { ...page.env, v: 1, requestId: type, type, transferId: 'initial', ...fields } });
  send('positionBegin', { payloadKind: 'position', totalBytes: encoded.totalBytes, chunkCount: encoded.chunks.length });
  encoded.chunks.forEach((chunk, sequence) => send('positionChunk', { chunk, sequence }));
  send('positionCommit', { totalBytes: encoded.totalBytes });
  for (const callback of frames.splice(0)) callback();
  assert.equal(page.selected.selected, null);
  assert.equal(messages.some(m => m.type === 'select'), false);
}
test('a fresh duplicate does not select syntax under the untouched editor caret', () => checkInitialSelection());
test('initial selection proof rejects automatically selecting the first syntax in a copy', () => {
  const file = 'vscode/macro-view/messages.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace('!result.value.suppressSelection && ', '');
  assert.notEqual(broken, source);
  assert.throws(() => checkInitialSelection({ [file]: broken }), assert.AssertionError);
});
