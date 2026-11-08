// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Maps editor input to occurrences and sends navigation and focus actions.
/* global MacroView */
MacroView.createInput = function (runtime) {
  'use strict';
  function setTermContext(node, pair) {
    const f = runtime.projection && runtime.M.find(runtime.projection, pair), term = f && runtime.projection.terms[f.occurrence.syntaxId];
    const source = term?.source && runtime.projection.sources[term.source.sourceId];
    node.setAttribute('data-vscode-context', JSON.stringify({
      webviewSection: f ? 'syntax' : 'program', preventDefaultContextMenuItems: true,
      ...runtime.env, sectionId: pair?.sectionId || null, occurrenceId: pair?.occurrenceId || null,
      'racketdap.macroSteps.hasSelection': !!f,
      'racketdap.macroSteps.canCopy': !!f || !!runtime.editor?.getSelections()?.some(s => !s.isEmpty()),
      'racketdap.macroSteps.hasIdentifier': term?.kind === 'identifier',
      'racketdap.macroSteps.hasSource': !!source && ['file', 'untitled'].includes(source.kind),
      ...Object.fromEntries(Object.entries(runtime.M.arrowStatus(runtime.projection, pair, runtime.state.pins || []))
        .map(([key, value]) => [`racketdap.macroSteps.${key}`, value])),
      'racketdap.macroSteps.drawBindingArrows': runtime.state.drawBindingArrows !== false
    }));
  }
  function atPosition(position) {
    if (!position || !runtime.editorModel) return null;
    const offset = runtime.editorModel.getOffsetAt(position);
    for (const m of runtime.partsBySection.values()) {
      if (offset < m.start || offset >= m.end) continue;
      // Binary search the original UTF-16 coordinates, accounting for CRLF.
      let lo = 0, hi = m.section.text.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (m.offset(mid) < offset) lo = mid + 1; else hi = mid; }
      const o = runtime.M.hit(m.section, lo, m.rangeIndex.query(lo, lo + 1), m.rangeIndex.byId);
      return o ? { sectionId: m.section.id, occurrenceId: o.id } : null;
    }
    return null;
  }
  function atPointer(target) {
    // position is the nearest caret, which is past the character on its right
    // half. range identifies the character actually under the pointer.
    if (runtime.monaco.editor.MouseTargetType && target.type !== runtime.monaco.editor.MouseTargetType.CONTENT_TEXT) return null;
    const r = target.range;
    return atPosition(r ? { lineNumber: r.startLineNumber, column: r.startColumn } : target.position);
  }
  function revealOffset(sectionId, offset) {
    const m = runtime.partsBySection.get(sectionId); if (!m || !runtime.editorModel) return;
    runtime.editor.revealPositionInCenterIfOutsideViewport(runtime.editorModel.getPositionAt(m.offset(offset)));
    runtime.schedule();
  }
  function focusPair(pair) {
    const f = runtime.M.find(runtime.projection, pair); if (!f) return;
    runtime.hover = pair; revealOffset(pair.sectionId, f.occurrence.range[0]);
    const offset = runtime.M.clickOffset(f.section, f.occurrence) ?? f.occurrence.range[0];
    runtime.editor.setPosition(runtime.editorModel.getPositionAt(runtime.partsBySection.get(pair.sectionId).offset(offset)));
    updateCurrentTerm(); runtime.editor.focus(); runtime.updateDecorations(); runtime.connectionsList();
  }
  function choose(pair) {
    runtime.focused = pair;
    if (!runtime.equal(runtime.selected.selected, pair)) {
      runtime.selected = { selected: pair, syntaxId: runtime.M.find(runtime.projection, pair)?.occurrence.syntaxId || null,
        related: runtime.M.bindingOccurrences(runtime.projection, pair), properties: null };
      runtime.renderInspector();
    }
    setTermContext(runtime.syntax, pair); setTermContext(runtime.editorHost, pair);
    runtime.connectionsList(); runtime.updateDecorations(); focusMessage();
    const textSelections = (runtime.editor.getSelections() || []).map(s => [
      runtime.editorModel.getOffsetAt(s.getStartPosition()), runtime.editorModel.getOffsetAt(s.getEndPosition())
    ]);
    runtime.send('select', { ...(pair || { sectionId: null, occurrenceId: null }), textSelections });
  }
  function updateCurrentTerm() {
    if (!runtime.projection || !runtime.editorModel) return;
    choose(atPosition(runtime.editor.getSelection()?.getStartPosition() || runtime.editor.getPosition()));
  }
  document.addEventListener('copy', e => {
    if (!runtime.editor?.hasTextFocus() || !runtime.selected.selected || runtime.editor.getSelections()?.some(s => !s.isEmpty())) return;
    e.clipboardData.setData('text/plain', runtime.M.copy(runtime.projection, runtime.selected.selected));
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  function focusMessage() { runtime.send('focus', { focusWithin: document.hasFocus(), inputFocus: !runtime.editor?.hasTextFocus() && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName), menuOpen: false, focusedOccurrence: runtime.focused }); }
  document.addEventListener('focusin', focusMessage);
  document.addEventListener('focusout', () => queueMicrotask(focusMessage));
  window.addEventListener('blur', () => { runtime.hover = null; runtime.connectionsList(); runtime.updateDecorations(); focusMessage(); });
  window.addEventListener('focus', focusMessage);
  // Monaco's hidden textarea must not swallow extension navigation keys.
  document.addEventListener('keydown', e => {
    if (!runtime.editor?.hasTextFocus() || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const action = e.key === 'F10' && !e.altKey || e.altKey && e.key === 'ArrowRight' ? 'next'
      : e.altKey && e.key === 'ArrowLeft' ? 'previous' : null;
    if (action) {
      e.preventDefault(); e.stopImmediatePropagation();
      // The host owns the debugger context and decides where F10 belongs.
      if (!runtime.state.busy || e.key === 'F10') runtime.send('navigate', { action, ...(e.key === 'F10' ? { key: 'F10' } : {}) });
    }
  }, true);
  window.addEventListener('pagehide', () => {
    for (const answer of runtime.pendingDrives) answer();
    clearTimeout(runtime.inspectionTimer); runtime.tokenProvider?.dispose(); runtime.editor?.dispose(); runtime.editorModel?.dispose();
  });
  return { atPointer, updateCurrentTerm, setTermContext, revealOffset, focusMessage, focusPair };
};
