// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Verifies source snapshots, follows source locations and reports stale expansions.
'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const Model = require('../macro-view/model');
const { sourceOffsets } = require('../macro-view/model');
const { hash } = require('./target');
function createSource(runtime) {
  const sourceStyle = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    borderColor: new vscode.ThemeColor('contrastBorder'), borderWidth: '1px', borderStyle: 'solid'
  });
  const clearFocus = () => { for (const e of vscode.window.visibleTextEditors) e.setDecorations(sourceStyle, []); };
  const sourceDocument = v => vscode.workspace.textDocuments.find(d => !d.isClosed && d.uri.toString() === v.source.toString() && (v.source.scheme !== 'untitled' || !v.mainDocument || v.mainDocument === d));
  const refreshAvailable = v => !!sourceDocument(v) || v.source.scheme === 'file' && fs.existsSync(v.source.fsPath);
  const checks = new WeakMap();
  async function stale(v) {
    if (!v.snapshotText) return;
    const check = {}, generation = v.generation;
    checks.set(v, check);
    const doc = sourceDocument(v);
    let old = !!v.changedDependencies?.size || (doc ? doc.getText() !== v.snapshotText : v.source.scheme === 'file' ? !await fingerprint(v.source.fsPath, hash(v.snapshotText)) : false);
    for (const s of Object.values(v.data?.sources || {})) if (s.kind === 'file' && s.fingerprint && s.value !== v.target?.module.source) {
      const open = vscode.workspace.textDocuments.find(d => !d.isClosed && d.uri.scheme === 'file' && d.uri.fsPath === s.value);
      if (open ? hash(open.getText()) !== s.fingerprint : !await fingerprint(s.value, s.fingerprint)) old = true;
    }
    if (checks.get(v) !== check || v.generation !== generation || runtime.disposed || ![...runtime.views.values()].includes(v)) return;
    v.stale = old;
    if (old && runtime.panes(v).includes(runtime.activePane())) clearFocus();
    void runtime.broadcast(v, 'sourceStatus', { stale: old, reason: old ? 'Source changed: this expansion is out of date' : '',
      refreshAvailable: refreshAvailable(v) });
  }
  async function fingerprint(file, expected) { try { return hash(await fs.promises.readFile(file)) === expected; } catch { return false; } }
  function locationUri(v, location) {
    const source = location && v.data.sources[location.sourceId];
    if (source?.kind === 'file' && path.isAbsolute(source.value)) return vscode.Uri.file(source.value);
    if (source?.kind === 'untitled' && source.value === v.source.toString()) return v.source;
    return null;
  }
  async function revealSource(v, location, explicit = false) {
    const gen = v.generation, rev = v.positionRevision, uri = locationUri(v, location);
    if (!uri || !runtime.current(v) || !explicit && (runtime.activePane() !== v || v.stale)) return;
    const own = uri.toString() === v.source.toString(), provenance = v.data.sources[location.sourceId];
    if (own && uri.scheme === 'untitled' && !sourceDocument(v)) return;
    if (!explicit && !own && (!vscode.workspace.getWorkspaceFolder(uri) || !provenance.fingerprint)) return;
    const document = await vscode.workspace.openTextDocument(uri);
    if (!runtime.current(v, gen, rev) || !explicit && runtime.activePane() !== v) return;
    const verified = own ? !v.stale && document.getText() === v.snapshotText : !!provenance.fingerprint && hash(document.getText()) === provenance.fingerprint;
    if (!explicit && !verified) return;
    const exact = verified && Number.isSafeInteger(location.line) && location.line >= 1 && location.line <= document.lineCount &&
      Number.isSafeInteger(location.column) && location.column >= 0 && Number.isSafeInteger(location.span) && location.span >= 0;
    if (explicit && !exact) void vscode.window.showWarningMessage('This source location is changed or unverified; an exact range is unavailable.');
    const editor = !explicit && vscode.window.visibleTextEditors.find(e => e.document === document && e.viewColumn === v.column) ||
      await vscode.window.showTextDocument(document, { viewColumn: v.column, preserveFocus: !explicit, preview: true });
    if (!runtime.current(v, gen, rev) || !explicit && (runtime.activePane() !== v || v.stale)) return;
    if (exact && (own ? !v.stale && document.getText() === v.snapshotText : hash(document.getText()) === provenance.fingerprint)) {
      const locations = explicit ? [location] : (v.data.steps[v.position - 1]?.sourceFoci || []).filter(l => l.sourceId === location.sourceId);
      if (!locations.length) locations.push(location);
      const ranges = locations.filter(l => Number.isSafeInteger(l.line) && l.line > 0 && l.line <= document.lineCount &&
        Number.isSafeInteger(l.column) && l.column >= 0 && Number.isSafeInteger(l.span) && l.span >= 0).map(l =>
        new vscode.Range(...sourceOffsets(document.getText(), l.line, l.column, l.span).map(n => document.positionAt(n))));
      if (explicit && ranges[0]) editor.selection = new vscode.Selection(ranges[0].start, ranges[0].end);
      if (!explicit) editor.setDecorations(sourceStyle, ranges);
      if (ranges[0]) editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
  async function follow(v) {
    if (runtime.activePane() !== v) return;
    clearFocus(); await stale(v);
    const step = v.data?.steps[v.position - 1];
    const locations = step?.sourceFoci?.length ? step.sourceFoci : step?.source ? [step.source] : [];
    for (const l of locations) { if (locationUri(v, l)) { await revealSource(v, l); break; } }
  }
  function sourceLocation(v, location) {
    const source = location && v.data.sources[location.sourceId];
    let text;
    if (source?.value === v.target?.module.source) text = v.snapshotText;
    else if (source) {
      const document = vscode.workspace.textDocuments.find(d => !d.isClosed &&
        (d.uri.toString() === source.value || d.uri.fsPath === source.value));
      if (document) text = document.getText();
      else if (source.kind === 'file') { try { text = fs.readFileSync(source.value, 'utf8'); } catch {} }
    }
    return Model.sourceLabel(location, source, text);
  }
  function changedSource(v, uri) {
    if (uri.toString() === v.source.toString() || uri.scheme !== 'file') return;
    const source = Object.values(v.data?.sources || {}).find(s => s.kind === 'file' && s.value === uri.fsPath);
    if (source && !source.fingerprint) { v.changedDependencies ||= new Set(); v.changedDependencies.add(uri.fsPath); }
  }
  const pending = new Set();
  let checkTimer;
  function affected(v, uri) {
    return uri.toString() === v.source.toString() || uri.scheme === 'file' &&
      Object.values(v.data?.sources || {}).some(s => s.kind === 'file' && s.value === uri.fsPath);
  }
  function sourceChanged(uri, immediate = false) {
    let relevant = false;
    for (const v of runtime.views.values()) {
      if (!affected(v, uri)) continue;
      relevant = true;
      changedSource(v, uri);
      checks.delete(v);
      if (immediate) { pending.delete(v); void stale(v); }
      else pending.add(v);
    }
    if (!relevant || immediate) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      const views = [...pending]; pending.clear();
      if (runtime.disposed) return;
      for (const v of views) if ([...runtime.views.values()].includes(v)) void stale(v);
    }, 50);
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  runtime.context.subscriptions.push(watcher, watcher.onDidChange(sourceChanged), watcher.onDidDelete(sourceChanged),
    { dispose() { clearTimeout(checkTimer); pending.clear(); } });
  return { sourceDocument, refreshAvailable, follow, sourceLocation, stale, revealSource, clearFocus, sourceStyle, affected, sourceChanged };
}
module.exports = { createSource };
