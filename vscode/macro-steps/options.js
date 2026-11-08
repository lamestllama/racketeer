// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Applies persistent display settings and the window's suffix checkbox.
'use strict';
const vscode = require('vscode');
function createOptions(runtime) {
  const defaults = { includeRenamingSteps: false, oneTermAtATime: false, factorCommonContext: false, highlightRedexContractum: true, drawBindingArrows: true, taintIcons: 'codicons' };
  const configuration = source => vscode.workspace.getConfiguration('racketdap.macroSteps', source);
  function settingTarget(settings, name) {
    const scope = settings.inspect(name);
    return scope?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : scope?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  }
  async function taintIcons(v) {
    v = runtime.owner(v);
    const choices = [{ label: 'Codicons', value: 'codicons' }, { label: 'Unicode', value: 'unicode' }, { label: 'Do not show', value: 'none' }];
    const choice = await vscode.window.showQuickPick(choices.map(c => ({ ...c, picked: c.value === v.taintIcons })), { title: 'Taint Icons' });
    if (choice) {
      const settings = configuration(v.source);
      if (v.independentOptions) applyOptions(v, { taintIcons: choice.value });
      await settings.update('taintIcons', choice.value, settingTarget(settings, 'taintIcons'));
    }
  }
  function initialOptions(source) {
    const settings = configuration(source);
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, settings.get(key, value)]));
  }
  function applyOptions(v, next) {
    const positionsChanged = Object.hasOwn(next, 'includeRenamingSteps') && v.includeRenamingSteps !== next.includeRenamingSteps;
    Object.assign(v, next);
    if (!v.drawBindingArrows) for (const pane of runtime.panes(v)) pane.pins = [];
    runtime.state(v);
    if (positionsChanged && v.data && !v.loading) v.optionUpdates = runtime.load(v, v.hiding, false, false, true, true);
  }
  async function settingsChanged(event) {
    const updates = [];
    for (const v of runtime.views.values()) {
      if (!Object.keys(defaults).filter(key => !['oneTermAtATime', 'factorCommonContext'].includes(key)).some(key => event.affectsConfiguration(`racketdap.macroSteps.${key}`, v.source))) continue;
      if (!runtime.current(v) || v.independentOptions) continue;
      const next = initialOptions(v.source);
      delete next.oneTermAtATime; delete next.factorCommonContext;
      applyOptions(v, next);
      if (v.optionUpdates) updates.push(v.optionUpdates);
    }
    await Promise.all(updates);
  }
  runtime.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    void settingsChanged(event).catch(error => {
      if (runtime.active) void runtime.post(runtime.active, 'actionResult', { success: false, message: error.message });
    });
  }));
  async function toggleOption(v, name) {
    v = runtime.owner(v);
    if (v.busy) throw Error('Expansion is busy');
    if (name === 'alwaysSuffixMarkedIdentifiers') {
      v[name] = !v[name]; runtime.state(v);
      return runtime.redrawLayout(v);
    }
    const settings = configuration(v.source), target = settingTarget(settings, name);
    if (['oneTermAtATime', 'factorCommonContext'].includes(name)) {
      await runtime.rememberSelection(v);
      v[name] = !v[name]; runtime.state(v);
      await settings.update(name, v[name], target);
      if (v.data && !v.loading) {
        if (name === 'oneTermAtATime') await runtime.load(v, v.hiding, false, false, true, true, true);
        else if (!v.oneTermAtATime) await runtime.redrawLayout(v);
      }
      if (!v.oneTermAtATime && !v.factorCommonContext) {
        v.trackSyntaxSelection = false; v.selectedIdentity = null;
        for (const pane of runtime.panes(v)) await runtime.sendSelection(pane);
      }
      return;
    }
    const value = !v[name];
    if (v.independentOptions) applyOptions(v, { [name]: value });
    await settings.update(name, value, target);
    // Unshared windows also receive edits from the Settings editor.
    await v.optionUpdates;
  }
  return { initialOptions, toggleOption, taintIcons };
}
module.exports = { createOptions };
