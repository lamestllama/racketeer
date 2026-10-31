'use strict';
const vscode = require('vscode');

function registerDebugActions(context, debugSources) {
  const stops = new Map();
  const requests = new Map();
  const enabled = new Map();
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
        return { onDidSendMessage(message) {
          if (message.type !== 'event') return;
          const body = message.body || {};
          if (!['stopped', 'continued', 'terminated'].includes(message.event) &&
              !(message.event === 'thread' && body.reason === 'exited')) return;
          if (message.event === 'stopped') threads.set(body.threadId, body.racketdapActions || []);
          if (message.event === 'continued') {
            if (body.allThreadsContinued) threads.clear(); else threads.delete(body.threadId);
          }
          if (message.event === 'thread' && body.reason === 'exited') threads.delete(body.threadId);
          if (message.event === 'terminated') stops.delete(session.id);
          updateContext();
        } };
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession(updateContext),
    vscode.debug.onDidTerminateDebugSession(session => { stops.delete(session.id); updateContext(); })
  );
  if (vscode.debug.onDidChangeActiveStackItem) context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(updateContext));
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
    const editor = vscode.window.activeTextEditor;
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
    const editor = vscode.window.activeTextEditor;
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
