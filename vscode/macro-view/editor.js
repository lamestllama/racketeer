// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Configures Monaco, token themes and models, retaining the editor across positions.
/* global MacroView */
MacroView.createEditor = function (runtime) {
  'use strict';
  runtime.monaco.languages.register({ id: 'macro-preview' });
  runtime.monaco.languages.setLanguageConfiguration('macro-preview', { brackets: [['(', ')'], ['[', ']'], ['{', '}']] });
  function validateColors(p, program = runtime.projection) {
    if (!Array.isArray(p.tokenStyles) || !p.tokenSections || typeof p.themeName !== 'string') throw Error('Invalid token colors');
    if (!p.tokenStyles.every(s => (s.foreground === null || /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(s.foreground)) && Number.isSafeInteger(s.fontStyle) && s.fontStyle >= 0 && s.fontStyle <= 15)) throw Error('Invalid token style');
    for (const [id, tokens] of Object.entries(p.tokenSections)) {
      const section = runtime.M.sections(program).find(s => s.section.id === id)?.section;
      let end = 0;
      if (!section || !Array.isArray(tokens)) throw Error('Invalid token section');
      for (const t of tokens) {
        if (!runtime.M.validRange(section.text, [t.start, t.end]) || t.start < end || t.start === t.end || !Number.isSafeInteger(t.style) || !p.tokenStyles[t.style]) throw Error('Invalid token span');
        end = t.end;
      }
    }
  }
  function rebuildTheme() {
    const variables = getComputedStyle(document.body);
    runtime.monaco.editor.defineTheme('macro-source', runtime.E.theme(variables, runtime.tokenStyles, runtime.monaco.colorIds,
      document.body.getAttribute('data-vscode-theme-kind') || document.body.className));
    runtime.monaco.editor.setTheme('macro-source');
    runtime.schedule();
  }
  function refreshTokens() {
    if (!runtime.editorModel) return;
    const spans = [...runtime.partsBySection.values()].flatMap(p => runtime.E.scopeTokens(p.section, runtime.tokenSections[p.section.id] || []).map(t => ({
      ...t, start: p.offset(t.start), end: p.offset(t.end)
    })));
    const previous = runtime.tokenProvider;
    runtime.tokenProvider = runtime.monaco.languages.setTokensProvider('macro-preview', runtime.E.provider(runtime.E.tokenLines(runtime.editorModel.getValue(), spans)));
    previous?.dispose();
    runtime.monaco.tokenizeModel(runtime.editorModel);
  }
  function applyColors(p, tokens = true) {
    runtime.tokenSections = p.tokenSections; runtime.tokenStyles = p.tokenStyles; runtime.themeName = p.themeName;
    if (p.editorSettings) runtime.editorSettings = p.editorSettings;
    const signature = JSON.stringify([runtime.tokenStyles, runtime.themeName]);
    if (signature !== runtime.themeSignature) { runtime.themeSignature = signature; rebuildTheme(); }
    if (tokens) { refreshTokens(); configureEditor(); }
  }
  function configureEditor() {
    if (!runtime.editor) return;
    const css = getComputedStyle(document.body);
    const fontSize = runtime.editorSettings.fontSize || parseFloat(css.getPropertyValue('--vscode-editor-font-size')) || 14;
    runtime.editor.updateOptions({
      fontFamily: runtime.editorSettings.fontFamily || css.getPropertyValue('--vscode-editor-font-family').trim(),
      fontSize,
      fontWeight: runtime.editorSettings.fontWeight || css.getPropertyValue('--vscode-editor-font-weight').trim() || 'normal',
      lineHeight: runtime.editorSettings.lineHeight || 0,
      minimap: { enabled: runtime.editorSettings.minimapEnabled !== false },
      bracketPairColorization: runtime.editorSettings.bracketPairColorization || { enabled: true, independentColorPoolPerBracketType: false }
    });
    const font = runtime.editor.getOption(runtime.monaco.editor.EditorOption.fontInfo);
    runtime.rule('connections-font', `#connections { font-family: ${font.fontFamily.replace(/[{};]/g, '')}; font-size: ${font.fontSize}px; font-weight: ${font.fontWeight}; line-height: ${font.lineHeight}px; }`);
    runtime.editorModel?.updateOptions({ tabSize: runtime.editorSettings.tabSize || 2,
      bracketColorizationOptions: runtime.editorSettings.bracketPairColorization });
  }
  const editorHost = runtime.element('div', undefined, 'editor-host');
  const editorSurface = runtime.element('div', undefined, 'editor-surface');
  editorHost.append(editorSurface, runtime.arrowLayer);
  function ensureEditor() {
    if (runtime.editor) return;
    runtime.editor = runtime.monaco.editor.create(editorSurface, { model: null, readOnly: true, domReadOnly: true,
      automaticLayout: true, wordWrap: 'off', scrollBeyondLastLine: false, contextmenu: false,
      lineNumbers: 'on', folding: true, foldingStrategy: 'indentation', showFoldingControls: 'mouseover',
      // Binding edges supply occurrence highlights; equal text is insufficient.
      links: false, occurrencesHighlight: 'off', selectionHighlight: false, wordBasedSuggestions: 'off',
      renderValidationDecorations: 'off',
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
      stickyScroll: { enabled: false }, scrollbar: { horizontal: 'auto', vertical: 'auto' },
      ariaLabel: 'Macro expansion program', theme: 'macro-source'
    }, runtime.monaco.services);
    // Let VS Code receive Ctrl/Cmd+K chords, including the Macro Hiding shortcut.
    const { KeybindingsRegistry, KeyMod, KeyCode, isMacintosh } = runtime.monaco;
    const commands = new Set(KeybindingsRegistry.getDefaultKeybindings().filter(({ keybinding }) => {
      const first = keybinding?.chords[0];
      return first && first.keyCode === KeyCode.KeyK && !first.shiftKey && !first.altKey &&
        first.ctrlKey === !isMacintosh && first.metaKey === isMacintosh;
    }).map(({ command }) => command));
    runtime.monaco.editor.addKeybindingRules([...commands].map(command => ({
      keybinding: KeyMod.CtrlCmd | KeyCode.KeyK, command: '-' + command
    })));
    runtime.editor.onDidScrollChange(() => { runtime.schedule(); runtime.persist(); });
    runtime.editor.onDidLayoutChange(runtime.schedule);
    runtime.editor.onDidContentSizeChange(runtime.schedule);
    runtime.editor.onDidChangeModelDecorations(runtime.schedule);
    runtime.editor.onMouseMove(e => {
      const pair = runtime.atPointer(e.target);
      if (!runtime.equal(runtime.hover, pair)) { runtime.hover = pair; runtime.connectionsList(); runtime.updateDecorations(); }
    });
    runtime.editor.onMouseLeave(() => { runtime.hover = null; runtime.connectionsList(); runtime.updateDecorations(); });
    runtime.editor.onMouseDown(e => {
      if (e.event.leftButton) { runtime.hover = runtime.atPointer(e.target); runtime.connectionsList(); runtime.updateDecorations(); }
    });
    runtime.editor.onDidChangeCursorSelection(() => { if (!runtime.renderingPosition) runtime.updateCurrentTerm(); });
  }
  function renderPosition(p) {
    runtime.renderingPosition = true;
    const selection = runtime.editor?.getSelection();
    const oldParts = [...runtime.partsBySection.values()];
    const endpoints = p.preserveSelection && selection && !selection.isEmpty() ?
      [selection.getStartPosition(), selection.getEndPosition()].map(pos => runtime.editorModel.getOffsetAt(pos)) : null;
    const viewState = runtime.editor?.saveViewState();
    const scroll = runtime.editor ? { scrollTop: runtime.editor.getScrollTop(), scrollLeft: runtime.editor.getScrollLeft() } : null;
    if (runtime.testEnabled && runtime.editorModel) { runtime.editor.render(); runtime.lineSnapshot = runtime.renderedLines(); }
    runtime.modelEdits = []; runtime.modelChanges = [];
    applyColors(p, false);
    runtime.projection = p;
    if (!p.preserveSelection) runtime.selected = { selected: null, related: [], syntaxId: null, properties: null };
    runtime.resetBindingFacts();
    if (!p.preserveSelection) runtime.hover = runtime.focused = null;
    runtime.partsBySection.clear();
    // Reattaching the editor would blur its textarea after the first step.
    if (editorHost.parentNode !== runtime.syntax) runtime.syntax.replaceChildren(editorHost);
    runtime.setTermContext(runtime.syntax, null);
    runtime.sections = runtime.M.sections(p);
    const combined = runtime.E.compose(runtime.sections);
    for (const part of combined.parts) runtime.partsBySection.set(part.section.id, { ...part,
      rangeIndex: new runtime.M.IntervalIndex(part.section.occurrences), viewport: editorHost, svg: runtime.arrowLayer });
    ensureEditor();
    if (runtime.editorModel) {
      // Keep Monaco's view and focused textarea attached. setModel creates a
      // fresh view at the initial cursor, whose focus can reveal line one.
      runtime.positionEdit = runtime.E.editText(runtime.editorModel, combined.text);
    } else {
      runtime.editorModel = runtime.monaco.editor.createModel(combined.text, 'macro-preview');
      if (runtime.testEnabled) {
        // Observe calls at the real model boundary, including an empty edit
        // for identical text, and independently record emitted content changes.
        const applyEdits = runtime.editorModel.applyEdits.bind(runtime.editorModel);
        runtime.editorModel.applyEdits = (edits, ...args) => {
          runtime.modelEdits.push(...edits.map(edit => ({ range: { ...edit.range }, text: edit.text })));
          return applyEdits(edits, ...args);
        };
        runtime.editorModel.onDidChangeContent(event => {
          for (const change of event.changes) runtime.modelChanges.push({ range: { ...change.range }, text: change.text });
        });
      }
      runtime.editor.setModel(runtime.editorModel);
      runtime.positionEdit = null;
    }
    runtime.editor.updateOptions({ lineNumbers: runtime.E.lineNumbers(runtime.editorModel, combined.parts) });
    configureEditor(); refreshTokens();
    if (viewState) runtime.editor.restoreViewState(viewState);
    if (endpoints) {
      const positions = endpoints.map((offset, index) => {
        const old = oldParts.find(part => part.start <= offset && offset <= part.end);
        const part = old && runtime.partsBySection.get(old.section.id);
        if (!part) return runtime.editorModel.getPositionAt(offset);
        // Identifier ranges exclude suffixes. Keep offsets within a name, and
        // move text after its suffix with the end of the printed identifier.
        const previous = old.section.occurrences.filter(o => p.terms[o.syntaxId]?.kind === 'identifier' && old.offset(o.range[0]) <= offset)
          .sort((a, b) => b.range[0] - a.range[0])[0];
        const occurrence = previous && part.rangeIndex.byId.get(previous.id);
        let mapped = part.start + offset - old.start;
        if (occurrence) {
          const end = old.offset(previous.range[1]), fullEnd = old.offset((previous.colorRange || previous.range)[1]);
          // At an insertion boundary, exclude the suffix at either edge of
          // the selection: its start follows the suffix, its end precedes it.
          if (offset < end || (offset === end && index === 1)) mapped = part.offset(occurrence.range[0]) + offset - old.offset(previous.range[0]);
          else if (offset < fullEnd) mapped = Math.min(part.offset(occurrence.range[1]) + offset - end, part.offset((occurrence.colorRange || occurrence.range)[1]));
          else mapped = part.offset((occurrence.colorRange || occurrence.range)[1]) + offset - fullEnd;
        }
        return runtime.editorModel.getPositionAt(mapped);
      });
      runtime.editor.setSelection({ startLineNumber: positions[0].lineNumber, startColumn: positions[0].column,
        endLineNumber: positions[1].lineNumber, endColumn: positions[1].column });
    } else if (p.preserveSelection) {
      const f = runtime.M.find(p, runtime.focused || runtime.selected.selected);
      const part = f && runtime.partsBySection.get(f.section.id);
      if (part) {
        // Coordinates change when suffixes grow or shrink. Restore occurrence
        // identity before the commit callback derives selection from the caret.
        const range = runtime.E.range(runtime.editorModel, part, f.occurrence.range);
        runtime.editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
      }
    }
    runtime.updateStatus();
    runtime.renderInspector(); runtime.updateDecorations(); runtime.editor.layout();
    const first = runtime.sections.find(x => x.section.focus.length);
    if (scroll) runtime.editor.setScrollPosition(scroll);
    else if (runtime.restoring && runtime.saved.source === runtime.state.source && Array.isArray(runtime.saved.scroll)) {
      runtime.editor.setScrollPosition({ scrollTop: runtime.saved.scroll[0], scrollLeft: runtime.saved.scroll[1] });
    }
    runtime.focusReveal = !p.preserveSelection && first ? runtime.E.revealFocus(runtime.editor, runtime.editorModel, runtime.partsBySection.get(first.section.id), runtime.monaco.editor.ScrollType.Immediate) : null;
    runtime.restoring = false; runtime.renderingPosition = false;
  }
  return { validateColors, editorHost, rebuildTheme, configureEditor, editorSurface, renderPosition, applyColors };
};
