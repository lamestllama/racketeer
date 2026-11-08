// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Presents internal diagnostics through the editor's notification and file APIs.
'use strict';
const vscode = require('vscode');
function createInternalError(runtime) {
  let output;
  runtime.context.subscriptions.push({ dispose() { output?.dispose(); } });
  async function internalDetails(v) {
    const diagnostic = v.projection?.diagnostics?.[v.projection.error];
    if (diagnostic?.kind !== 'internal' || !diagnostic.details || v.busy) return;
    const gen = v.generation;
    const details = await runtime.queryWorker(v, { mode: 'internalDetails', snapshot: v.data.snapshot });
    if (!runtime.current(v, gen)) return;
    if (details.failed) throw Error(details.failed);
    if (typeof details.title !== 'string' || typeof details.message !== 'string' || typeof details.report !== 'string' ||
        !(details.diagnostic === false || typeof details.diagnostic === 'string')) throw Error('Invalid internal error details');
    const choice = await vscode.window.showErrorMessage(`${details.title}\n\n${details.message}`,
      'Copy Details', 'Show Error', 'Dump Debugging File', 'Cancel');
    if (runtime.disposed) return;
    // The reply owns its details, so it remains copyable after navigation or close.
    if (choice === 'Copy Details') await vscode.env.clipboard.writeText(details.message);
    else if (choice === 'Show Error') {
      output ||= vscode.window.createOutputChannel('Macro stepper');
      output.appendLine(details.report); output.show(true);
    } else if (choice === 'Dump Debugging File') {
      const destination = await vscode.window.showSaveDialog({ title: 'Dump Debugging File' });
      if (!destination) return;
      if (details.diagnostic === false) throw Error('Recorded expansion events are unavailable.');
      await vscode.workspace.fs.writeFile(destination, Buffer.from(details.diagnostic, 'utf8'));
    }
  }
  return { internalDetails };
}
module.exports = { createInternalError };
