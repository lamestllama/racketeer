// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Owns paired panels, titles, restoration and placement.
'use strict';
const vscode = require('vscode');
const { selectedEditor } = require('../selected-editor');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Model = require('../macro-view/model');
const Data = require('../macro-view-data');
const { macroTarget } = require('./target');
const { panelHtml } = require('./html');
const { viewType } = require('./html');
function createPanes(runtime) {
  const owner = v => v.owner || v;
  const panes = v => owner(v).panes || [v];
  const broadcast = (v, type, fields) => Promise.all(panes(v).map(p => runtime.post(p, type, fields)));
  function activePane() {
    // Workbench focus can move before onDidChangeViewState updates our cache
    // or the panels' active flags. Resolve the selected tab at dispatch time.
    const group = vscode.window.tabGroups?.activeTabGroup, tab = group?.activeTab;
    const candidates = [...runtime.views.values()].flatMap(panes).filter(v => runtime.current(v));
    if (tab) {
      if (!(tab.input instanceof vscode.TabInputWebview) || !tab.input.viewType.endsWith(viewType)) return null;
      const groupPanes = candidates.filter(v => v.panel.viewColumn === group.viewColumn);
      const pane = groupPanes.find(v => v.tab === tab) || groupPanes.find(v => v.panel.title === tab.label) ||
        (groupPanes.length === 1 ? groupPanes[0] : null);
      if (pane) { pane.tab = tab; return pane; }
      return null;
    }
    return candidates.find(v => v.panel.active) || null;
  }
  function selected(v) { return v.projection && Model.find(v.projection, v.selection); }
  function navigable(v) {
    const location = selected(v) && v.projection.terms[selected(v).occurrence.syntaxId].source;
    const s = location && v.data.sources[location.sourceId];
    return !!s && (s.kind === 'file' && path.isAbsolute(s.value) && fs.existsSync(s.value) || s.kind === 'untitled' && s.value === v.source.toString() && !!runtime.sourceDocument(v));
  }
  function title(v) {
    const file = path.basename(v.source.fsPath || v.source.path), count = v.data ? v.data.steps.length + 1 : 1;
    const metadata = v.data?.steps[v.position - 1];
    const counter = `Step ${v.position} of ${count}`;
    const status = v.busy ? 'Expanding' : v.failure ? 'Error' : !v.data ? 'Macro steps' :
      v.side === 'before' ? counter :
      v.projection?.error || metadata?.kind === 'error' || !metadata && v.data.error ? 'Error' :
      !metadata ? 'Finished' : `[${metadata.label}]${metadata.macro ? ` ${metadata.macro}` : ''}`;
    v.panel.title = `${v.side === 'before' ? 'Before' : 'After'} - ${status} - ${file}${v.hiding === 'custom' && runtime.customFor(v).enabled ? ' (Custom)' : ''}`;
  }
  function state(v) { for (const pane of panes(v)) paneState(pane); }
  function paneState(v) {
    title(v);
    if (activePane() === v) runtime.contexts();
    void runtime.post(v, 'state', { position: v.busy ? 1 : v.position, count: v.busy ? 1 : v.data ? v.data.steps.length + 1 : 1,
      busy: v.busy, atStart: v.position === 1, atEnd: !v.data || v.position === v.data.steps.length + 1,
      hiding: v.hiding === 'none' ? 'disable' : v.hiding === 'custom' ? 'custom' : 'standard', lineReveal: v.hiding === 'line' ? v.lines : null,
      selected: v.selection, pins: v.pins,
      propertiesVisible: v.propertiesVisible, splitFraction: v.splitFraction,
      oneTermAtATime: v.oneTermAtATime, factorCommonContext: v.factorCommonContext,
      highlightRedexContractum: v.highlightRedexContractum, drawBindingArrows: v.drawBindingArrows,
      taintIcons: v.taintIcons,
      hasSelection: !!selected(v), hasSource: navigable(v), refreshAvailable: runtime.refreshAvailable(v),
      source: v.source.toString(), wholeFile: v.wholeFile, range: v.invocationSelection ? [v.invocationSelection.start.line, v.invocationSelection.start.character, v.invocationSelection.end.line, v.invocationSelection.end.character] : null,
      savedSourceAvailable: !!v.savedSource, error: v.failure || null });
  }
  function attach(panel, source, editor, wholeFile, selection, pairOwner, side = 'before', viewKey = source.toString()) {
    const pref = runtime.context.workspaceState.get('macroSteps.presentation', {});
    const v = { panel, side, suppressSelection: !!pairOwner?.suppressSelection, source, mainDocument: editor?.document, column: editor?.viewColumn || vscode.ViewColumn.One, sourceSelection: selection, invocationSelection: selection,
      wholeFile, sessionId: randomBytes(16).toString('hex'), generation: 0, positionRevision: 0,
      position: 1, navigationPoint: null, ...runtime.initialOptions(source), alwaysSuffixMarkedIdentifiers: false, hiding: 'standard', foregroundGrouping: 'macro', nextGroup: 1, numberingRevision: 0, numberingHistory: [], numberingSeen: new Set(), pins: [], selection: null, textSelections: [], inspected: new Data.RecentCache(32, 8 * 1024 * 1024), positions: new Data.RecentCache(), positionLoads: new Map(),
      propertiesVisible: pref.propertiesVisible || false, splitFraction: pref.splitFraction || 1 / 3,
      testEnabled: runtime.context.extensionMode === vscode.ExtensionMode.Test, testWaiters: new Map() };
    if (pairOwner) {
      v.owner = pairOwner;
      for (const key of ['source', 'mainDocument', 'column', 'sourceSelection', 'invocationSelection', 'wholeFile',
        'sessionId', 'generation', 'position', 'navigationPoint', 'includeRenamingSteps', 'oneTermAtATime', 'factorCommonContext', 'alwaysSuffixMarkedIdentifiers', 'highlightRedexContractum', 'drawBindingArrows', 'hiding', 'inspected', 'positions', 'positionLoads',
        'taintIcons', 'data', 'busy', 'failure', 'target', 'lines', 'snapshotText', 'pendingSnapshot', 'changedDependencies',
        'expansionRequest', 'foregroundGrouping', 'nextGroup', 'numberingRevision', 'numberingBase', 'numberingHistory', 'numberingSeen', 'fragment', 'worker', 'hiddenTimer', 'stale', 'savedSource', 'closedText', 'disposed']) {
        Object.defineProperty(v, key, { get: () => pairOwner[key], set: value => { pairOwner[key] = value; }, configurable: true });
      }
      pairOwner.panes.push(v);
    } else v.panes = [v];
    const assets = vscode.Uri.joinPath(runtime.context.extensionUri, 'macro-view');
    panel.webview.html = panelHtml(panel.webview, runtime.context.extensionUri);
    panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [assets, vscode.Uri.joinPath(runtime.context.extensionUri, 'out/monaco')] };
    panel.webview.onDidReceiveMessage(m => { void runtime.receive(v, m); });
    panel.onDidChangeViewState(() => {
      runtime.visibility(v);
      if (panel.active) { runtime.sessions.touch(runtime.recordingOf(v)); runtime.active = v; runtime.contexts(); if (v.data) void runtime.follow(v); }
      else if (runtime.active === v) { runtime.active = null; v.focusWithin = false; v.inputFocus = false; runtime.clearFocus(); runtime.contexts(); }
    });
    panel.onDidDispose(() => {
      const pair = owner(v); if (pair.disposed) return;
      pair.disposed = true; clearTimeout(pair.hiddenTimer);
      for (let i = runtime.waiting.length - 1; i >= 0; i--) if (runtime.waiting[i].v === pair) runtime.waiting.splice(i, 1)[0].resolve(false);
      for (const pane of panes(pair)) {
        runtime.abortTransfer(pane, 'Panel closed');
        for (const waiter of pane.testWaiters.values()) waiter.resolve(null); pane.testWaiters.clear();
        if (pane !== v) pane.panel.dispose();
      }
      void runtime.releaseRecording(pair); runtime.views.delete(pair.viewKey);
      if (panes(pair).includes(runtime.active)) { runtime.active = null; runtime.clearFocus(); runtime.contexts(); }
      pair.data = null; pair.positions.clear(); pair.inspected.clear();
    });
    if (!pairOwner) { v.viewKey = viewKey; runtime.views.set(v.viewKey, v); }
    runtime.active = panel.active ? v : runtime.active;
    runtime.visibility(v);
    return v;
  }
  async function completePair(v) {
    // Split the group beside the source using the workbench's public command.
    v.panel.reveal(v.panel.viewColumn, false);
    await vscode.commands.executeCommand('workbench.action.newGroupBelow');
    if (!runtime.current(v)) return;
    const panel = vscode.window.createWebviewPanel(viewType, 'After',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { retainContextWhenHidden: true, enableFindWidget: false });
    attach(panel, v.source, null, v.wholeFile, v.invocationSelection, v, 'after');
    v.panel.reveal(v.panel.viewColumn, false); runtime.active = v;
  }
  runtime.context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(viewType, {
    async deserializeWebviewPanel(panel, saved) {
      const source = saved?.source && vscode.Uri.parse(saved.source);
      if (!source || !['file', 'untitled'].includes(source.scheme)) { panel.dispose(); return; }
      const selection = saved.range ? new vscode.Selection(...saved.range) : new vscode.Selection(0, 0, 0, 0);
      const key = typeof saved.pairId === 'string' && saved.pairId.length <= 200 ? saved.pairId : source.toString();
      const existing = runtime.views.get(key), side = saved.side === 'after' ? 'after' : 'before';
      if (existing?.panes.some(p => p.side === side)) { panel.dispose(); return; }
      const v = attach(panel, source, null, !!saved.wholeFile, selection, existing, side, key);
      // Current panes restore into their saved workbench groups. Legacy saved
      // single views acquire a second pane with the new default placement.
      if (!saved.side) await completePair(v);
      state(v);
    }
  }));
  async function open(wholeFile = false) {
    if (runtime.disposed) throw Error('The macro stepper has stopped');
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before expanding Racket macros.');
    const fromPanel = activePane();
    if (fromPanel?.source.scheme === 'untitled' && !runtime.sourceDocument(fromPanel)) throw Error('The source is unavailable. Open its saved source or another Racket buffer.');
    const editor = fromPanel ? { document: runtime.sourceDocument(fromPanel) || await vscode.workspace.openTextDocument(fromPanel.source),
      viewColumn: fromPanel.column, selection: fromPanel.sourceSelection } : selectedEditor(vscode.window);
    macroTarget(editor, wholeFile);
    const key = editor.document.uri.toString(); let v = runtime.views.get(key);
    if (!v) {
      const panel = vscode.window.createWebviewPanel(viewType, `Macro steps - ${path.basename(editor.document.uri.fsPath || editor.document.uri.path)}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true, enableFindWidget: false });
      v = attach(panel, editor.document.uri, editor, wholeFile, editor.selection);
      await completePair(v);
    } else { v.wholeFile = wholeFile; v.sourceSelection = editor.selection; v.invocationSelection = editor.selection; v.panel.reveal(v.panel.viewColumn, false); }
    v.mainDocument = editor.document;
    runtime.active = v; v.hiding = 'standard';
    await runtime.load(v, 'standard');
  };
  async function duplicate(v, currentOnly = false) {
    v = owner(v);
    if (v.busy || currentOnly && !v.data) return;
    const gen = v.generation;
    let summary;
    const key = `duplicate:${randomBytes(16).toString('hex')}`;
    const workerView = randomBytes(16).toString('hex');
    const hiding = runtime.savedHiding;
    const options = runtime.initialOptions(v.source);
    const custom = runtime.freshCustom();
    if (v.data) {
      summary = await runtime.queryWorker(v, { mode: 'duplicate', snapshot: v.data.snapshot,
        newView: workerView, hiding, custom, includeRenamingSteps: options.includeRenamingSteps, oneTermAtATime: options.oneTermAtATime });
      if (!runtime.current(v, gen)) return;
    }
    const panel = vscode.window.createWebviewPanel(viewType, 'Before',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true, enableFindWidget: false });
    const copy = attach(panel, v.source, null, v.wholeFile, v.invocationSelection, null, 'before', key);
    // Only captured provenance is shared. Every control and printed cache is local.
    for (const name of ['target', 'snapshotText', 'pendingSnapshot', 'fragment', 'mainDocument', 'column', 'savedSource']) copy[name] = v[name];
    Object.assign(copy, options, { hiding, localCustom: custom, independentOptions: true });
    copy.suppressSelection = true;
    copy.trackSyntaxSelection = !!(copy.oneTermAtATime || copy.factorCommonContext);
    v.independentOptions = true;
    v.localCustom ||= { ...runtime.customFor(v), rules: [...runtime.customFor(v).rules] };
    if (summary) {
      copy.data = summary; copy.workerView = workerView; copy.recording = v.recording;
      copy.recording.members.add(copy); copy.worker = v.worker;
      copy.worker.prepared.add(copy);
      copy.expansionRequest = { ...v.expansionRequest, hiding, custom, ...options, grouping: 'macro', nextGroup: 1, suffixOption: 'over-limit' };
      copy.numberingBase = copy.expansionRequest;
      copy.checkpointDecisions = v.checkpointDecisions;
      copy.changedDependencies = new Set(v.changedDependencies || []);
    }
    await completePair(copy);
    if (!runtime.current(copy)) return;
    runtime.state(copy); await runtime.show(copy);
  }
  async function removeTerm(v) {
    v = owner(v);
    if (v.busy || !v.data) return;
    ++v.generation;
    const released = runtime.releaseRecording(v);
    v.data = null; v.position = 1; v.navigationPoint = null; v.selectedIdentity = null;
    v.positions.clear(); v.inspected.clear(); v.numberingHistory = []; v.numberingSeen.clear();
    for (const pane of panes(v)) {
      pane.projection = null; pane.selection = null; pane.textSelections = []; pane.pins = []; pane.positionRevision++;
      runtime.abortTransfer(pane, 'Term removed');
      await runtime.post(pane, 'init', { source: v.source.toString(), wholeFile: v.wholeFile, testEnabled: v.testEnabled });
      await runtime.post(pane, 'clear');
    }
    state(v);
    await released;
  }
  return { duplicate, removeTerm, activePane, selected, navigable, panes, broadcast, owner, paneState, state, open };
}
module.exports = { createPanes };
