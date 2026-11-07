// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Resolves editor settings and refreshes rendered token colors.
'use strict';
const vscode = require('vscode');
const { colorPosition } = require('../macro-token-colors');
function createColors(runtime) {
  let colorRevision = 0;
  function editorSettings(v) {
    const settings = vscode.workspace.getConfiguration('editor', { uri: v.source, languageId: 'racket' });
    const tabSize = settings.get('tabSize', 2);
    return { tabSize: Number.isSafeInteger(tabSize) && tabSize > 0 && tabSize <= 32 ? tabSize : 2,
      lineHeight: settings.get('lineHeight', 0), fontFamily: settings.get('fontFamily', ''),
      fontSize: settings.get('fontSize', 14), fontWeight: settings.get('fontWeight', 'normal'),
      minimapEnabled: settings.get('minimap.enabled', true),
      bracketPairColorization: { enabled: settings.get('bracketPairColorization.enabled', true),
        independentColorPoolPerBracketType: settings.get('bracketPairColorization.independentColorPoolPerBracketType', false) }
    };
  }
  async function painted(v, projection) {
    for (;;) {
      const revision = colorRevision;
      const colors = await colorPosition(vscode, runtime.context.extensionUri, projection, v.source, v.testEnabled);
      if (revision === colorRevision) return { ...colors, editorSettings: editorSettings(v) };
    }
  }
  async function recolor(v) {
    if (!v.ready || !v.projection || !runtime.current(v)) return;
    if (v.transfer || !v.colorReady) { v.recolorPending = true; return; }
    v.recolorPending = false;
    const gen = v.generation, rev = v.positionRevision, projection = v.projection;
    try {
      const colors = await painted(v, projection);
      if (!runtime.current(v, gen, rev) || projection !== v.projection) return;
      if (v.transfer) { v.recolorPending = true; return; }
      await runtime.transfer(v, colors, 'colors');
    } catch (error) { if (runtime.current(v, gen, rev)) void runtime.post(v, 'actionResult', { success: false, message: error.message }); }
  }
  function themeChanged() {
    colorRevision++;
    for (const v of runtime.views.values()) for (const pane of runtime.panes(v)) void recolor(pane);
  }
  return { editorSettings, recolor, painted, themeChanged };
}
module.exports = { createColors };
