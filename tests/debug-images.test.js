// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(t) {
  const commands = new Map(), requests = [], opened = [], contexts = [];
  let factory, terminated, choose, picked, provider, tabsChanged;
  const selection = new Promise(resolve => { choose = resolve; });
  const pickerOpened = new Promise(resolve => { picked = resolve; });
  const disposable = () => ({ dispose() {} });
  const session = { id: 'owner', async customRequest(command, args) {
    requests.push({ command, ...args });
    return { mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') };
  } };
  const vscode = {
    EventEmitter: class { event = disposable; dispose() {} },
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    Uri: { from: ({ scheme, path }) => ({ scheme, toString: () => `${scheme}:${path}`, with() { return this; } }) },
    FileSystemError: { FileNotFound: uri => new Error(`${uri} not found`) }, FileType: { File: 1 },
    ProgressLocation: { Window: 10 }, ViewColumn: { Beside: -2 },
    workspace: { registerFileSystemProvider(_scheme, value) { provider = value; return disposable(); } },
    window: {
      tabGroups: { all: [], onDidChangeTabs(listener) { tabsChanged = listener; return disposable(); } }, showErrorMessage() {},
      showQuickPick(items) { picked(items); return selection; },
      withProgress(_options, task) { return task(); }
    },
    debug: {
      activeDebugSession: session,
      registerDebugAdapterTrackerFactory(_type, value) { factory = value; return disposable(); },
      onDidChangeActiveDebugSession: disposable,
      onDidTerminateDebugSession(callback) { terminated = callback; return disposable(); }
    },
    commands: {
      registerCommand(name, command) { commands.set(name, command); return disposable(); },
      async executeCommand(name, ...args) {
        if (name === 'vscode.open') opened.push({ uri: args[0], options: args[1] });
        if (name === 'setContext') contexts.push(args);
      }
    }
  };
  const filename = path.join(__dirname, '../vscode/debug-images.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require('../vscode/' + name), Buffer
  }, { filename });
  const context = { subscriptions: [] };
  module.exports.registerDebugImages(context);
  t.after(() => context.subscriptions.forEach(value => value.dispose()));
  const tracker = factory.createDebugAdapterTracker(session);
  const result = { type: 'values', variablesReference: 10, racketdapImages: [
    { name: 'value 1', type: 'image', racketdapImage: true, variablesReference: 11 },
    { name: 'value 3', type: 'pict', racketdapImage: true, variablesReference: 12 }
  ] };
  function evaluate(seq, body) {
    tracker.onWillReceiveMessage({ type: 'request', command: 'evaluate', seq, arguments: { context: 'repl' } });
    tracker.onDidSendMessage({ type: 'response', request_seq: seq, success: true, body });
  }
  evaluate(1, result);
  return { plot: commands.get('racketdap.openPlot'), view: commands.get('racketdap.viewImage'), choose, pickerOpened, requests, opened, contexts,
    tracker, evaluate, result, terminate: () => terminated(session), vscode,
    stat: uri => provider.stat(uri), closeTabs: closed => tabsChanged({ opened: [], changed: [], closed }) };
}

test('image picker uses original result positions and the owning session after focus changes', async t => {
  const h = harness(t);
  assert.equal(h.contexts.at(-1)[1], true);
  const viewing = h.view();
  const choices = await h.pickerOpened;
  assert.deepEqual(Array.from(choices, item => item.label), ['value 1', 'value 3']);
  h.vscode.debug.activeDebugSession = { id: 'other', customRequest() { assert.fail('Wrong session'); } };
  h.choose(choices[1]);
  assert.equal((await viewing).scheme, 'racketeer-image');
  assert.deepEqual(h.requests, [{ command: 'racketdap/renderImage', variablesReference: 12 }]);
  assert.equal(h.opened.length, 1);
});

test('cancelling the image picker neither renders nor discards the last result', async t => {
  const h = harness(t);
  const viewing = h.view();
  await h.pickerOpened;
  await assert.rejects(h.view(), /already in progress/);
  h.choose(undefined);
  assert.equal(await viewing, undefined);
  assert.equal(await h.view(), undefined, 'a cancelled selection releases the command for another attempt');
  assert.equal(h.requests.length, 0);
  assert.equal(h.opened.length, 0);
  assert.equal(h.contexts.at(-1)[1], true);
});

for (const reason of ['resumed', 'replaced', 'terminated', 'termination reported']) {
  test(`image choice expires if its result is ${reason} while the picker is open`, async t => {
    const h = harness(t);
    const viewing = h.view();
    const choices = await h.pickerOpened;
    if (reason === 'resumed') h.tracker.onDidSendMessage({ type: 'event', event: 'continued' });
    if (reason === 'replaced') h.evaluate(2, { result: '42', variablesReference: 0 });
    if (reason === 'terminated') h.terminate();
    if (reason === 'termination reported') h.tracker.onDidSendMessage({ type: 'event', event: 'terminated' });
    h.choose(choices[0]);
    await assert.rejects(viewing, /expired/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.opened.length, 0);
    assert.equal(h.contexts.at(-1)[1], false);
  });
}

test('variable images use the menu session and retained reference without changing the console result', async t => {
  const h = harness(t);
  h.vscode.debug.activeDebugSession = { id: 'other', customRequest() { assert.fail('Wrong session'); } };
  h.vscode.window.tabGroups.all = [{ viewColumn: 2, tabs: [{ input: { uri: { scheme: 'racketeer-image' } } }] }];
  const context = { sessionId: 'owner', variable: { name: 'picture', variablesReference: 42 } };
  assert.equal((await h.view(context)).scheme, 'racketeer-image');
  assert.deepEqual(h.requests, [{ command: 'racketdap/renderImage', variablesReference: 42 }]);
  assert.equal(h.opened[0].options.viewColumn, 2, 'reuse the image editor group');
  h.vscode.debug.activeDebugSession = { id: 'owner' };
  const viewing = h.view();
  const choices = await h.pickerOpened;
  assert.deepEqual(Array.from(choices, item => item.label), ['value 1', 'value 3']);
  h.choose(undefined);
  await viewing;
});

test('image tabs that expose no input keep one group and release their snapshot when closed', async t => {
  const h = harness(t);
  const context = { sessionId: 'owner', variable: { name: 'picture', variablesReference: 42 } };
  const first = await h.view(context);
  // Since VS Code 1.144 a tab of the built-in image editor has a label but no input.
  const tab = { label: 'Racket image 1.png', input: undefined };
  h.vscode.window.tabGroups.all = [{ viewColumn: 3, tabs: [tab] }];
  const second = await h.view(context);
  assert.equal(h.opened[1].options.viewColumn, 3, 'reuse the image editor group');
  h.vscode.window.tabGroups.all = [{ viewColumn: 3, tabs: [{ label: 'Racket image 2.png', input: undefined }] }];
  h.closeTabs([tab]);
  assert.throws(() => h.stat(first), /not found/, 'closing the final tab releases its snapshot');
  assert.ok(h.stat(second).size > 0);
});

test('invalid or ended variable contexts never fall back to the active session', async t => {
  const h = harness(t);
  for (const context of [{}, { variable: { variablesReference: 11 } }, { sessionId: 'ended', variable: { variablesReference: 11 } }]) {
    await assert.rejects(h.view(context), /session.*ended|unavailable/);
  }
  for (const reference of [undefined, 0, -1, '11', 1.5]) {
    await assert.rejects(h.view({ sessionId: 'owner', variable: { variablesReference: reference } }), /Select an image/);
  }
  h.tracker.onDidSendMessage({ type: 'event', event: 'terminated' });
  await assert.rejects(h.view({ sessionId: 'owner', variable: { variablesReference: 11 } }), /session.*ended|unavailable/);
  assert.equal(h.requests.length, 0);
});

test('interactive plot picker filters static images and keeps the owning session', async t => {
  const h = harness(t);
  h.evaluate(2, { racketdapImages: [
    { name: 'value 1', racketdapImage: true, variablesReference: 20 },
    { name: 'value 3', racketdapImage: true, racketdapPlot: true, variablesReference: 21 },
    { name: 'value 4', racketdapPlot: true, variablesReference: 22 }
  ] });
  const opening = h.plot();
  const choices = await h.pickerOpened;
  assert.deepEqual(Array.from(choices, item => item.label), ['value 3', 'value 4']);
  h.vscode.debug.activeDebugSession = { id: 'other', customRequest() { assert.fail('Wrong session'); } };
  h.choose(choices[1]);
  await opening;
  assert.deepEqual(h.requests, [{ command: 'racketdap/openPlot', variablesReference: 22 }]);
  assert.equal(h.opened.length, 0);
});

test('interactive plots reject stale selections and static image results', async t => {
  const h = harness(t);
  await assert.rejects(h.plot(), /plot or plot3d/);
  h.evaluate(2, { racketdapImages: [21, 22].map(id => ({ name: String(id), racketdapPlot: true, variablesReference: id })) });
  const opening = h.plot();
  const choices = await h.pickerOpened;
  h.evaluate(3, { result: '42' });
  h.choose(choices[0]);
  await assert.rejects(opening, /expired/);
  assert.equal(h.requests.length, 0);
});

test('interactive variable plots use their menu owner without evaluating an expression', async t => {
  const h = harness(t);
  h.vscode.debug.activeDebugSession = { id: 'other' };
  await h.plot({ sessionId: 'owner', variable: { variablesReference: 42 } });
  assert.deepEqual(h.requests, [{ command: 'racketdap/openPlot', variablesReference: 42 }]);
});
