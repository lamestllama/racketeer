// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Validates host messages and commits transferred positions, colors and selections.
/* global MacroView */
MacroView.createMessages = function (runtime) {
  'use strict';
  function validateProjection(p, kind) {
    if (kind === 'colors') { runtime.validateColors(p); return p; }
    if (kind === 'selection') {
      if (!Array.isArray(p.related) || p.selected && !runtime.M.find(runtime.projection, p.selected) || p.related.some(pair => !runtime.M.find(runtime.projection, pair))) throw Error('Invalid selection data'); return p;
    }
    if (!Number.isSafeInteger(p.position) || !Number.isSafeInteger(p.count) || p.position < 1 || p.position > p.count || !p.terms || !p.sources || !p.diagnostics) throw Error('Invalid position');
    runtime.M.sections(p).forEach(({ section }) => runtime.M.validateSection(section, p.terms)); runtime.validateColors(p, p); return p;
  }
  const receiver = new runtime.P.Receiver(validateProjection);
  function ack(m, lastSequence, success = true, reason) { runtime.send('transferAck', { transferId: m.transferId, lastSequence, success, ...(reason ? { reason: reason.slice(0, 200) } : {}) }); }
  window.addEventListener('message', event => {
    const m = event.data;
    try { runtime.P.validateHost(m, runtime.env); } catch { return; }
    if (m.type === 'init') {
      if (runtime.env && m.sessionId !== runtime.env.sessionId) return;
      runtime.resetBindingFacts(); receiver.abort(); runtime.env = { sessionId: m.sessionId, generation: m.generation, positionRevision: m.positionRevision };
      runtime.testEnabled = m.testEnabled === true;
      if (m.editorSettings) { runtime.editorSettings = m.editorSettings; runtime.configureEditor(); }
      runtime.state.pairId = m.pairId; runtime.state.source = m.source; runtime.state.wholeFile = m.wholeFile; runtime.state.range = m.range; runtime.persist(); runtime.focusMessage(); return;
    }
    if (!runtime.env || m.sessionId !== runtime.env.sessionId || m.generation !== runtime.env.generation || m.positionRevision < runtime.env.positionRevision) return;
    if (m.positionRevision > runtime.env.positionRevision) { runtime.resetBindingFacts(); receiver.abort(); runtime.env.positionRevision = m.positionRevision; }
    const expectedSequence = m.type === 'positionCommit' ? receiver.pending?.chunkCount ?? -1 : m.sequence ?? -1;
    try {
      switch (m.type) {
        case 'state': runtime.state = { ...runtime.state, ...m };
          if (runtime.state.drawBindingArrows === false) runtime.state.pins = [];
          runtime.updateState(); runtime.draw();
          runtime.setTermContext(runtime.syntax, runtime.focused);
          runtime.setTermContext(runtime.editorHost, runtime.focused);
          if (!runtime.projection || runtime.projection.position === runtime.state.position) { runtime.connectionsList(); runtime.updateDecorations(); } break;
        case 'clear':
          receiver.abort(); runtime.loading = runtime.renderingPosition = false;
          runtime.projection = null; runtime.sections = []; runtime.partsBySection.clear();
          runtime.hover = runtime.focused = null;
          runtime.selected = { selected: null, related: [], syntaxId: null, properties: null };
          if (runtime.editorModel) runtime.E.editText(runtime.editorModel, '');
          runtime.resetBindingFacts(); runtime.renderInspector(); runtime.updateStatus();
          runtime.updateDecorations(); runtime.connectionsList(); runtime.draw(); break;
        case 'sourceStatus': runtime.setStale(m); break;
        case 'bindingFacts': runtime.receiveBindingFacts(m); break;
        case 'positionBegin': runtime.loading = true; if (m.payloadKind === 'position') runtime.renderingPosition = true; ack(m, receiver.begin(m)); runtime.updateStatus(); break;
        case 'positionChunk': ack(m, receiver.chunk(m)); break;
        case 'positionCommit': {
          const result = receiver.commit(m);
          if (result.kind === 'position') runtime.renderPosition(result.value);
          else if (result.kind === 'colors') { runtime.applyColors(result.value); runtime.updateDecorations(); }
          else if (Object.hasOwn(result.value, 'identity') || runtime.equal(result.value.selected, runtime.focused)) { runtime.selected = result.value; if (Object.hasOwn(result.value, 'identity')) runtime.focused = result.value.selected; runtime.renderInspector(); runtime.updateDecorations(); runtime.announce(runtime.selected.properties ? `Selected ${runtime.selected.properties.kind} ${runtime.selected.properties.name || ''}` : 'Selection cleared'); }
          runtime.loading = false; ack(m, result.sequence); runtime.updateState(); runtime.connectionsList();
          runtime.editor?.render(); runtime.draw();
          if (result.kind === 'position') {
            const committedEnv = { ...runtime.env }, committedProjection = runtime.projection;
            requestAnimationFrame(() => {
              if (runtime.env.generation !== committedEnv.generation || runtime.env.positionRevision !== committedEnv.positionRevision || runtime.projection !== committedProjection) return;
              if (!result.value.suppressSelection && !runtime.state.oneTermAtATime && !runtime.state.factorCommonContext && !Object.hasOwn(runtime.selected, 'identity')) runtime.updateCurrentTerm();
              const f = runtime.sections.find(s => s.section.focus.length);
              const o = f && runtime.M.hit(f.section, f.section.focus[0][0]);
              const mnt = f && runtime.partsBySection.get(f.section.id);
              const rects = f ? runtime.rectangles(mnt, [f.section.focus[0][0], Math.min(f.section.focus[0][0] + 1, f.section.text.length)]) : [];
              const bounds = mnt?.viewport.getBoundingClientRect();
              const mounted = !f || rects.some(r => r.right + bounds.left > 0 && r.left + bounds.left < innerWidth && r.bottom + bounds.top > 0 && r.top + bounds.top < innerHeight);
              runtime.send('rendered', { transferId: m.transferId, sections: runtime.sections.map(s => s.section.id), focus: o ? { sectionId: f.section.id, occurrenceId: o.id } : null,
                mounted, observation: runtime.testEnabled ? runtime.observation() : undefined });
            });
          }
          break;
        }
        case 'transferAbort': receiver.abort(); runtime.loading = false; runtime.renderingPosition = false; runtime.updateStatus(); break;
        case 'actionResult': if (m.message) runtime.announce(m.message); break;
        case 'collapseSelection': {
          const tracked = Object.hasOwn(runtime.selected, 'identity');
          if (tracked) runtime.renderingPosition = true;
          runtime.editor?.setPosition(runtime.editor.getPosition());
          if (tracked) runtime.renderingPosition = false; else runtime.updateCurrentTerm();
          break;
        }
        case 'focusTarget': runtime.focusPair(m.target); break;
        case 'testDrive': void runtime.testDrive(m); break;
      }
    } catch (e) { receiver.abort(); runtime.loading = false; runtime.updateStatus(); ack(m, expectedSequence, false, e.message); runtime.announce(e.message); }
  });
  runtime.updateState();
  runtime.vscode.postMessage({ v: 1, type: 'ready', clientInstanceId: runtime.clientInstanceId });
  return {};
};
