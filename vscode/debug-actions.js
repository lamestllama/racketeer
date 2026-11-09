// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const { selectedEditor } = require('./selected-editor');
function parseSegments(text) {
  const parts = JSON.parse(text);
  if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string' ||
      (part && typeof part === 'object' && !Array.isArray(part) &&
       Object.keys(part).length === 1 && typeof part.expression === 'string'))) {
    throw new Error('Use an array of strings and {"expression":"native text"} records.');
  }
  return parts;
}

function registerDebugActions(context, debugSources) {
  const stops = new Map();
  const requests = new Map();
  const enabled = new Map();
  const nativeSources = new Map();
  const segmentKey = 'racketdap.logpointSegments';
  const segments = new Map(context.workspaceState?.get(segmentKey, []) || []);
  const saveSegments = () => context.workspaceState?.update(segmentKey, [...segments]);
  function nativeLocation(location) {
    const session = vscode.debug.activeDebugSession;
    return !!(session && nativeSources.get(session.id)?.has(location?.uri.toString()));
  }
  function selected() {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== 'racketdap') throw new Error('Start a Racket debug session first.');
    const threads = stops.get(session.id);
    const item = vscode.debug.activeStackItem;
    const selectedThread = item?.session.id === session.id ? item.threadId : undefined;
    const threadId = threads?.has(selectedThread) ? selectedThread : threads?.keys().next().value;
    if (threadId === undefined) throw new Error('Pause the Racket program first.');
    return { session, threadId, frameId: selectedThread === threadId ? item?.frameId : undefined, actions: threads.get(threadId) };
  }
  function updateContext() {
    let allowed = [];
    try { allowed = selected().actions; } catch (_) { /* No paused Racket thread. */ }
    for (const [name, request] of requests) {
      const value = allowed.includes(request);
      if (enabled.get(name) !== value) {
        enabled.set(name, value);
        void vscode.commands.executeCommand('setContext', `${name}.enabled`, value);
      }
    }
    const editor = selectedEditor(vscode.window);
    void vscode.commands.executeCommand('setContext', 'racketdap.nativeExpressions',
      nativeLocation(editor && { uri: editor.document.uri }));
  }
  function command(name, action, requestName = name) {
    const id = `racketdap.${name}`, request = `racketdap/${requestName}`;
    requests.set(id, request);
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try {
        const stop = selected();
        if (!stop.actions.includes(request)) throw new Error('This action is unavailable at the current stop.');
        return await action(stop, request, ...args);
      } catch (error) { vscode.window.showErrorMessage(error.message); throw error; }
    }));
  }
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
      createDebugAdapterTracker(session) {
        const threads = new Map(); stops.set(session.id, threads);
        const sources = new Set(); nativeSources.set(session.id, sources);
        return { onWillReceiveMessage(message) {
          if (message.command !== 'setBreakpoints') return;
          for (const breakpoint of message.arguments?.breakpoints || []) {
            const source = message.arguments.source;
            const owned = vscode.debug.breakpoints.find(item => item.location &&
              item.location.uri.fsPath === source?.path &&
              item.location.range.start.line + 1 === breakpoint.line &&
              item.location.range.start.character + 1 === (breakpoint.column || 1) &&
              item.condition === breakpoint.condition && item.hitCondition === breakpoint.hitCondition &&
              item.logMessage === breakpoint.logMessage && segments.has(item.id));
            const metadata = owned && segments.get(owned.id);
            if (!metadata || metadata.logMessage !== breakpoint.logMessage) continue;
            breakpoint.logSegments = metadata.parts;
            delete breakpoint.logMessage;
          }
        }, onDidSendMessage(message) {
          const remember = item => {
            if (item.source?.path) {
              const uri = vscode.Uri.file(item.source.path).toString();
              if (item.racketdapNativeExpressions) sources.add(uri); else sources.delete(uri);
            }
          };
          if (message.type === 'response' && message.command === 'stackTrace') {
            for (const frame of message.body?.stackFrames || []) remember(frame);
            updateContext();
          }
          if (message.type !== 'event') return;
          const body = message.body || {};
          if (['stopped', 'racketdap/ready'].includes(message.event)) remember(body);
          if (message.event === 'racketdap/ready') updateContext();
          if (!['stopped', 'continued', 'terminated'].includes(message.event) &&
              !(message.event === 'thread' && body.reason === 'exited')) return;
          if (message.event === 'stopped') threads.set(body.threadId, body.racketdapActions || []);
          if (message.event === 'continued') {
            if (body.allThreadsContinued) threads.clear(); else threads.delete(body.threadId);
          }
          if (message.event === 'thread' && body.reason === 'exited') threads.delete(body.threadId);
          if (message.event === 'terminated') { stops.delete(session.id); nativeSources.delete(session.id); }
          updateContext();
        } };
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession(updateContext),
    vscode.debug.onDidTerminateDebugSession(session => { stops.delete(session.id); nativeSources.delete(session.id); updateContext(); })
  );
  if (vscode.window.onDidChangeActiveTextEditor) context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateContext));
  if (vscode.debug.onDidChangeBreakpoints) context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(event => {
    for (const breakpoint of [...event.removed, ...event.changed]) {
      const metadata = segments.get(breakpoint.id);
      if (metadata && (event.removed.includes(breakpoint) || metadata.logMessage !== breakpoint.logMessage)) segments.delete(breakpoint.id);
    }
    void saveSegments();
  }));
  if (vscode.debug.onDidChangeActiveStackItem) context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(updateContext));
  context.subscriptions.push(vscode.commands.registerCommand('racketdap.editLogpointSegments', async breakpoint => {
    try {
      if (!breakpoint?.location) breakpoint = undefined;
      const editor = selectedEditor(vscode.window);
      let location = breakpoint?.location || (editor && new vscode.Location(editor.document.uri, editor.selection.active));
      if (!location) throw new Error('Select a source location for the logpoint.');
      if (!nativeLocation(location)) throw new Error('Select a source file with native expressions.');
      breakpoint ||= vscode.debug.breakpoints.find(item => item.location?.uri.toString() === location.uri.toString() &&
        item.location.range.start.line === location.range.start.line);
      if (breakpoint) location = breakpoint.location;
      const text = await vscode.window.showInputBox({
        prompt: 'Logpoint segments: an array of literal strings and {"expression":"native text"} records',
        value: segments.has(breakpoint?.id) ? JSON.stringify(segments.get(breakpoint.id).parts) : '["result: ", {"expression": ""}]',
        ignoreFocusOut: true,
        validateInput: value => { try { parseSegments(value); } catch (error) { return error.message; } }
      });
      if (text === undefined) return;
      const parts = parseSegments(text);
      const replacement = new vscode.SourceBreakpoint(location, breakpoint?.enabled ?? true,
        breakpoint?.condition, breakpoint?.hitCondition,
        parts.map(part => typeof part === 'string' ? part : `{${part.expression}}`).join(''));
      segments.set(replacement.id, { parts, logMessage: replacement.logMessage });
      await saveSegments();
      if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
      vscode.debug.addBreakpoints([replacement]);
    } catch (error) { vscode.window.showErrorMessage(error.message); throw error; }
  }));
  for (const [name, prompt] of [
    ['skipExpression', 'Replacement return values as a Racket expression; use (values ...) for multiple values'],
    ['replaceResults', 'New return values as a Racket expression; use (values ...) for multiple values']
  ]) command(name, async ({ session, threadId }, request, expression) => {
    expression ??= await vscode.window.showInputBox({ prompt, ignoreFocusOut: true });
    if (expression === undefined) return;
    const result = await session.customRequest(request, { threadId, expression });
    vscode.debug.activeDebugConsole.appendLine(`Selected return values: ${result.result}`);
    return result;
  });
  async function bindingName(name) {
    if (typeof name === 'string') return name;
    const editor = selectedEditor(vscode.window);
    if (editor) {
      const range = editor.selection.isEmpty
        ? editor.document.getWordRangeAtPosition(editor.selection.active, /[^()\[\]{}\s"'`,;]+/)
        : editor.selection;
      if (range) name = editor.document.getText(range);
    }
    return name || vscode.window.showInputBox({ prompt: 'Lexical or module variable name', ignoreFocusOut: true });
  }
  command('printBinding', async ({ session, threadId, frameId }, request, name) => {
    name = await bindingName(name);
    if (name === undefined) return;
    return session.customRequest(request, { threadId, frameId, name });
  });
  command('setBinding', async ({ session, threadId, frameId }, request, name, expression) => {
    name = await bindingName(name);
    if (name === undefined) return;
    expression ??= await vscode.window.showInputBox({ prompt: `New value for (set! ${name} ...) as a Racket expression`, ignoreFocusOut: true });
    if (expression === undefined) return;
    return session.customRequest(request, { threadId, frameId, name, expression });
  });
  command('printResults', ({ session, threadId }, request) => session.customRequest(request, { threadId }));
  command('continueToCursor', async ({ session, threadId }, request) => {
    const editor = selectedEditor(vscode.window);
    if (!editor) throw new Error('Open the target Racket source file.');
    const uri = editor.document.uri;
    const sourcePath = uri.scheme === 'file' ? uri.fsPath : debugSources.pathFor(uri, session.id);
    if (!sourcePath) throw new Error('Open a source file from the current Racket debug session.');
    const position = editor.selection.active;
    return session.customRequest(request, {
      threadId, source: { path: sourcePath }, line: position.line + 1, column: position.character + 1
    });
  }, 'continueToLocation');
  updateContext();
}
module.exports = { registerDebugActions };
