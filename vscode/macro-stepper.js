// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Registers the macro stepper and connects its focused components.
'use strict';
const vscode = require('vscode');
const { macroTarget } = require('./macro-steps/target');
const { panelHtml, viewType } = require('./macro-steps/html');
const { sourceOffsets } = require('./macro-view/model');
const { createSession } = require('./macro-steps/session');
const { createHiding } = require('./macro-steps/hiding');
const { createSource } = require('./macro-steps/source');
const { createProtocol } = require('./macro-steps/protocol');
const { createColors } = require('./macro-steps/colors');
const { createPanes } = require('./macro-steps/panes');
const { createCommands } = require('./macro-steps/commands');
const { createNavigation } = require('./macro-steps/navigation');
const { createOptions } = require('./macro-steps/options');
const { createInternalError } = require('./macro-steps/internal-error');
const { createTestHooks } = require('./macro-steps/test-hooks');

function registerMacroStepper(context) {
  let active, disposed = false;
  const runtime = { context, get active() { return active; }, set active(value) { active = value; },
    get disposed() { return disposed; }, set disposed(value) { disposed = value; } };
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createSession(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createHiding(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createSource(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createProtocol(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createColors(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createPanes(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createInternalError(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createCommands(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createNavigation(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createOptions(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(createTestHooks(runtime)));
  context.subscriptions.push(runtime.sourceStyle,
    vscode.window.onDidChangeActiveColorTheme(runtime.themeChanged),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (['workbench.colorTheme', 'workbench.colorCustomizations', 'editor.tokenColorCustomizations'].some(key => event.affectsConfiguration(key)) ||
          [...runtime.views.values()].some(v => ['editor.bracketPairColorization', 'editor.minimap.enabled', 'editor.fontFamily', 'editor.fontSize', 'editor.fontWeight', 'editor.lineHeight', 'editor.tabSize'].some(key => event.affectsConfiguration(key, { uri: v.source, languageId: 'racket' })))) runtime.themeChanged();
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => runtime.sourceChanged(document.uri, true)),
    vscode.workspace.onDidCloseTextDocument(document => { runtime.sourceChanged(document.uri, true); for (const v of runtime.views.values()) {
      if (!runtime.affected(v, document.uri)) continue;
      if (document.uri.toString() === v.source.toString() && v.source.scheme === 'untitled') v.closedText = document.getText();
      runtime.state(v);
    } }),
    vscode.workspace.onDidSaveTextDocument(document => { for (const v of runtime.views.values()) {
      if (v.source.scheme === 'untitled' && document.uri.scheme === 'file' && !runtime.sourceDocument(v) &&
          document.getText() === (v.closedText || v.mainDocument?.getText())) { v.savedSource = document.uri; runtime.state(v); }
    } }),
    vscode.window.onDidChangeTextEditorSelection(e => { const v = runtime.views.get(e.textEditor.document.uri.toString()); if (v && !runtime.panes(v).some(p => p.panel.active)) v.sourceSelection = e.selections[0]; }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && active && !active.panel.active) { active = null; runtime.clearFocus(); runtime.contexts(); }
    }),
    { dispose() { disposed = true; for (const v of runtime.views.values()) { clearTimeout(v.hiddenTimer); for (const pane of runtime.panes(v)) runtime.abortTransfer(pane, 'Extension stopped'); runtime.stopWorker(v); }
      for (const p of runtime.workers) void p.stop(); runtime.clearFocus(); runtime.views.clear(); } });

  return runtime.open;
}
module.exports = { registerMacroStepper, macroTarget, sourceOffsets, panelHtml, viewType };
