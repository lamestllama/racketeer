// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

// The editor a command acts on: the one in the active group showing the active
// tab. While the window has no focus, activeTextEditor can stay on another
// group's editor, or on the same document in another group with another cursor.
function selectedEditor(window) {
  const group = window.tabGroups?.activeTabGroup;
  const uri = group?.activeTab?.input?.uri;
  return (uri && window.visibleTextEditors?.find(editor =>
    editor.viewColumn === group.viewColumn && editor.document.uri.toString() === uri.toString()))
    || window.activeTextEditor;
}

module.exports = { selectedEditor };
