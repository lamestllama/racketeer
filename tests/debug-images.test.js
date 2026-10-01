'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(t) {
  const commands = new Map(), requests = [], opened = [], contexts = [];
  let factory, terminated, choose, picked;
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
    Uri: { from: ({ scheme, path }) => ({ scheme, toString: () => `${scheme}:${path}` }) },
    ProgressLocation: { Window: 10 }, ViewColumn: { Beside: -2 },
    workspace: { registerFileSystemProvider: disposable },
    window: {
      tabGroups: { all: [], onDidChangeTabs: disposable }, showErrorMessage() {},
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
    module, require: name => { assert.equal(name, 'vscode'); return vscode; }, Buffer
  }, { filename });
  const context = { subscriptions: [] };
  module.exports.registerDebugImages(context);
  t.after(() => context.subscriptions.forEach(value => value.dispose()));
  const tracker = factory.createDebugAdapterTracker(session);
  const result = { type: 'values', variablesReference: 10, racketdapImages: [
    { name: 'value 1', type: 'image', variablesReference: 11 },
    { name: 'value 3', type: 'pict', variablesReference: 12 }
  ] };
  function evaluate(seq, body) {
    tracker.onWillReceiveMessage({ type: 'request', command: 'evaluate', seq, arguments: { context: 'repl' } });
    tracker.onDidSendMessage({ type: 'response', request_seq: seq, success: true, body });
  }
  evaluate(1, result);
  return { view: commands.get('racketdap.viewImage'), choose, pickerOpened, requests, opened, contexts,
    tracker, evaluate, result, terminate: () => terminated(session), vscode };
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
