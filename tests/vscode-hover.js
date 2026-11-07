// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const path = require('node:path');
const fs = require('node:fs/promises');
const vscode = require('vscode');

// A hover in the editor itself: what it asks the adapter, from where, and what it is told.
// Which value each kind of place shows is held at the protocol in debugger-variables.test.js.
exports.run = async function (workspace) {
  const asked = [], answers = new Map(), sessions = [];
  let stopped = false;
  const program = path.join(workspace.uri.fsPath, 'hover-binding.rkt');
  await fs.writeFile(program, [
    '#lang racket/base',
    '(define (inner n)',
    '  (let ([n (* n 10)])',
    '    (displayln n)',
    '    n))',
    '(inner 2)',
    ''
  ].join('\n'));
  const document = await vscode.workspace.openTextDocument(program);
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(document.uri, new vscode.Position(3, 0)));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.push(session);
      return {
        onWillReceiveMessage(message) {
          if (message.command === 'evaluate' && message.arguments.context === 'hover') asked.push(message);
        },
        onDidSendMessage(message) {
          if (message.type === 'response') answers.set(message.request_seq, message);
          if (message.event === 'stopped') stopped = true;
        }
      };
    }
  });
  try {
    vscode.debug.addBreakpoints([breakpoint]);
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Hover binding', program, submodule: [], stopOnEntry: false
    }), true);
    await until(() => stopped && vscode.debug.activeStackItem, 'the program stops at its breakpoint');
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const hover = async (line, character) => {
      const before = asked.length;
      editor.selection = new vscode.Selection(line, character, line, character);
      await vscode.commands.executeCommand('editor.debug.action.showDebugHover');
      return until(() => {
        const request = asked.slice(before).find(candidate => candidate.arguments.expression === 'n');
        const answer = request && answers.get(request.seq);
        return answer && { arguments: request.arguments, result: answer.body?.result };
      }, `a hover at line ${line + 1}, character ${character + 1}`, () => JSON.stringify(asked));
    };
    const hidden = await hover(2, 14);
    assert.deepEqual([hidden.arguments.line, hidden.arguments.column, hidden.result], [3, 15, '2'],
      'the n in (* n 10) is the parameter, which the new n hides');
    assert.equal(path.resolve(hidden.arguments.source.path), path.resolve(program));
    const inView = await hover(3, 15);
    assert.deepEqual([inView.arguments.line, inView.arguments.column, inView.result], [4, 16, '20']);
    return ['an editor hover says where its name is', 'an editor hover shows the binding written there'];
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    for (const session of sessions) await vscode.debug.stopDebugging(session);
    await fs.rm(program, { force: true });
    tracker.dispose();
  }
};
