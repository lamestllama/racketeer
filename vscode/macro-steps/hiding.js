// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Owns the macro hiding policy, pickers and shared identifier rules.
'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
function createHiding(runtime) {
  const freshCustom = () => ({ enabled: true, racket: true, library: true, contracts: true, phase: true, rules: [] });
  let custom = freshCustom();
  const customFor = v => runtime.owner(v).localCustom || custom;
  function setCustom(v, value) { if (runtime.owner(v).localCustom) runtime.owner(v).localCustom = value; else custom = value; }
  let savedHiding = runtime.context.workspaceState.get('macroSteps.hiding', 'none');
  const customSwitches = [
    ['enabled', 'Enable macro hiding'], ['racket', 'Hide racket syntax'],
    ['library', 'Hide library syntax'], ['contracts', 'Hide contracts (heuristic)'], ['phase', 'Hide phase>0']
  ];
  async function applyCustom(v, choose = false) {
    if (choose) { runtime.owner(v).hiding = 'custom'; runtime.savedHiding = 'custom'; }
    if (runtime.owner(v).localCustom) {
      if (v.data) await runtime.load(v, 'custom', false, false, true);
      return;
    }
    // Unshared Custom views retain the session policy, including hidden tabs.
    // Re-expansions use the admission queue and resident-worker bound.
    for (const view of runtime.views.values()) {
      if (!view.localCustom && view.hiding === 'custom' && view.data) await runtime.load(view, 'custom', false, false, true);
      else runtime.state(view);
    }
  }
  let hidingPick = null;
  function pickHiding(items, options) {
    return new Promise(resolve => {
      const picker = vscode.window.createQuickPick();
      picker.title = options.title;
      picker.placeholder = options.placeHolder;
      picker.canSelectMany = !!options.canPickMany;
      picker.items = items;
      picker.selectedItems = options.canPickMany ? items.filter(item => item.picked) : [];
      picker.activeItems = [items.find(item => item.description === 'Current') || items[0]].filter(Boolean);
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        if (hidingPick?.picker === picker) hidingPick = null;
        picker.hide();
        for (const listener of listeners) listener.dispose();
        picker.dispose();
        resolve(result);
      };
      const accept = () => {
        if (finished) return;
        // Focus and checked items are independent in a checklist. Enter applies
        // the checked set, including an empty set; it never toggles the focus.
        const result = picker.canSelectMany ? [...picker.selectedItems] : picker.selectedItems[0] || picker.activeItems[0];
        if (result !== undefined) finish(result);
      };
      const listeners = [picker.onDidAccept(accept), picker.onDidHide(() => finish(undefined))];
      // The isolated test host uses the same accept handler as the workbench.
      hidingPick = { picker, accept };
      picker.show();
    });
  }
  async function hidingPicker(v) {
    const mode = v.hiding === 'none' ? 'disable' : v.hiding === 'custom' ? 'custom' : 'standard';
    const choice = await pickHiding([
      { label: 'Standard', value: 'standard' }, { label: 'Disable', value: 'disable' }, { label: 'Custom...', value: 'custom' }
    ].map(item => ({ ...item, description: item.value === mode ? 'Current' : undefined })), { title: 'Macro Hiding' });
    if (!choice || !runtime.current(v)) return;
    if (choice.value !== 'custom') return runtime.action(v, { type: 'setHiding', mode: choice.value });
    const custom = customFor(v);
    const picked = await pickHiding(customSwitches.map(([key, label]) => ({ key, label, picked: custom[key] })),
      { title: 'Custom Macro Hiding', canPickMany: true });
    if (!picked || !runtime.current(v)) return;
    setCustom(v, { ...custom, ...Object.fromEntries(customSwitches.map(([key]) => [key, picked.some(item => item.key === key)])) });
    return applyCustom(v, true);
  }
  async function hidingRules(v) {
    const custom = customFor(v);
    const chosen = await pickHiding(custom.rules.map(rule => ({ label: rule.label, id: rule.id })),
      { title: 'Macro Hiding Rules', placeHolder: 'Select rules to delete', canPickMany: true });
    if (!chosen?.length) return;
    setCustom(v, { ...custom, rules: custom.rules.filter(rule => !chosen.some(item => item.id === rule.id)) });
    return applyCustom(v);
  }
  async function identifierRule(v, action) {
    const custom = customFor(v);
    if (v.busy) throw Error('Expansion is busy');
    const found = runtime.selected(v);
    if (!found || v.projection.terms[found.occurrence.syntaxId].kind !== 'identifier') throw Error('Select an identifier for a macro hiding rule');
    const gen = v.generation, rev = v.positionRevision;
    const rule = await runtime.queryWorker(v, { mode: 'hidingRule', snapshot: v.data.snapshot,
      position: v.projection.terminalPosition || v.position, term: found.occurrence.syntaxId,
      id: randomBytes(16).toString('hex'), action, rules: custom.rules });
    if (!runtime.current(v, gen, rev)) return;
    if (rule.failed) throw Error(rule.failed);
    if (rule.action !== action || typeof rule.syntax !== 'string' || !Array.isArray(rule.replaces)) throw Error('Invalid macro hiding rule');
    setCustom(v, { ...custom, rules: [rule, ...custom.rules.filter(old => !rule.replaces.includes(old.id))] });
    return applyCustom(v, true);
  }
  return { customFor, freshCustom,
    get savedHiding() { return savedHiding; },
    set savedHiding(value) { savedHiding = value; void runtime.context.workspaceState.update('macroSteps.hiding', value); },
    hidingPicker,
    hidingRules,
    identifierRule,
    get hidingPick() { return hidingPick; },
    set hidingPick(value) { hidingPick = value; }
  };
}
module.exports = { createHiding };
