// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

// The editor a command acts on. activeTextEditor prefers any editor reporting
// text focus, and a window without system focus delivers no blur events, so an
// editor focused there can go on reporting it after focus moves to another group.
// The active group is then right. An editor outside the groups, such as the
// Output panel's, has no view column and stays the active one.
function selectedEditor(window) {
  const editor = window.activeTextEditor;
  const group = window.tabGroups?.activeTabGroup;
  if (!editor?.viewColumn || !group || editor.viewColumn === group.viewColumn) return editor;
  return window.visibleTextEditors?.find(visible => visible.viewColumn === group.viewColumn);
}

module.exports = { selectedEditor };
