// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Registers observation and driving commands only in the isolated test host.
'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const Model = require('../macro-view/model');
function createTestHooks(runtime) {
  // Only the isolated extension test host can enable DOM observation or driving.
  if (runtime.context.extensionMode === vscode.ExtensionMode.Test) {
    runtime.context.subscriptions.push(vscode.commands.registerCommand('racketdap.macroSteps._hidingPicker', () => runtime.hidingPick));
    runtime.context.subscriptions.push(vscode.commands.registerCommand('racketdap.macroSteps._workerCount', () => runtime.workers.size));
    runtime.command('_observe', v => ({ side: v.side, pair: runtime.panes(v).map(p => ({ side: p.side, title: p.panel.title, column: p.panel.viewColumn,
      rendered: p.rendered, revision: p.positionRevision, generation: p.generation })), title: v.panel.title, source: v.source.toString(), position: v.position, count: v.data ? v.data.steps.length + 1 : undefined,
      revision: v.positionRevision, generation: v.generation, busy: !!v.busy, stale: !!v.stale, hiding: v.hiding, custom: runtime.customFor(v),
      selection: v.selection, pins: v.pins, propertiesVisible: v.propertiesVisible, savedSourceAvailable: !!v.savedSource, properties: runtime.selected(v) ? runtime.facts(v, runtime.selected(v).occurrence.syntaxId) : null,
      loadedPositions: [...v.positions.entries.keys()], workerSession: v.worker?.sessionId || null,
      projection: v.projection, rendered: v.rendered, panelColumn: v.panel.viewColumn, sourceColumn: v.column, failure: v.failure }));
    runtime.command('_drive', (v, operation) => {
      if (operation?.target) {
        // Prefer the active pane when both panes show the same section.
        const pane = [v, ...runtime.panes(v).filter(p => p !== v)].find(p =>
          p.projection && p.rendered?.sections.includes(operation.target.sectionId) && Model.find(p.projection, operation.target));
        if (!pane) return null;
        if (pane !== v) pane.panel.reveal(pane.panel.viewColumn, false);
        v = pane;
      }
      return new Promise(resolve => {
        const requestId = randomBytes(10).toString('hex');
        const timer = setTimeout(() => { v.testWaiters.delete(requestId); resolve(null); }, 10000);
        v.testWaiters.set(requestId, { envelope: runtime.stateEnvelope(v), resolve(value) { clearTimeout(timer); resolve(value); } });
        void runtime.post(v, 'testDrive', { operation, requestId,
          pane: { side: v.side, visible: v.panel.visible, active: v.panel.active } });
      });
    });
  }
  return {};
}
module.exports = { createTestHooks };
