// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const { randomUUID } = require('node:crypto');

// `selected.owner`, when given, is a Racket supervisor that runs raco in a
// process tree it owns, so ending the task ends every descendant.
function racoTask(selected, label, args, definition = { type: 'racket-package' }) {
  // Configured task resolution must retain VS Code's definition object.
  const operation = new vscode.Task(definition,
    selected.folder || vscode.TaskScope.Workspace, label, 'Racket',
    new vscode.ProcessExecution(selected.executable,
      [...(selected.owner ? [selected.owner] : []), '-l', 'raco', '--', ...args], { cwd: selected.cwd }), []);
  operation.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
  return operation;
}

// Listen before launch, since even an immediate process failure must settle.
// The per-run identity keeps unrelated task completion/cancellation separate.
async function runTask(operation, token) {
  const id = randomUUID();
  operation.definition = { ...operation.definition, id };
  const subscriptions = [];
  let execution;
  subscriptions.push(token?.onCancellationRequested(() => execution?.terminate()));
  const done = new Promise(resolve => {
    subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution.task.definition.id === id) resolve({ exitCode: event.exitCode });
    }), vscode.tasks.onDidEndTask(event => {
      // Tasks that fail to start a process have no process-exit event.
      if (event.execution.task.definition.id === id) resolve({ exitCode: undefined });
    }));
  });
  try {
    if (token?.isCancellationRequested) return { exitCode: undefined };
    execution = await vscode.tasks.executeTask(operation);
    if (token?.isCancellationRequested) execution.terminate();
    return await done;
  } finally { subscriptions.forEach(subscription => subscription?.dispose()); }
}

module.exports = { racoTask, runTask };
