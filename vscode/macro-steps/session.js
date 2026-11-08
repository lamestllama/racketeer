// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Owns expansion admission, worker sessions and snapshot loading.
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createMacroSession } = require('./worker-session');
const { createSessionPool } = require('../macro-session-pool');
const { debuggerArgs } = require('../language-process');
const Data = require('../macro-view-data');
const { macroTarget } = require('./target');
const { hash } = require('./target');
function createSession(runtime) {
  let expanding = 0;
  const views = new Map(), workers = new Set(), waiting = [], sessions = createSessionPool(2);
  function pump() {
    while (waiting.length && expanding < 2) {
      const item = waiting.shift();
      if (!runtime.current(item.v, item.gen)) item.resolve(false);
      else { expanding++; item.resolve(true); }
    }
  }
  function acquire(v, gen) { return new Promise(resolve => { waiting.push({ v, gen, resolve }); pump(); }); }
  function release() { expanding--; pump(); }
  const recordingOf = v => runtime.owner(v).recording || runtime.owner(v);
  function pinRecording(v) {
    const recording = recordingOf(v);
    if (!recording.pinned) {
      recording.pinned = recording.worker;
      sessions.forget(recording, recording.worker);
      clearTimeout(recording.hiddenTimer); recording.hiddenTimer = null;
    }
  }
  function useRecording(recording, create, work) {
    return recording.pinned ? work(recording.pinned) : sessions.use(recording, create, work);
  }
  async function stopWorker(v) {
    const recording = recordingOf(v);
    if (recording.pinned) return runtime.disposed ? recording.pinned.stop() : undefined;
    for (const member of recording.members || []) member.worker = null;
    return sessions.stop(recording);
  }
  async function releaseRecording(v) {
    v = runtime.owner(v);
    const recording = v.recording;
    if (!recording) return stopWorker(v);
    recording.members.delete(v); v.recording = null; v.worker = null;
    if (!recording.members.size) {
      recording.disposed = true; clearTimeout(recording.hiddenTimer);
      if (recording.pinned) await recording.pinned.stop();
      else await sessions.stop(recording);
    } else if (recording.worker) {
      const process = recording.worker;
      await process.request({ mode: 'closeView', view: v.workerView || 'main', snapshot: recording.expansionRequest.snapshot }).catch(() => {});
    }
  }
  // A restored session keeps the original source, policy and snapshot identity.
  // Printed positions, selection and pins remain usable while it is absent.
  function makeWorker(v, request, gen, restoring = true) {
    if (!runtime.current(v, gen)) throw Error('Expansion replaced');
    const input = v.numberingBase || request;
    // Rebuilding may rerun transformers, but must follow exactly the choices
    // made for this expansion, including its abandoned checkpoint.
    const decisions = v.checkpointDecisions;
    let checkpointIndex = 0;
    const process = createMacroSession(v.target.executable, debuggerArgs(runtime.context, 'tools/macro-stepper.rkt'), input,
      { async checkpoint() {
        if (!runtime.current(v, gen) || v.worker !== process) throw Error('Expansion replaced');
        if (restoring) {
          if (checkpointIndex++ < decisions.continues) return 'continue';
          if (decisions.stopped && checkpointIndex === decisions.continues + 1) return 'stop';
          throw Error('Restored expansion exceeded its recorded checkpoints. Refresh to try again.');
        }
        const choice = await vscode.window.showWarningMessage(
          'Macro expansion has taken a suspiciously large number of steps.',
          { modal: true, detail: 'Click Stop to stop macro expansion and see the steps taken so far, or click Continue to let it run a bit longer.' },
          { title: 'Continue', isCloseAffordance: true }, { title: 'Stop' });
        if (!runtime.current(v, gen) || v.worker !== process) throw Error('Expansion replaced');
        const decision = choice?.title === 'Stop' ? 'stop' : 'continue';
        if (decision === 'stop') decisions.stopped = true;
        else decisions.continues++;
        return decision;
      }, finished() { workers.delete(process); sessions.forget(v, process); if (v.worker === process) { v.worker = null; for (const member of v.members || []) if (member.worker === process) member.worker = null; } } });
    process.sessionId = randomBytes(12).toString('hex');
    process.restoring = restoring;
    v.worker = process; workers.add(process);
    process.prepared = new WeakSet();
    for (const member of v.members || []) member.worker = process;
    visibility(v);
    return process;
  }
  function progress(v, process, work, delayed = false) {
    let cancel, timer, finishProgress;
    const completed = new Promise(resolve => { finishProgress = resolve; });
    const display = () => {
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Racket: expanding macros', cancellable: true },
        async (_progress, token) => {
          cancel = token.onCancellationRequested(() => { void process.stop(); });
          await completed;
        });
    };
    if (delayed) timer = setTimeout(display, 500); else display();
    process.expandPending = true;
    return Promise.resolve().then(work).finally(() => {
      clearTimeout(timer); finishProgress(); cancel?.dispose(); process.expandPending = false;
    });
  }
  async function startWorker(v, process, gen, delayed) {
    process.initial ||= progress(v, process, async () => {
      const previous = process.restoring ? [...v.members].map(member => ({ member, generation: member.generation, busy: member.busy })) : [];
      for (const { member } of previous) { member.busy = true; runtime.state(member); }
      try { return await process.start(); }
      finally {
        for (const { member, generation, busy } of previous) {
          if (runtime.current(member, generation) && member.recording === v) { member.busy = busy; runtime.state(member); }
        }
      }
    }, delayed);
    try { return await process.initial; }
    catch (error) { await process.stop(); if (runtime.current(v, gen)) throw error; }
  }
  const unavailableRecording = 'The recorded expansion is no longer available. Navigate or refresh before duplicating.';
  async function queryWorker(v, query) {
    v = runtime.owner(v);
    const gen = v.generation, request = v.expansionRequest, recording = recordingOf(v);
    if (query.mode === 'duplicate' && !recording.worker) throw Error(unavailableRecording);
    return useRecording(recording, () => {
      if (query.mode === 'duplicate') throw Error(unavailableRecording);
      return makeWorker(recording, recording.expansionRequest, recording.generation);
    }, async process => {
      if (!runtime.current(v, gen)) return;
      const summary = await startWorker(recording, process, recording.generation, true);
      if (!runtime.current(v, gen)) return;
      Data.validateAnswer(summary, request.snapshot);
      if (summary.failed) throw Error(summary.failed);
      v.worker = process;
      const view = v.workerView;
      if (!process.prepared.has(v)) {
        if (v.numberingReset) {
          const configured = await process.request({ mode: 'configure', snapshot: request.snapshot,
            grouping: v.foregroundGrouping, ...(view ? { view } : {}), replay: true });
          Data.validateAnswer(configured, request.snapshot);
        }
        for (const displayed of (v.numberingHistory || []).slice()) {
          const restored = await process.request({ ...displayed, ...(view ? { view } : {}), replay: true });
          if (restored.failed) throw Error(restored.failed);
        }
        process.prepared.add(v);
      }
      const answer = await process.request({ ...query, ...(view ? { view } : {}) });
      if (runtime.current(v, gen) && !answer?.failed && ['position', 'reexpand', 'configure'].includes(query.mode)) {
        const key = JSON.stringify([v.expansionRequest.hiding, v.expansionRequest.lines, v.expansionRequest.custom, v.expansionRequest.includeRenamingSteps, v.expansionRequest.oneTermAtATime, query.factorCommonContext, query.syntaxIdentities, query.suffixOption, query.position]);
        if (query.mode !== 'position' || !v.numberingSeen.has(key)) {
          v.numberingHistory.push(query);
          if (query.mode === 'position') v.numberingSeen.add(key);
        }
        if (Number.isSafeInteger(answer.nextGroup)) v.nextGroup = Math.max(v.nextGroup, answer.nextGroup);
      }
      if (runtime.current(v, gen) && query.mode === 'reexpand' && !answer.failed) {
        v.expansionRequest = { ...request, hiding: query.hiding, lines: query.lines, custom: query.custom,
          includeRenamingSteps: query.includeRenamingSteps ?? request.includeRenamingSteps,
          oneTermAtATime: query.oneTermAtATime ?? request.oneTermAtATime };
      }
      if (query.mode === 'duplicate') {
        if (!runtime.current(v, gen)) {
          await process.request({ mode: 'closeView', view: query.newView, snapshot: request.snapshot }).catch(() => {});
          return;
        }
        Data.validateAnswer(answer, request.snapshot);
        pinRecording(v);
      }
      return answer;
    });
  }
  async function expand(v, request, hiding, gen) {
    if (!await acquire(v, gen)) return undefined;
    try {
      await releaseRecording(v);
      if (!runtime.current(v, gen)) return;
      const input = { ...request, hiding, custom: runtime.customFor(v), schemaVersion: 2, session: true, snapshot: v.pendingSnapshot,
        grouping: v.foregroundGrouping, nextGroup: v.nextGroup, includeRenamingSteps: v.includeRenamingSteps, oneTermAtATime: v.oneTermAtATime,
        ...(hiding === 'line' ? { lines: v.lines } : {}) };
      v.numberingReset = false; v.numberingBase = input; v.numberingHistory = []; v.numberingSeen.clear();
      v.checkpointDecisions = { continues: 0, stopped: false };
      v.expansionRequest = input; v.workerView = null;
      const recording = { target: v.target, expansionRequest: input, numberingBase: input, generation: gen,
        checkpointDecisions: v.checkpointDecisions, members: new Set([v]), panes: [] };
      v.recording = recording;
      return await sessions.use(recording, () => makeWorker(recording, input, gen, false), async process => {
        process.prepared.add(v);
        return startWorker(recording, process, gen, false);
      });
    } finally { release(); }
  }
  function visibility(v) {
    v = recordingOf(v);
    if (v.pinned) return;
    const visiblePanes = v.members ? [...v.members].flatMap(runtime.panes) : runtime.panes(v);
    if (visiblePanes.some(p => p.panel.visible)) { clearTimeout(v.hiddenTimer); v.hiddenTimer = null; }
    else if (!v.hiddenTimer && !v.disposed) {
      v.hiddenTimer = setTimeout(() => { v.hiddenTimer = null; void stopWorker(v); }, 60000);
      v.hiddenTimer.unref?.();
    }
  }
  async function load(v, hiding = v.hiding, capture = true, lineAnchor = true, reuse = false, restoreNavigation = false, optionRestore = false) {
    v = runtime.owner(v);
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before expanding Racket macros.');
    const gen = ++v.generation; for (const pane of runtime.panes(v)) runtime.abortTransfer(pane, 'New expansion');
    const session = reuse && !!v.data;
    const stopped = session ? undefined : releaseRecording(v);
    if (!session) {
      v.data = null;
      for (const pane of runtime.panes(v)) { pane.projection = null; pane.selection = null; pane.pins = []; }
    }
    v.retainTerminalBefore = false;
    v.loading = v.busy = true; v.failure = null;
    void runtime.broadcast(v, 'init', { source: v.source.toString(), wholeFile: v.wholeFile, testEnabled: v.testEnabled }); runtime.state(v);
    try {
      await stopped;
      if (!runtime.current(v, gen)) return;
      const document = runtime.sourceDocument(v) || (capture && v.source.scheme === 'file' ? await vscode.workspace.openTextDocument(v.source) : null);
      if (!runtime.current(v, gen)) return;
      if (!document && capture) throw Error('The source is unavailable. This is a snapshot-only view.');
      if (capture) {
        v.selectedIdentity = null; v.trackSyntaxSelection = !!(v.oneTermAtATime || v.factorCommonContext);
        let selection = v.invocationSelection;
        if (selection && selection.end.line >= document.lineCount) {
          const end = document.positionAt(document.getText().length);
          selection = new vscode.Selection(new vscode.Position(Math.min(selection.start.line, end.line), 0), end);
        }
        v.invocationSelection = selection;
        v.target = macroTarget({ document, selection }, v.wholeFile);
        v.lines = v.target.range ? [v.target.range.start.line + 1, v.target.range.end.line + 1] : null;
      }
      if (document) v.mainDocument = document;
      const text = v.target.module.text;
      v.pendingSnapshot = session ? v.data.snapshot : { sourceHash: hash(text), sourceVersion: document.version };
      let fragment = false;
      let data;
      if (session) {
        const input = { ...v.expansionRequest, hiding, lines: v.lines, custom: runtime.customFor(v), includeRenamingSteps: v.includeRenamingSteps, oneTermAtATime: v.oneTermAtATime };
        data = await queryWorker(v, { mode: 'reexpand', snapshot: v.data.snapshot, hiding, lines: v.lines, custom: runtime.customFor(v), includeRenamingSteps: v.includeRenamingSteps, oneTermAtATime: v.oneTermAtATime });
        if (runtime.current(v, gen) && data && !data.failed) v.expansionRequest = input;
      } else data = await expand(v, v.target.module, hiding, gen);
      if (!runtime.current(v, gen)) return;
      if (!data) { if (!v.data) v.failure = 'Expansion cancelled. Refresh to try again.'; return; }
      if (!v.wholeFile && data.failed && /single #lang or module/.test(data.failed)) {
        fragment = true; data = await expand(v, v.target.fragment, hiding, gen);
      }
      if (!runtime.current(v, gen)) return;
      if (!data) { if (!v.data) v.failure = 'Expansion cancelled. Refresh to try again.'; return; }
      Data.validateAnswer(data, v.pendingSnapshot);
      const locate = a => v.lines ? a.steps.findIndex(s => {
        const source = s.source && a.sources[s.source.sourceId];
        return source?.value === v.target.module.source && s.source.line >= v.lines[0] && s.source.line <= v.lines[1];
      }) : 0;
      let index;
      do {
        // Fresh loads, retained loads and line-policy fallbacks can all await
        // a worker while Settings changes. Reconcile before locating a line
        // and repeat if a fallback waited across another setting change.
        while (!data.failed && (v.expansionRequest.includeRenamingSteps !== v.includeRenamingSteps || v.expansionRequest.oneTermAtATime !== v.oneTermAtATime)) {
          data = await queryWorker(v, { mode: 'reexpand', snapshot: v.pendingSnapshot, hiding,
            lines: v.lines, custom: runtime.customFor(v), includeRenamingSteps: v.includeRenamingSteps, oneTermAtATime: v.oneTermAtATime });
          if (!runtime.current(v, gen) || !data) return;
          Data.validateAnswer(data, v.pendingSnapshot);
        }
        const anchor = lineAnchor && (session || !v.checkpointDecisions.stopped);
        index = anchor ? locate(data) : 0;
        if (anchor && v.lines && hiding === 'standard' && index < 0) {
          const line = await queryWorker(v, { mode: 'reexpand', snapshot: v.pendingSnapshot, hiding: 'line', lines: v.lines });
          if (!runtime.current(v, gen) || !line) return;
          Data.validateAnswer(line, v.pendingSnapshot);
          const found = locate(line);
          if (found >= 0) { data = line; hiding = 'line'; index = found; }
          else {
            data = await queryWorker(v, { mode: 'reexpand', snapshot: v.pendingSnapshot, hiding: 'standard' });
            if (!runtime.current(v, gen) || !data) return;
            Data.validateAnswer(data, v.pendingSnapshot);
          }
        }
      } while (!data.failed && (v.expansionRequest.includeRenamingSteps !== v.includeRenamingSteps || v.expansionRequest.oneTermAtATime !== v.oneTermAtATime));
      v.data = data; v.snapshotText = text;
      if (restoreNavigation) {
        const point = v.navigationPoint;
        const retained = point === 'end' ? -1 : point === null ? 0 : data.steps.findIndex(step => (!(optionRestore || v.oneTermAtATime || v.factorCommonContext) || Number.isSafeInteger(step.expansionPoint)) && step.expansionPoint >= point);
        v.position = retained < 0 ? data.steps.length + 1 : retained + 1;
      } else { v.position = Math.max(0, index) + 1; v.navigationPoint = null; }
      v.changedDependencies = new Set();
      v.hiding = hiding; for (const pane of runtime.panes(v)) { pane.selection = null; pane.textSelections = []; pane.focused = null; pane.pins = []; } v.inspected.clear(); v.positions.clear();
      for (const pane of runtime.panes(v)) pane.positionRevision++; v.fragment = session ? v.fragment : fragment;
    } catch (error) {
      if (runtime.current(v, gen)) { v.failure = error.message; stopWorker(v); }
    } finally {
      if (runtime.current(v, gen)) {
        v.loading = v.busy = false; runtime.stale(v);
        // A new generation is announced before a page accepts its new transfer.
        void runtime.broadcast(v, 'init', { sourceName: path.basename(v.source.fsPath || v.source.path), source: v.source.toString(), wholeFile: v.wholeFile, range: v.invocationSelection ? [v.invocationSelection.start.line, v.invocationSelection.start.character, v.invocationSelection.end.line, v.invocationSelection.end.character] : null, testEnabled: v.testEnabled });
        await runtime.show(v);
      }
    }
  }
  return { views, queryWorker, sessions, load, visibility, waiting, stopWorker, releaseRecording, recordingOf, workers };
}
module.exports = { createSession };
