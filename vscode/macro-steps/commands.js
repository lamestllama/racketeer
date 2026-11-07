// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Dispatches macro step actions and registers editor commands and contexts.
'use strict';
const vscode = require('vscode');
const Model = require('../macro-view/model');
const Editor = require('../macro-view/monaco');
function createCommands(runtime) {
  function contexts() {
    const v = runtime.activePane(), f = v && runtime.selected(v);
    const ready = !!v?.data && !v.busy;
    const values = { drawBindingArrows: v?.drawBindingArrows !== false,
      ...Model.arrowStatus(v?.projection, v?.selection, v?.pins || []), includeRenamingSteps: !!v?.includeRenamingSteps,
      alwaysSuffixMarkedIdentifiers: !!v?.alwaysSuffixMarkedIdentifiers,
      oneTermAtATime: !!v?.oneTermAtATime, factorCommonContext: !!v?.factorCommonContext,
      highlightRedexContractum: v?.highlightRedexContractum !== false, ready, busy: !!v?.busy, atStart: !v || v.position <= 1,
      atEnd: !v?.data || v.position >= v.data.steps.length + 1, hasSelection: !!f,
      canCopy: !!f || !!v?.textSelections?.some(r => r[0] !== r[1]),
      hasIdentifier: !!f && v.projection.terms[f.occurrence.syntaxId].kind === 'identifier', hasSource: !!f && runtime.navigable(v),
      savedSourceAvailable: !!v?.savedSource, hasPins: !!v?.pins.length, showingAll: v?.hiding === 'none', focusWithin: !!v?.focusWithin, inputFocus: !!v?.inputFocus, menuOpen: !!v?.menuOpen };
    for (const [name, value] of Object.entries(values)) void vscode.commands.executeCommand('setContext', `racketdap.macroSteps.${name}`, value);
  }
  async function action(v, m) {
    if (!runtime.current(v)) return;
    if (m.type === 'navigate' && m.key === 'F10' && vscode.debug.activeDebugSession) {
      if (runtime.activePane() === v) return vscode.commands.executeCommand('workbench.action.debug.stepOver');
      return;
    }
    runtime.sessions.touch(runtime.recordingOf(v));
    if (['navigate', 'setHiding', 'select', 'inspect', 'pin', 'copyTerm', 'goToSource', 'morePhases', 'definition', 'references'].includes(m.type) && v.busy) throw Error('Expansion is busy');
    switch (m.type) {
      case 'navigate': return runtime.navigate(v, m.action, m.position);
      case 'setHiding': runtime.savedHiding = m.mode === 'disable' ? 'none' : m.mode === 'custom' ? 'custom' : 'standard'; return runtime.load(v, m.mode === 'disable' ? 'none' : m.mode === 'custom' ? 'custom' : 'standard', false, false, true);
      case 'refresh': return runtime.load(v);
      case 'openSavedSource': {
        if (!v.savedSource) throw Error('No saved source is available');
        const gen = v.generation;
        const document = await vscode.workspace.openTextDocument(v.savedSource);
        if (!runtime.current(v, gen)) return;
        await vscode.window.showTextDocument(document, { viewColumn: v.column, selection: v.invocationSelection });
        if (runtime.current(v, gen)) return vscode.commands.executeCommand(v.wholeFile ? 'racketdap.stepMacrosInFile' : 'racketdap.stepMacros');
        return;
      }
      case 'retry': return runtime.show(v);
      case 'internalDetails': return runtime.internalDetails(v);
      case 'select': {
        const target = m.sectionId === null ? null : { sectionId: m.sectionId, occurrenceId: m.occurrenceId };
        if (target && !Model.find(v.projection, target)) throw Error('Unknown occurrence');
        const ranges = m.textSelections || [];
        const text = Editor.compose(Model.sections(v.projection)).text;
        if (ranges.some(r => !Model.validRange(text, r))) throw Error('Invalid text selection');
        v.suppressSelection = false; v.textSelections = ranges;
        if (runtime.owner(v).trackSyntaxSelection) return runtime.selectSyntax(v, target);
        v.selection = target; runtime.paneState(v); return runtime.sendSelection(v);
      }
      case 'inspect': {
        const target = { sectionId: m.sectionId, occurrenceId: m.occurrenceId };
        const f = Model.find(v.projection, target);
        if (!f || v.projection.terms[f.occurrence.syntaxId].kind !== 'identifier') throw Error('Unknown name');
        const gen = v.generation, rev = v.positionRevision, tid = f.occurrence.syntaxId;
        try { if (!runtime.facts(v, tid)) await runtime.inspectTerm(v, tid); }
        catch {
          if (runtime.current(v, gen, rev)) await runtime.post(v, 'bindingFacts', { target, bindings: [] });
          return;
        }
        if (runtime.current(v, gen, rev)) await runtime.post(v, 'bindingFacts', { target, bindings: runtime.facts(v, tid)?.bindings || [] });
        return;
      }
      case 'pin': {
        const target = { sectionId: m.sectionId, occurrenceId: m.occurrenceId };
        const attached = Model.incident(v.projection, target);
        if (m.action !== 'clear' && !attached.length) throw Error('No binding connections');
        const released = new Set(attached.map(edge => edge.id));
        if (m.action === 'clear') v.pins = [];
        else if (m.action === 'release') v.pins = v.pins.flatMap(pin => {
          const kept = Model.pinnedEdges(v.projection, pin);
          const edgeIds = kept.filter(edge => pin.sectionId !== target.sectionId || !released.has(edge.id)).map(edge => edge.id);
          return edgeIds.length === kept.length ? [pin] : edgeIds.length ? [{ ...pin, edgeIds }] : [];
        });
        else if (v.drawBindingArrows !== false) {
          const existing = v.pins.find(pin => pin.sectionId === target.sectionId && pin.occurrenceId === target.occurrenceId);
          if (existing) delete existing.edgeIds;
          else if (v.pins.length < 256) v.pins.push(target);
        }
        runtime.state(v); return;
      }
      case 'copyTerm': {
        const program = Editor.compose(Model.sections(v.projection)).text;
        const ranges = (v.textSelections || []).filter(r => r[0] !== r[1]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const text = ranges.length ? ranges.map(r => program.slice(...r)).join('\n') : Model.copy(v.projection, v.selection);
        await vscode.env.clipboard.writeText(text); return 'Copied';
      }
      case 'goToSource': {
        const f = runtime.selected(v); if (!f || !runtime.navigable(v)) throw Error('No navigable source');
        return runtime.revealSource(v, v.projection.terms[f.occurrence.syntaxId].source, true);
      }
      case 'morePhases': return runtime.inspectMore(v, m.phases);
      case 'definition': case 'references': {
        const f = runtime.selected(v); if (!f) return;
        const edges = f.section.edges.filter(e => e.binder === f.occurrence.id || e.reference === f.occurrence.id);
        const targets = [...new Set(edges.flatMap(e => m.type === 'definition' ? [e.binder] : [e.binder, e.reference]))];
        const choices = targets.map(id => { const o = f.section.occurrences.find(o => o.id === id); return { label: f.section.text.slice(...o.range),
          description: edges.filter(e => e.binder === id || e.reference === id).map(e => `${e.certainty}, ${e.phase === null ? 'unknown phase' : e.phase === 'label' ? 'label phase' : `phase ${e.phase}`}`).join('; '), id }; });
        const gen = v.generation, rev = v.positionRevision;
        const choice = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: 'Visible binding connections' });
        if (choice && runtime.current(v, gen, rev)) return runtime.post(v, 'focusTarget', { target: { sectionId: f.section.id, occurrenceId: choice.id } });
        return;
      }
      case 'presentation':
        for (const key of ['propertiesVisible', 'splitFraction']) if (m[key] !== undefined) v[key] = m[key];
        await runtime.context.workspaceState.update('macroSteps.presentation', { propertiesVisible: v.propertiesVisible, splitFraction: v.splitFraction });
        runtime.state(v); return;
      case 'focus':
        if (runtime.activePane() === v) {
          v.focusWithin = m.focusWithin; v.inputFocus = m.inputFocus; v.menuOpen = !!m.menuOpen;
          v.focused = Model.find(v.projection, m.focusedOccurrence) ? m.focusedOccurrence : null; contexts();
        } return;
    }
  }
  const command = (name, callback, termAction = false) => runtime.context.subscriptions.push(vscode.commands.registerCommand(`racketdap.macroSteps.${name}`, async (...args) => {
    const v = runtime.activePane(); if (!v) return;
    try {
      const target = args[0];
      if (termAction && target && typeof target === 'object' && Object.hasOwn(target, 'sectionId')) {
        if (target.sessionId !== v.sessionId || target.generation !== v.generation || target.positionRevision !== v.positionRevision ||
            (target.sectionId || null) !== (v.selection?.sectionId || null) || (target.occurrenceId || null) !== (v.selection?.occurrenceId || null)) throw Error('This term is no longer displayed');
        if (v.busy) throw Error('Expansion is busy');
        if (!runtime.current(v, target.generation, target.positionRevision)) return;
      }
      return await callback(v, ...args);
    } catch (e) { void runtime.post(v, 'actionResult', { success: false, message: e.message }); }
  }));
  for (const [name, direction] of Object.entries({ first: 'start', previous: 'previous', next: 'next', last: 'end' })) command(name, v => runtime.navigate(v, direction));
  command('hiding', v => runtime.hidingPicker(v));
  command('taintIcons', v => runtime.taintIcons(v));
  command('hidingRules', v => runtime.hidingRules(v));
  command('hideMacro', v => runtime.identifierRule(v, 'hide'), true);
  command('showMacro', v => runtime.identifierRule(v, 'show'), true);
  command('showAll', v => action(v, { type: 'setHiding', mode: 'disable' }));
  command('showMine', v => action(v, { type: 'setHiding', mode: 'standard' }));
  for (const name of ['includeRenamingSteps', 'oneTermAtATime', 'factorCommonContext', 'alwaysSuffixMarkedIdentifiers', 'highlightRedexContractum', 'drawBindingArrows']) command(name, v => runtime.toggleOption(v, name));
  command('duplicate', v => runtime.duplicate(v));
  command('duplicateCurrentTerm', v => runtime.duplicate(v, true));
  command('removeSelectedTerm', v => runtime.removeTerm(v));
  command('internalDetails', v => runtime.internalDetails(v));
  command('resetMarkNumbering', v => runtime.resetNumbering(v));
  command('foregroundGrouping', async v => {
    const choice = await vscode.window.showQuickPick([
      { label: 'By macro scopes', value: 'macro' }, { label: 'By all scopes', value: 'all' }
    ], { title: 'Foreground colors' });
    if (choice) return runtime.resetNumbering(v, choice.value);
  });
  command('jump', async (v, value) => {
    const gen = v.generation, rev = v.positionRevision;
    if (typeof value === 'object') value = undefined;
    value ??= await vscode.window.showInputBox({ prompt: `Step 1 to ${v.data?.steps.length + 1}, or end`,
      validateInput: x => { try { Model.jump(x, v.data.steps.length + 1); } catch (e) { return e.message; } } });
    if (value !== undefined && runtime.current(v, gen, rev)) return runtime.navigate(v, 'jump', value);
  });
  for (const type of ['refresh', 'copyTerm', 'goToSource', 'definition', 'references', 'morePhases', 'openSavedSource']) command(type, v => action(v, { type }), !['refresh', 'openSavedSource'].includes(type));
  command('clearSelection', async v => {
    if (runtime.owner(v).trackSyntaxSelection) { await runtime.selectSyntax(v, null); return runtime.broadcast(v, 'collapseSelection'); }
    return runtime.post(v, 'collapseSelection');
  });
  command('properties', v => action(v, { type: 'presentation', propertiesVisible: !v.propertiesVisible }), true);
  command('tack', v => action(v, { type: 'pin', action: 'tack', ...v.selection }), true);
  command('release', v => action(v, { type: 'pin', action: 'release', ...v.selection }), true);
  command('untackAll', v => action(v, { type: 'pin', action: 'clear' }));
  return { contexts, action, command };
}
module.exports = { createCommands };
