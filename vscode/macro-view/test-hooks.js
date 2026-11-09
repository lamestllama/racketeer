// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Observes and drives the page only when enabled by the test host.
/* global MacroView */
MacroView.createTestHooks = function (runtime) {
  'use strict';
  // Observe real editor spans at model positions; never infer their colors
  // from our theme rules. The acceptance test compares these to source styles.
  function renderedToken(part, offset) {
    const pos = runtime.editorModel.getPositionAt(part.offset(offset)), box = runtime.editor.getScrolledVisiblePosition(pos);
    if (!box) return null;
    const origin = runtime.editorSurface.getBoundingClientRect();
    const node = document.elementFromPoint(origin.left + box.left + 1, origin.top + box.top + box.height / 2);
    // Only text counts: a token under the minimap or a scrollbar is not shown.
    return node?.closest('.view-lines') && runtime.editorSurface.contains(node) ? { color: getComputedStyle(node).color, className: node.className } : null;
  }
  // Keep actual line nodes across a step, including suffix lines shifted by
  // inserted/deleted rows. Compare only lines rendered in both viewports.
  function renderedLines() {
    if (!runtime.editorModel) return [];
    const nodes = [...runtime.editorSurface.querySelectorAll('.view-lines > .view-line')];
    const origin = runtime.editorSurface.getBoundingClientRect();
    const result = [];
    for (const range of runtime.editor.getVisibleRanges()) for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
      const point = runtime.editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
      const node = point && nodes.find(n => Math.abs(n.getBoundingClientRect().top - origin.top - point.top) < 1);
      if (node) result.push({ line, node });
    }
    return result;
  }
  function editObservation() {
    if (!runtime.positionEdit) return null;
    const { range, newEnd, identical } = runtime.positionEdit;
    const current = renderedLines(), retained = [];
    for (const old of runtime.lineSnapshot) {
      if (!identical && old.line >= range.startLineNumber && old.line <= range.endLineNumber) continue;
      const line = old.line > range.endLineNumber ? old.line + newEnd.lineNumber - range.endLineNumber : old.line;
      const next = current.find(n => n.line === line);
      if (next) retained.push({ oldLine: old.line, line, sameElement: old.node === next.node });
    }
    return { count: runtime.modelEdits.length, changes: runtime.modelChanges.map(e => ({ range: e.range, newLineCount: e.text.split('\n').length })),
      range, newEnd, identical, retained };
  }
  function observation() {
    const parts = [...runtime.partsBySection.values()];
    const first = parts.find(p => p.section.focus.length);
    const variables = getComputedStyle(document.body);
    const introduced = parts.flatMap(p => p.section.occurrences.filter(o => o.macroScopeGroup > 0 && !o.delimiterRanges.length).map(o => ({
      sectionId: p.section.id, occurrenceId: o.id, group: o.macroScopeGroup, text: p.section.text.slice(...o.range),
      chartColor: runtime.E.color(variables.getPropertyValue(runtime.E.scopeVariable(o.macroScopeGroup, variables))), ...renderedToken(p, o.range[0])
    }))).filter(t => t.color).slice(0, 32);
    const sectionLines = parts.map(p => {
      const line = runtime.editorModel.getPositionAt(p.start).lineNumber;
      const box = runtime.editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 }), origin = runtime.editorSurface.getBoundingClientRect();
      const gutter = box && [...runtime.editorSurface.querySelectorAll('.line-numbers')].find(n => Math.abs(n.getBoundingClientRect().top - origin.top - box.top) < 2);
      return { sectionId: p.section.id, line, number: runtime.editor.getOption(runtime.monaco.editor.EditorOption.lineNumbers).renderFn(line), renderedNumber: gutter?.textContent.trim() };
    });
    const tokens = parts.slice(0, 2).flatMap(p => (runtime.tokenSections[p.section.id] || []).filter(t => p.section.text.slice(t.start, t.end) === 'define').slice(0, 2).map(t => ({
      sectionId: p.section.id, ...t, text: p.section.text.slice(t.start, t.end), ...renderedToken(p, t.start), resolved: runtime.tokenStyles[t.style]
    })));
    const brackets = [];
    if (runtime.editorModel && runtime.editorSettings.bracketPairColorization?.enabled !== false) {
      for (const p of parts.slice(0, 2)) {
        const start = runtime.editorModel.getPositionAt(p.start), end = runtime.editorModel.getPositionAt(p.end);
        const ds = runtime.editorModel.getDecorationsInRange({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, 0);
        for (const d of ds.filter(d => d.options.description === 'BracketPairColorization')) {
          const offset = runtime.editorModel.getOffsetAt({ lineNumber: d.range.startLineNumber, column: d.range.startColumn });
          const local = offset - p.start;
          const rendered = renderedToken(p, local);
          if (rendered?.className.includes('bracket-highlighting-')) brackets.push({ sectionId: p.section.id, start: local, text: runtime.editorModel.getValue().slice(offset, offset + 1), ...rendered });
        }
      }
    }
    const ds = runtime.editorModel ? runtime.editorModel.getAllDecorations() : [];
    const occurrenceHighlights = ds.filter(d => d.options.className === 'macro-word-highlight' || d.options.className === 'macro-word-highlight-strong');
    return { position: runtime.projection?.position, count: runtime.projection?.count, sections: runtime.sections.map(s => s.section.id), selected: runtime.selected.selected,
      modelEdit: editObservation(),
      bindingSentence: runtime.connections.textContent, bindingAnnouncement: runtime.live.textContent,
      arrowText: [...runtime.arrowLayer.querySelectorAll('text')].map(n => n.textContent),
      sourceLocation: runtime.inspector.querySelector('[data-name=source] .property a')?.textContent,
      morePhasesLink: runtime.inspector.querySelector('#more-phases')?.textContent || null,
      inspector: runtime.inspector.textContent.slice(0, 5000), propertiesVisible: !runtime.inspector.hidden, focus: runtime.focused,
      editorLayoutWidth: runtime.editor?.getLayoutInfo().width,
      propertiesBelow: !runtime.inspector.hidden && runtime.inspector.getBoundingClientRect().top >= runtime.editorSurface.getBoundingClientRect().bottom,
      mounted: !runtime.focused || !!runtime.M.find(runtime.projection, runtime.focused), arrows: runtime.drawn, boxes: runtime.boxes, themeName: runtime.themeName, brackets, tokens, introduced, sectionLines,
      focusViewport: first ? runtime.E.focusViewport(runtime.editor, runtime.editorModel, first) : null, focusReveal: runtime.focusReveal,
      editorCount: runtime.syntax.querySelectorAll('.monaco-editor').length,
      findVisible: !!runtime.editor?.getContribution('editor.contrib.findController')?.getState().isRevealed,
      readOnly: runtime.editor?.getOption(runtime.monaco.editor.EditorOption.readOnly),
      minimapEnabled: runtime.editor?.getOption(runtime.monaco.editor.EditorOption.minimap).enabled,
      wordWrap: runtime.editor?.getOption(runtime.monaco.editor.EditorOption.wordWrap),
      cursor: runtime.editor?.getPosition(), lineHeight: runtime.editor?.getOption(runtime.monaco.editor.EditorOption.lineHeight), visibleRanges: runtime.editor?.getVisibleRanges(), scrollTop: runtime.editor?.getScrollTop(),
      scrollWidth: runtime.editor?.getScrollWidth(), contentWidth: runtime.editor?.getLayoutInfo().contentWidth, scrollLeft: runtime.editor?.getScrollLeft(),
      relatedCount: occurrenceHighlights.length,
      occurrenceStyles: [...runtime.editorSurface.querySelectorAll('.macro-word-highlight, .macro-word-highlight-strong')].map(n => {
        const style = getComputedStyle(n);
        return { className: n.className, background: runtime.E.color(style.backgroundColor), borderColor: runtime.E.color(style.borderColor),
          borderStyle: style.borderStyle, outlineStyle: style.outlineStyle };
      }),
      selectionStyles: [...runtime.editorSurface.querySelectorAll('.selected-text')].map(n => runtime.E.color(getComputedStyle(n).backgroundColor)),
      highlightColors: Object.fromEntries(['wordHighlightBackground', 'wordHighlightStrongBackground', 'wordHighlightBorder', 'wordHighlightStrongBorder', 'selectionBackground']
        .map(name => [name, runtime.E.color(variables.getPropertyValue('--vscode-editor-' + name))])),
      occurrenceHighlights: occurrenceHighlights.map(d => ({ range: d.range, className: d.options.className })),
      selection: runtime.editor?.getSelection(), selectedText: runtime.editorModel && runtime.editor?.getSelection() ? runtime.editorModel.getValueInRange(runtime.editor.getSelection()) : '',
      occurrencesHighlight: runtime.editor?.getOption(runtime.monaco.editor.EditorOption.occurrencesHighlight),
      selectionHighlight: runtime.editor?.getOption(runtime.monaco.editor.EditorOption.selectionHighlight),
      identityCount: ds.filter(d => d.options.inlineClassName === 'macro-identity').length,
      hoverDecorationCount: ds.filter(d => d.options.className === 'macro-hover').length,
      banner: runtime.banner.hidden ? '' : runtime.banner.textContent, buttons: runtime.app.querySelectorAll('button').length, note: runtime.note.textContent };
  }
  async function testDrive(m) {
    if (!runtime.testEnabled || !m.operation || typeof m.operation !== 'object') return;
    let driveError;
    const answer = () => {
      if (!runtime.pendingDrives.delete(answer)) return;
      runtime.send('testResult', { sessionId: m.sessionId, generation: m.generation, positionRevision: m.positionRevision,
        replyTo: m.requestId, observation: { ...observation(), ...(driveError ? { driveError } : {}) } });
    };
    runtime.pendingDrives.add(answer);
    try {
      const o = m.operation;
      if (o.type === 'settle') for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      if (o.type === 'unhover') { runtime.hover = null; runtime.connectionsList(); runtime.updateDecorations(); }
      if (['select', 'hover', 'doubleClick', 'drag'].includes(o.type) && runtime.M.find(runtime.projection, o.target)) {
        const found = runtime.M.find(runtime.projection, o.target), part = runtime.partsBySection.get(o.target.sectionId);
        const offset = runtime.M.clickOffset(found.section, found.occurrence);
        if (offset === null) throw Error('Occurrence has no independently clickable character');
        const pos = runtime.editorModel.getPositionAt(part.offset(offset));
        const end = runtime.editorModel.getPositionAt(part.offset(offset + (found.section.text.codePointAt(offset) > 0xffff ? 2 : 1)));
        runtime.editor.focus();
        // The properties panel can resize this pane before automatic layout
        // catches up. Reveal the whole owned character in the current pane,
        // including its columns, before measuring a pointer point.
        runtime.editor.layout();
        runtime.editor.revealRangeInCenterIfOutsideViewport({ startLineNumber: pos.lineNumber, startColumn: pos.column,
          endLineNumber: end.lineNumber, endColumn: end.column }, runtime.monaco.editor.ScrollType.Immediate);
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!runtime.pendingDrives.has(answer)) return;
        // Horizontal reveal is completed during rendering. Measure only after
        // that render, and check the real editor hit before dispatching a click.
        runtime.editor.render(true);
        const box = runtime.editor.getScrolledVisiblePosition(pos), next = runtime.editor.getScrolledVisiblePosition(end), origin = runtime.editorSurface.getBoundingClientRect();
        if (!box || !next) throw Error('Requested occurrence is not rendered');
        const point = { clientX: origin.left + box.left + (next.left - box.left) / 4, clientY: origin.top + box.top + box.height / 2, bubbles: true, button: 0, buttons: o.type === 'hover' ? 0 : 1, view: window };
        const hit = runtime.editor.getTargetAtClientPoint(point.clientX, point.clientY);
        if (!hit || !runtime.equal(runtime.atPointer(hit), o.target)) {
          const node = document.elementFromPoint(point.clientX, point.clientY);
          const inEditorSurface = !!node && runtime.editorSurface.contains(node);
          throw Error(JSON.stringify({ message: 'Pointer does not hit the requested occurrence',
            target: { ...o.target, text: found.section.text.slice(...found.occurrence.range), range: found.occurrence.range },
            pane: { ...m.pane, side: runtime.projection.pane, documentVisible: document.visibilityState === 'visible',
              focused: document.hasFocus(), editorTextFocused: runtime.editor.hasTextFocus() },
            character: { text: String.fromCodePoint(found.section.text.codePointAt(offset)),
              offset, position: pos, endPosition: end, scrolledVisiblePosition: box, endScrolledVisiblePosition: next,
              clientRect: { left: origin.left + box.left, top: origin.top + box.top,
                right: origin.left + next.left, bottom: origin.top + box.top + box.height,
                width: next.left - box.left, height: box.height } },
            pointer: { clientX: point.clientX, clientY: point.clientY },
            editor: { visibleRanges: runtime.editor.getVisibleRanges(), scrollTop: runtime.editor.getScrollTop(), scrollLeft: runtime.editor.getScrollLeft(),
              surfaceRect: origin, layout: runtime.editor.getLayoutInfo() },
            propertiesPanel: { visible: !runtime.inspector.hidden, rect: runtime.inspector.getBoundingClientRect() },
            elementFromPoint: node ? { tag: node.tagName, classes: node.getAttribute('class') || '',
              inEditorSurface, occurrence: inEditorSurface && hit ? runtime.atPointer(hit) : null } : null,
            hitTest: hit ? { type: hit.type ?? null, position: hit.position ?? null, range: hit.range ?? null,
              mouseColumn: hit.mouseColumn ?? null, occurrence: runtime.atPointer(hit) } : null
          }));
        }
        const node = document.elementFromPoint(point.clientX, point.clientY);
        if (!node || !runtime.editorSurface.contains(node)) throw Error('Requested occurrence is outside the editor surface');
        if (o.type !== 'hover') {
          node.dispatchEvent(new MouseEvent('mousedown', { ...point, detail: 1 }));
          if (o.type === 'drag') {
            const endPosition = runtime.editorModel.getPositionAt(part.offset(o.endOffset)), endBox = runtime.editor.getScrolledVisiblePosition(endPosition);
            if (!endBox) throw Error('Drag endpoint is not rendered');
            const move = { ...point, clientX: origin.left + endBox.left, clientY: origin.top + endBox.top + endBox.height / 2,
              pointerId: 1, pointerType: 'mouse', buttons: 1 };
            const endNode = document.elementFromPoint(move.clientX, move.clientY);
            if (!endNode || !runtime.editorSurface.contains(endNode)) throw Error('Drag endpoint is outside the editor');
            endNode.dispatchEvent(new PointerEvent('pointermove', move));
            endNode.dispatchEvent(new MouseEvent('mousemove', move));
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          node.dispatchEvent(new PointerEvent('pointerup', { ...point, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
          window.dispatchEvent?.(new PointerEvent('pointerup', { ...point, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
          node.dispatchEvent(new MouseEvent('mouseup', { ...point, buttons: 0, detail: 1 }));
          if (o.type === 'doubleClick') {
            node.dispatchEvent(new MouseEvent('mousedown', { ...point, detail: 2 }));
            node.dispatchEvent(new PointerEvent('pointerup', { ...point, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
            window.dispatchEvent?.(new PointerEvent('pointerup', { ...point, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
            node.dispatchEvent(new MouseEvent('mouseup', { ...point, buttons: 0, detail: 2 }));
          }
        } else node.dispatchEvent(new MouseEvent('mousemove', point));
      }
      if (o.type === 'cursor' || o.type === 'textSelection') {
        runtime.editor.focus();
        if (o.type === 'cursor') runtime.editor.setPosition(o.position);
        else runtime.editor.setSelection(o.backwards ? new runtime.monaco.Selection(o.selection.endLineNumber, o.selection.endColumn, o.selection.startLineNumber, o.selection.startColumn) : o.selection);
      }
      if (o.type === 'editorAction') { runtime.editor.focus(); runtime.editor.trigger('keyboard', o.action, o.args || {}); }
      if (o.type === 'find') { runtime.editor.focus(); await runtime.editor.getAction('actions.find').run(); }
      if (o.type === 'closeFind') { runtime.editor.getContribution('editor.contrib.findController')?.closeFindWidget(); runtime.editor.focus(); }
      if (o.type === 'scrollEditor') { runtime.editor.focus(); runtime.editor.setScrollPosition({ scrollTop: o.top, scrollLeft: o.left || 0 }, runtime.monaco.editor.ScrollType.Immediate); }
      if (o.type === 'scrollRight') runtime.editor.setScrollLeft(runtime.editor.getScrollWidth());
      if (o.type === 'revealBeforeFocus') {
        const first = runtime.sections.find(s => s.section.focus.length);
        if (first) runtime.revealOffset(first.section.id, first.section.focus[0][0]);
      }
      if (o.type === 'revealAfterStart') {
        const after = runtime.sections.find(s => s.kind === 'after');
        if (after) runtime.revealOffset(after.section.id, 0);
      }
      if (o.type === 'clickElsewhere') document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      if (o.type === 'morePhases') runtime.inspector.querySelector('#more-phases')?.click();
      if (o.type === 'sourceLink') runtime.inspector.querySelector('[data-name=source] .property a')?.click();
      if (o.type === 'revealStart') runtime.editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      if (o.type === 'key') runtime.editorSurface.dispatchEvent(new KeyboardEvent('keydown', { key: o.key, altKey: !!o.altKey, shiftKey: !!o.shiftKey, bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!runtime.pendingDrives.has(answer)) return;
      const waiting = () => runtime.loading || o.type === 'select' && !runtime.equal(runtime.selected.selected, o.target);
      for (let i = 0; runtime.pendingDrives.has(answer) && waiting() && i < 120; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      if (!runtime.pendingDrives.has(answer)) return;
      if (o.type === 'select' && !runtime.equal(runtime.selected.selected, o.target)) throw Error('Selection did not reach the requested occurrence');
      runtime.draw();
    } catch (error) { driveError = error.message; }
    finally { answer(); }
  }
  return { renderedLines, observation, testDrive };
};
