// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { racketOverride } = require('./support/macro-racket-proof');
const { root, tick, plain, racket } = require('./support/macro-common');
const { fakeStepper } = require('./support/macro-stepper');
const { fakeMacroPage } = require('./support/macro-page');
const Protocol = require('../vscode/macro-view/protocol');

async function check(sources) {
  const ui = fakeStepper({ sources });
  try {
    await ui.source('A'); const opening = ui.open(true); await tick();
    const process = ui.pending[0];
    ui.answer(process, data => {
      data.diagnostics.internal = { kind: 'internal', details: true, message: 'heading', syntax: [], contexts: [], program: null };
      data.error = 'internal'; data.final = null;
    });
    await opening;
    const panel = ui.panels[0];
    await ui.command('last');
    const message = 'Internal error:\n' + 'test detail marker\n'.repeat(500);
    const details = { title: 'Macro stepper internal error', message, report: 'original message\noriginal context', diagnostic: 'events\nmessage\ncontext' };
    const notices = [], output = [], writes = [];
    ui.window.createOutputChannel = () => ({ appendLine: s => output.push(s), show() {}, dispose() {} });
    ui.workspace.fs = { writeFile: async (uri, bytes) => writes.push([uri, bytes.toString()]) };
    ui.window.showSaveDialog = async () => undefined;
    async function choose(action, reply = details) {
      ui.window.showErrorMessage = async (...args) => { notices.push(args); return action; };
      const pending = ui.command('internalDetails'); await tick();
      ui.finish(process, reply); await pending;
    }
    await choose('Copy Details');
    assert.equal(ui.clipboard[0], message);
    assert.deepEqual(plain(notices[0]), [`${details.title}\n\n${message}`, 'Copy Details', 'Show Error', 'Dump Debugging File', 'Cancel']);
    await choose('Show Error'); assert.deepEqual(output, [details.report]);
    await choose('Dump Debugging File'); assert.equal(writes.length, 0);
    ui.window.showSaveDialog = async () => 'destination';
    await choose('Dump Debugging File'); assert.deepEqual(writes, [['destination', details.diagnostic]]);
    await choose('Cancel'); await choose(undefined); assert.equal(ui.clipboard.length, 1);
    await choose('Dump Debugging File', { ...details, diagnostic: false }); assert.equal(writes.length, 1);
    assert.ok(panel.messages.some(m => m.type === 'actionResult' && /events are unavailable/.test(m.message)));
    assert.equal(panel.closed, undefined);
  } finally { ui.dispose(); }
}
test('internal error notification copies the full message, reports context, exports or dismisses', () => check());
test('copy regression proof rejects copying the report instead of the message', async () => {
  const file = 'vscode/macro-steps/internal-error.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace('writeText(details.message)', 'writeText(details.report)');
  assert.notEqual(broken, source);
  await assert.rejects(check({ [file]: broken }), assert.AssertionError);
});
function checkHeading(sources) {
  const { page, messages } = fakeMacroPage('after', { sources });
  page.projection = { pane: 'after', error: 'internal', diagnostics: { internal: { kind: 'internal', details: true,
    message: 'Macro stepper error (steps) [details].  Original syntax:\n' } } };
  page.env = { sessionId: 'session', generation: 1, positionRevision: 0 };
  page.updateStatus();
  assert.equal(page.note.textContent, page.projection.diagnostics.internal.message);
  const link = page.note.children[1]; assert.equal(link.textContent, '[details]');
  // Exercise the actual listener and the action schema.
  link.listeners.click({ preventDefault() {} });
  assert.equal(messages.at(-1).type, 'internalDetails');
  const envelope = { v: 1, type: 'internalDetails', requestId: 'details', ...plain(page.env) };
  assert.equal(Protocol.validateAction(envelope, page.env).type, 'internalDetails');
  page.projection.diagnostics.internal.details = false;
  page.projection.diagnostics.internal.message = 'Macro stepper error (derivation).  \n';
  page.updateStatus(); assert.equal(page.note.children.length, 1);
}
test('internal heading has an actionable details entry without exposing the message inline', () => checkHeading());
test('details entry proof rejects a link that does not request details', () => {
  const file = 'vscode/macro-view/page.js', source = fs.readFileSync(`${root}/${file}`, 'utf8');
  const broken = source.replace("send('internalDetails')", "send('retry')");
  assert.notEqual(broken, source);
  assert.throws(() => checkHeading({ [file]: broken }), assert.AssertionError);
});

test('Racket internal failure tests reject removing the catcher and changing the exact heading', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-internal-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const body = `(define check-handler (dynamic-require 'rackunit 'current-check-handler))
    (parameterize ([check-handler (lambda (failure) (eprintf "proof assertion failed\\n") (raise failure))])
      (dynamic-require '(submod (file ${JSON.stringify(`${root}/tests/macro-stepper-internal.rkt`)}) test) #f))`;
  for (const [file, from, to] of [
    ['racketdap/tools/macro-steps/expansion.rkt', '(not (exn:worker? value))', '#f'],
    ['racketdap/tools/macro-steps/internal-error.rkt', 'Macro stepper error', 'Expansion error']
  ]) {
    const source = fs.readFileSync(`${root}/${file}`, 'utf8');
    const broken = source.replace(from, to); assert.notEqual(broken, source);
    const driver = path.join(directory, 'proof.rkt');
    fs.writeFileSync(driver, racketOverride(file, broken, body));
    const result = spawnSync(racket, [driver], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /test detail marker|proof assertion failed/);
  }
});
