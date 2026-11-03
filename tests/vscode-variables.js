// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const vscode = require('vscode');

// What the Variables panel itself asks for. Its tree is driven by the list commands, and
// the adapter's traffic shows the requests, so nothing here asks on the panel's behalf.
exports.run = async function (workspace) {
  const requests = [], responses = new Map(), events = [], sessions = [];
  const program = path.join(workspace.uri.fsPath, 'variables-panel.rkt');
  const names = Array.from({ length: 120 }, (_, i) => `v${i}`);
  await fs.writeFile(program, [
    '#lang racket/base',
    '(define (panel first-argument)',
    ...names.map((name, i) => `  (define ${name} ${i})`),
    '  (define long-vector (build-vector 150 values))',
    '  (void long-vector))',
    '(panel 1)',
    ''
  ].join('\n'));
  const stopLine = names.length + 4;
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(program), new vscode.Position(stopLine - 1, 0)));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.push(session);
      return {
        onWillReceiveMessage(message) { if (message.command === 'variables') requests.push(message); },
        onDidSendMessage(message) {
          if (message.type === 'response') responses.set(message.request_seq, message);
          if (message.type === 'event') events.push(message);
        }
      };
    }
  });
  async function until(check, description, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${description}. Requests: ${JSON.stringify(requests.map(r => r.arguments))}`);
  }
  const answered = (description, match) => until(() => {
    const request = requests.find(candidate => match(candidate.arguments));
    const response = request && responses.get(request.seq);
    return response && { request: request.arguments, rows: response.body.variables };
  }, description);
  const list = command => vscode.commands.executeCommand(command);
  try {
    vscode.debug.addBreakpoints([breakpoint]);
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Variables panel', program, submodule: []
    }), true);
    await until(() => events.some(event => event.event === 'stopped'), 'the program stops at its breakpoint', 60000);
    await list('workbench.debug.action.focusVariablesView');
    // A scope reports no size, so the panel asks with neither start nor count, and gets every row.
    const scope = await answered('the panel opens Locals',
      args => args.start === undefined && args.count === undefined && args.filter === undefined);
    console.log(`Variables panel asked for Locals: ${JSON.stringify(scope.request)}, ${scope.rows.length} rows`);
    assert.equal(scope.rows.length, names.length + 2);
    assert.ok(scope.rows.some(row => row.name === 'first-argument'));
    const vector = scope.rows.find(row => row.name === 'long-vector');
    assert.equal(vector.indexedVariables, 150);
    assert.equal(scope.rows[0], vector, 'the newest name is the panel\'s first row');
    // The vector opens to chunks, which need no request, and a chunk asks for its own page.
    const page = args => args.variablesReference === vector.variablesReference && args.start === 100;
    await list('list.focusFirst');
    await list('list.focusDown');
    await list('list.expand');
    await list('list.focusDown');
    await list('list.focusDown');
    await list('list.expand');
    // The list commands act on the focused list, and a window without focus has none.
    // The paging itself is held at the protocol in debugger-variables.test.js.
    const chunk = await answered('the panel opens the vector\'s second chunk', page).catch(error => {
      if (vscode.window.state.focused) throw error;
      console.log('Variables panel chunk not driven: this window has no focus');
    });
    if (chunk) {
      console.log(`Variables panel asked for a chunk: ${JSON.stringify(chunk.request)}, ${chunk.rows.length} rows`);
      assert.deepEqual([chunk.request.filter, chunk.request.count, chunk.rows.length], ['indexed', 50, 50]);
      assert.equal(chunk.rows[0].name, '100');
      assert.equal(chunk.rows.at(-1).name, '149');
    }
    return ['the Variables panel gets every local of a long scope', 'the Variables panel pages a long vector by its reported size'];
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    for (const session of sessions) await vscode.debug.stopDebugging(session);
    await fs.rm(program, { force: true });
    tracker.dispose();
  }
};
