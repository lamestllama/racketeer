// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Updates focus, scope, bracket and occurrence decorations.
/* global MacroView */
MacroView.createDecorations = function (runtime) {
  'use strict';
  function updateDecorations() {
    if (runtime.editorModel) runtime.decorationIds = runtime.editor.deltaDecorations(runtime.decorationIds, runtime.E.decorations(runtime.editorModel, [...runtime.partsBySection.values()], {
      highlightRedexContractum: runtime.state.highlightRedexContractum !== false,
      taintIcons: runtime.state.taintIcons,
      changeSections: runtime.projection ? [
        ...(runtime.projection.record?.kind === 'rewrite' ? [runtime.projection.record.before?.id, runtime.projection.record.after?.id] : []),
        ...(runtime.projection.record?.contexts || []).map(context => context.section.id),
        ...(runtime.projection.diagnostics[runtime.projection.error]?.contexts || []).map(context => context.section.id)
      ] : [],
      selected: runtime.projection ? runtime.M.sections(runtime.projection).flatMap(({ section }) => section.occurrences
        .filter(o => runtime.selected.identity && (runtime.projection.terms[o.syntaxId]?.identity || o.syntaxId) === runtime.selected.identity)
        .map(o => ({ sectionId: section.id, occurrenceId: o.id }))) : [],
      related: runtime.selected.related?.length ? runtime.selected.related : runtime.projection ? runtime.M.bindingOccurrences(runtime.projection, runtime.focused) : [], boxes: runtime.projection ? runtime.M.hoverBoxes(runtime.projection, runtime.hover, runtime.state.pins || []) : []
    }));
    runtime.schedule();
  }
  return { updateDecorations };
};
