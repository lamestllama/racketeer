// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function editor(input, native = true, state = new Map()) {
  const commands = new Map(), added = [], removed = [], errors = [], contexts = new Map();
  let factory, prompt, serial = 0, editorChanged;
  const disposable = () => ({ dispose() {} });
  const vscode = {
    window: { showInputBox: async options => { prompt = options; return input; }, showErrorMessage: text => errors.push(text),
      onDidChangeActiveTextEditor: callback => { editorChanged = callback; return disposable(); } },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); },
      executeCommand: (_command, key, value) => contexts.set(key, value) },
    debug: {
      activeDebugSession: { id: 'tiny', type: 'racketdap' },
      breakpoints: [], registerDebugAdapterTrackerFactory: (_type, value) => { factory = value; return disposable(); },
      onDidChangeActiveDebugSession: disposable, onDidTerminateDebugSession: disposable,
      addBreakpoints: values => { added.push(...values); vscode.debug.breakpoints.push(...values); },
      removeBreakpoints: values => { removed.push(...values); vscode.debug.breakpoints = vscode.debug.breakpoints.filter(item => !values.includes(item)); }
    },
    Uri: { file: file => ({ fsPath: file, toString: () => `file://${file}` }) },
    SourceBreakpoint: class {
      constructor(location, enabled, condition, hitCondition, logMessage) {
        Object.assign(this, { location, enabled, condition, hitCondition, logMessage });
        this.id = `breakpoint-${++serial}`;
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vscode/debug-actions.js'), 'utf8'), {
    module, exports: module.exports, require: name => name === 'vscode' ? vscode : { selectedEditor: window => window.activeTextEditor }
  });
  module.exports.registerDebugActions({ subscriptions: [], workspaceState: {
    get: (key, fallback) => state.get(key) || fallback, update: async (key, value) => state.set(key, value)
  } }, {});
  const breakpoint = { id: 'original', location: { uri: { fsPath: '/tiny.rkt', toString: () => 'file:///tiny.rkt' }, range: { start: { line: 4, character: 0 } } },
    enabled: false, condition: '!ready', hitCondition: '%2' };
  const tracker = factory.createDebugAdapterTracker({ id: 'tiny' });
  tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: {
    threadId: 1, source: { path: '/tiny.rkt' }, racketdapNativeExpressions: native
  } });
  return { commands, added, removed, errors, breakpoint, tracker, prompt: () => prompt, vscode, state, contexts, editorChanged: () => editorChanged() };
}

test('segment editor persists explicit native expressions and translates only its own source breakpoints', async () => {
  const parts = ['result {', { expression: '!{x + 2}' }, '}'];
  const e = editor(JSON.stringify(parts));
  await e.commands.get('racketdap.editLogpointSegments')(e.breakpoint);
  assert.equal(e.added.length, 1);
  assert.equal(e.removed[0], e.breakpoint);
  const replacement = e.added[0];
  assert.equal(replacement.enabled, false);
  assert.equal(replacement.condition, '!ready');
  assert.equal(replacement.hitCondition, '%2');
  const legacy = { logMessage: 'x={x}; {{literal}}' };
  const request = { command: 'setBreakpoints', arguments: { source: { path: '/tiny.rkt' }, breakpoints: [{ line: 5,
    condition: replacement.condition, hitCondition: replacement.hitCondition, logMessage: replacement.logMessage }, legacy] } };
  e.tracker.onWillReceiveMessage(request);
  assert.deepEqual(JSON.parse(JSON.stringify(request.arguments.breakpoints[0])), { line: 5, condition: '!ready', hitCondition: '%2', logSegments: parts });
  assert.equal(request.arguments.breakpoints[1], legacy);
  assert.equal(legacy.logMessage, 'x={x}; {{literal}}');
  assert.equal(e.prompt().validateInput('[{"expression":2}]'), 'Use an array of strings and {"expression":"native text"} records.');
  const reloaded = editor(undefined, true, e.state);
  reloaded.vscode.debug.breakpoints.push(replacement);
  const repeated = { command: 'setBreakpoints', arguments: { source: { path: '/tiny.rkt' }, breakpoints: [{ line: 5,
    condition: replacement.condition, hitCondition: replacement.hitCondition, logMessage: replacement.logMessage }] } };
  reloaded.tracker.onWillReceiveMessage(repeated);
  assert.deepEqual(JSON.parse(JSON.stringify(repeated.arguments.breakpoints[0].logSegments)), parts);
});

test('cancelling or invalid segment input preserves the existing breakpoint', async () => {
  const cancelled = editor(undefined);
  await cancelled.commands.get('racketdap.editLogpointSegments')(cancelled.breakpoint);
  assert.equal(cancelled.added.length, 0);
  assert.equal(cancelled.removed.length, 0);
  const invalid = editor('[{"expression":"!x","extra":true}]');
  await assert.rejects(invalid.commands.get('racketdap.editLogpointSegments')(invalid.breakpoint), /array of strings/);
  assert.equal(invalid.added.length, 0);
  assert.equal(invalid.removed.length, 0);
});

for (const logMessage of ['Racketeer log segments: hello', 'Racketeer log segments: ["hello"]']) test(`ordinary log text is preserved: ${logMessage}`, () => {
  const e = editor(undefined);
    const breakpoint = { line: 5, logMessage };
    const message = { command: 'setBreakpoints', arguments: { source: { path: '/tiny.rkt' }, breakpoints: [breakpoint] } };
    e.tracker.onWillReceiveMessage(message);
    assert.deepEqual(breakpoint, { line: 5, logMessage });
});

test('segment editing is hidden in the palette and source menu without native expressions', () => {
  const { contributes } = JSON.parse(fs.readFileSync(path.join(__dirname, '../vscode/package.json'), 'utf8'));
  for (const menu of ['commandPalette', 'editor/context']) {
    const item = contributes.menus[menu].find(item => item.command === 'racketdap.editLogpointSegments');
    assert.ok(item?.when?.includes('racketdap.nativeExpressions'), menu);
  }
});

test('segment editing refuses an adapterless source without prompting or changing breakpoints', async () => {
  const e = editor('[]', false);
  await assert.rejects(e.commands.get('racketdap.editLogpointSegments')(e.breakpoint), /native expressions/);
  assert.equal(e.prompt(), undefined);
  assert.equal(e.added.length, 0);
  assert.equal(e.removed.length, 0);
});

test('native segment editing survives logpoint output and loaded source events', async () => {
  const e = editor('["value: ", {"expression":"!x"}]');
  for (const [event, body] of [
    ['output', { source: { path: '/tiny.rkt' }, output: 'tiny<6>\n' }],
    ['loadedSource', { reason: 'new', source: { path: '/tiny.rkt' } }]
  ]) {
    e.tracker.onDidSendMessage({ type: 'event', event, body });
    await e.commands.get('racketdap.editLogpointSegments')(e.breakpoint);
  }
  assert.equal(e.added.length, 2);
  assert.equal(e.errors.length, 0);
});

test('native segment capability follows the selected source document', () => {
  const e = editor(undefined);
  assert.equal(e.contexts.get('racketdap.nativeExpressions'), false);
  e.vscode.window.activeTextEditor = { document: { uri: e.vscode.Uri.file('/tiny.rkt') } };
  e.editorChanged();
  assert.equal(e.contexts.get('racketdap.nativeExpressions'), true);
  e.vscode.window.activeTextEditor = { document: { uri: e.vscode.Uri.file('/ordinary.rkt') } };
  e.editorChanged();
  assert.equal(e.contexts.get('racketdap.nativeExpressions'), false);
});
