// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Loads positions and inspections and maintains navigation and selection state.
'use strict';
const { decodeTerm } = require('../macro-stepper-codec');
const Model = require('../macro-view/model');
const Data = require('../macro-view-data');
function createNavigation(runtime) {
  async function position(v, number) {
    v = runtime.owner(v);
    const projection = v.positions.get(number);
    if (projection) return projection;
    const numbering = v.numberingRevision;
    const key = `${v.generation}:${numbering}:${number}`;
    if (!v.positionLoads.has(key)) {
      const gen = v.generation, summary = v.data;
      const pending = runtime.queryWorker(v, { mode: 'position', snapshot: summary.snapshot, position: number, panes: true,
        factorCommonContext: v.factorCommonContext, ...(v.retainTerminalBefore ? { retainTerminalBefore: true } : {}), ...(v.trackSyntaxSelection ? { syntaxIdentities: true } : {}), suffixOption: v.alwaysSuffixMarkedIdentifiers ? 'always' : 'over-limit' }).then(reply => {
        const result = Data.validatePosition(reply, summary, number);
        if (runtime.current(v, gen) && v.numberingRevision === numbering) { v.positions.set(number, result); Object.assign(v.data.sources, result.sources); }
        return result;
      }).finally(() => v.positionLoads.delete(key));
      v.positionLoads.set(key, pending);
    }
    return v.positionLoads.get(key);
  }
  async function positionForPane(v, number) {
    const gen = v.generation, rev = v.positionRevision;
    const projection = await position(v, number);
    if (!runtime.current(v, gen, rev)) return projection;
    if (v.side === 'before' && !projection.record && !projection.terminalBefore && v.data.steps.length) {
      // Retain a displayed input without requesting an unvisited reduction
      // when navigation jumps straight to the finished program.
      const last = runtime.owner(v).positions.get(v.data.steps.length);
      if (last?.record.before) return { ...projection, pane: v.side, terminalBefore: last.record.before,
        terminalPosition: v.data.steps.length,
        terms: { ...last.terms, ...projection.terms }, sources: { ...last.sources, ...projection.sources } };
    }
    return { ...projection, pane: v.side };
  }
  function restoreSelection(v) {
    if (!runtime.owner(v).trackSyntaxSelection) return;
    const identity = runtime.owner(v).selectedIdentity;
    v.selection = null;
    if (!identity || !v.projection) return;
    for (const { section } of Model.sections(v.projection)) {
      const occurrence = section.occurrences.find(o => (v.projection.terms[o.syntaxId]?.identity || o.syntaxId) === identity);
      if (occurrence) { v.selection = { sectionId: section.id, occurrenceId: occurrence.id }; return; }
    }
  }
  async function rememberSelection(v) {
    v = runtime.owner(v);
    if (v.trackSyntaxSelection) return;
    const pane = runtime.panes(v).find(p => p.selection && Model.find(p.projection, p.selection));
    v.trackSyntaxSelection = true;
    if (!pane) return;
    const answer = await runtime.queryWorker(v, { mode: 'position', snapshot: v.data.snapshot,
      position: pane.projection.terminalPosition || v.position, panes: true,
      factorCommonContext: v.factorCommonContext, syntaxIdentities: true,
      suffixOption: v.alwaysSuffixMarkedIdentifiers ? 'always' : 'over-limit' });
    const found = Model.find(pane.projection, pane.selection);
    v.selectedIdentity = answer.terms?.[found.occurrence.syntaxId]?.identity || found.occurrence.syntaxId;
  }
  async function selectSyntax(v, target) {
    const found = Model.find(v.projection, target);
    runtime.owner(v).selectedIdentity = found ? v.projection.terms[found.occurrence.syntaxId]?.identity || found.occurrence.syntaxId : null;
    for (const pane of runtime.panes(v)) restoreSelection(pane);
    // Keep the clicked occurrence when that syntax occurs more than once.
    v.selection = target;
    for (const pane of runtime.panes(v)) await sendSelection(pane);
  }
  async function show(v, preserveSelection = false) { await Promise.all(runtime.panes(v).map(pane => showPane(pane, preserveSelection))); }
  async function showPane(v, preserveSelection = false) {
    const gen = v.generation, rev = v.positionRevision, position = v.position;
    runtime.abortTransfer(v, 'Position changed');
    v.projection = null; v.colorReady = false; runtime.paneState(v);
    try {
      if (!v.data) { v.projection = null; return; }
      const projection = await positionForPane(v, position);
      if (!runtime.current(v, gen, rev)) return;
      v.projection = projection; restoreSelection(v); runtime.paneState(v);
      const colors = await runtime.painted(v, projection);
      if (!runtime.current(v, gen, rev)) return;
      const delivered = await runtime.transfer(v, { ...projection, ...colors, preserveSelection, ...(v.suppressSelection ? { suppressSelection: true } : {}) });
      if (runtime.current(v, gen, rev) && delivered) await sendSelection(v);
      if (runtime.current(v, gen, rev)) await runtime.follow(v);
    } catch (error) {
      if (runtime.current(v, gen, rev)) void runtime.post(v, 'actionResult', { success: false, message: error.message });
    }
  }
  function facts(v, syntaxId) { return v.inspected.get(syntaxId) || null; }
  async function inspectTerm(v, tid, phases) {
    const gen = v.generation, rev = v.positionRevision,
      position = v.projection?.terminalPosition || v.position;
    const reply = await runtime.queryWorker(v, { mode: 'inspect', snapshot: v.data.snapshot, position, term: tid, ...(phases ? { phases } : {}) });
    if (!runtime.current(v, gen, rev)) return;
    if (reply.failed) throw Error(reply.failed);
    if (reply.schemaVersion !== 2 || reply.mode !== 'inspect' || !Data.sameSnapshot(reply.snapshot, v.data.snapshot) ||
        reply.term !== tid || reply.position !== position) throw Error('Invalid inspection reply');
    Data.validateShared(reply.shared);
    const term = decodeTerm(reply.shared, reply.termData), old = facts(v, tid);
    if (reply.sources) Object.assign(v.data.sources, reply.sources);
    v.inspected.set(tid, old ? Data.mergeInspection(old, term) : term);
  }
  async function sendSelection(v) {
    const gen = v.generation, rev = v.positionRevision, selection = v.selection;
    const f = runtime.selected(v);
    if (f && !facts(v, f.occurrence.syntaxId)) {
      try { await inspectTerm(v, f.occurrence.syntaxId); }
      catch (error) { if (runtime.current(v, gen, rev)) void runtime.post(v, 'actionResult', { success: false, message: error.message }); }
    }
    if (!runtime.current(v, gen, rev) || v.selection !== selection) return;
    const term = f && facts(v, f.occurrence.syntaxId);
    const witness = runtime.panes(v).map(p => p.selection).find(pair => Model.find({ ...v.projection, pane: undefined }, pair));
    const payload = { selected: v.selection, ...(runtime.owner(v).trackSyntaxSelection ? { identity: runtime.owner(v).selectedIdentity || null } : {}), syntaxId: f?.occurrence.syntaxId || null,
      related: runtime.owner(v).trackSyntaxSelection
        ? witness ? Model.bindingOccurrences({ ...v.projection, pane: undefined }, witness).filter(pair => Model.find(v.projection, pair)) : []
        : Model.bindingOccurrences(v.projection || { terms: {}, diagnostics: {} }, v.selection), properties: term,
      sourceLocation: term ? runtime.sourceLocation(v, term.source) : null,
      actions: { copyTerm: !!f, goToSource: !!f && runtime.navigable(v) } };
    if (v.ready && v.transfer?.kind !== 'position') {
      if (v.transfer) runtime.abortTransfer(v, 'Selection changed');
      await runtime.transfer(v, payload, 'selection');
    }
    runtime.state(v);
  }
  async function navigate(v, action, value) {
    v = runtime.owner(v);
    if (!v?.data || v.busy) return;
    runtime.sessions.touch(runtime.recordingOf(v));
    const count = v.data.steps.length + 1;
    const next = action === 'start' ? 1 : action === 'end' ? count : action === 'next' ? Math.min(count, v.position + 1)
      : action === 'previous' ? Math.max(1, v.position - 1) : Model.jump(value, count);
    v.navigationPoint = next === count ? 'end' : v.data.steps[next - 1].expansionPoint;
    if (next === v.position && action !== 'jump') return;
    v.inspected.clear();
    v.position = next; for (const pane of runtime.panes(v)) { pane.suppressSelection = false; pane.selection = null; pane.textSelections = []; pane.pins = []; pane.focused = null; pane.positionRevision++; }
    await show(v);
  }
  async function resetNumbering(v, grouping = runtime.owner(v).foregroundGrouping) {
    v = runtime.owner(v);
    if (!v.data || v.busy) return;
    const gen = v.generation;
    v.retainTerminalBefore = runtime.panes(v).some(p => !!p.projection?.terminalBefore);
    v.busy = true; runtime.state(v);
    try {
      const answer = await runtime.queryWorker(v, { mode: 'configure', snapshot: v.data.snapshot, grouping });
      if (!runtime.current(v, gen)) return;
      Data.validateAnswer(answer, v.data.snapshot);
      v.numberingReset = true; v.foregroundGrouping = grouping; v.nextGroup = 1; v.numberingRevision++;
      v.numberingBase = { ...v.expansionRequest, grouping, nextGroup: 1 };
      const recording = runtime.recordingOf(v);
      if (!recording.pinned) recording.numberingBase = v.numberingBase;
      v.numberingHistory = []; v.numberingSeen.clear();
      v.positions.clear(); v.inspected.clear();
      for (const pane of runtime.panes(v)) pane.positionRevision++;
    } finally {
      if (runtime.current(v, gen)) { v.busy = false; await show(v, true); }
    }
  }
  async function redrawLayout(v) {
    v = runtime.owner(v);
    v.numberingRevision++; v.positions.clear();
    // The worker partition and replay journal survive layout redraws.
    for (const pane of runtime.panes(v)) pane.positionRevision++;
    await show(v, true);
  }
  async function inspectMore(v, requestedPhases) {
    const f = runtime.selected(v); if (!f) return;
    const tid = f.occurrence.syntaxId, gen = v.generation, rev = v.positionRevision;
    if (!facts(v, tid)) await inspectTerm(v, tid);
    if (!runtime.current(v, gen, rev)) return;
    const old = facts(v, tid); if (!old) return;
    const phases = (requestedPhases || v.data.availablePhases).filter(p => !old.inspectedPhases.includes(p));
    if (phases.length) await inspectTerm(v, tid, phases);
    await sendSelection(v);
  }
  return { show, navigate, rememberSelection, selectSyntax, sendSelection, facts, inspectTerm, inspectMore, showPane, resetNumbering, redrawLayout };
}
module.exports = { createNavigation };
