// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Debounces binding inspections and renders the binding sentence.
/* global MacroView */
MacroView.createSentence = function (runtime) {
  'use strict';
  function resetBindingFacts() {
    clearTimeout(runtime.inspectionTimer); runtime.inspectionTimer = null; runtime.inspectionTarget = null;
    runtime.bindingFacts.clear(); runtime.pendingInspections.clear();
  }
  function receiveBindingFacts(m) {
    const f = runtime.M.find(runtime.projection, m.target);
    if (!f) return;
    const tid = f.occurrence.syntaxId;
    runtime.pendingInspections.delete(tid); runtime.bindingFacts.set(tid, m.bindings);
    if (runtime.bindingFacts.size > 32) runtime.bindingFacts.delete(runtime.bindingFacts.keys().next().value);
    connectionsList();
  }
  function connectionsList() {
    const identifier = pair => {
      const f = runtime.projection && runtime.M.find(runtime.projection, pair);
      return f && runtime.projection.terms[f.occurrence.syntaxId]?.kind === 'identifier';
    };
    const target = runtime.hover || [runtime.selected.selected, runtime.state.selected, ...(runtime.state.pins || []).slice().reverse()].find(identifier);
    const f = runtime.projection && runtime.M.find(runtime.projection, target);
    const tid = f?.occurrence.syntaxId;
    const bindings = tid && (runtime.selected.syntaxId === tid && runtime.selected.properties ? runtime.selected.properties.bindings : runtime.bindingFacts.get(tid));
    if (!runtime.equal(runtime.inspectionTarget, target)) {
      clearTimeout(runtime.inspectionTimer); runtime.inspectionTimer = null; runtime.inspectionTarget = target;
    }
    if (identifier(target) && !bindings && !runtime.incident(target).length && !f.section.binderOccurrences.includes(f.occurrence.id) &&
        !runtime.pendingInspections.has(tid) && runtime.inspectionTimer === null && !runtime.state.busy) {
      const program = runtime.projection, generation = runtime.env.generation, revision = runtime.env.positionRevision;
      runtime.inspectionTimer = setTimeout(() => {
        runtime.inspectionTimer = null;
        if (runtime.projection !== program || runtime.env.generation !== generation || runtime.env.positionRevision !== revision || !runtime.equal(runtime.inspectionTarget, target)) return;
        runtime.pendingInspections.add(tid); runtime.send('inspect', target);
      }, 150);
    }
    const lineNumbers = runtime.editor && runtime.editor.getOption(runtime.monaco.editor.EditorOption.lineNumbers).renderFn;
    const sentence = runtime.projection && f && lineNumbers ? runtime.M.bindingSentence(runtime.projection, target, { bindings,
      lineNumber: (section, occurrence) => lineNumbers(runtime.editorModel.getPositionAt(runtime.partsBySection.get(section.id).offset(occurrence.range[0])).lineNumber)
    }) : '';
    if (runtime.connections.textContent !== sentence) runtime.connections.textContent = sentence;
    if (runtime.live.textContent !== sentence) runtime.announce(sentence);
  }
  return { connectionsList, resetBindingFacts, receiveBindingFacts };
};
