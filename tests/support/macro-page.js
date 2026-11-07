// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Provides Monaco page fakes and pointer-driving fixtures.
'use strict';
const { plain } = require('./macro-common');
const { fakeModel } = require('./macro-fixtures');
const { startPage, pageScripts } = require('./macro-page-startup');
function fakeMacroPage(side = 'before', { sources, globals } = {}) {
  const zones = [], disposed = [], created = [], models = [], handlers = {}, scrolls = [], reveals = [], options = {}, edits = [], decorationCalls = [];
  let scrollTop = 0, scrollLeft = 0;
  let textFocus = true, selectionStart = { lineNumber: 1, column: 1 }, selectionEnd = selectionStart;
  const editor = { changeViewZones(fn) { fn({ addZone(zone) { zones.push(zone); return zones.length; }, removeZone() {} }); },
    setModel(m) { models.push(m); scrollTop = scrollLeft = 0; }, layout() {}, render() {},
    saveViewState: () => ({ scrollTop, scrollLeft, selection: plain(editor.getSelection()) }),
    restoreViewState(v) { scrollTop = v.scrollTop; scrollLeft = v.scrollLeft; editor.setSelection(v.selection); },
    deltaDecorations(old, values) { decorationCalls.push(plain({ old, values })); return values.map((_, i) => `d${decorationCalls.length}-${i}`); },
    updateOptions(o) { Object.assign(options, o); },
    getScrollTop: () => scrollTop, getScrollLeft: () => scrollLeft,
    setScrollLeft(n) { scrollLeft = n; },
    setScrollPosition(p) { scrolls.push(plain(p)); scrollTop = p.scrollTop; scrollLeft = p.scrollLeft; },
    getVisibleRanges: () => [{ startLineNumber: Math.floor(scrollTop / 20) + 1, endLineNumber: Math.floor(scrollTop / 20) + 20 }],
    revealLineInCenter(line, mode) { reveals.push({ line, mode }); scrollTop = Math.max(0, (line - 10) * 20); scrollLeft = 0; },
    getScrolledVisiblePosition: p => ({ left: 40 + (p.column - 1) * 8 - scrollLeft, top: (p.lineNumber - 1) * 20 - scrollTop, height: 20 }),
    getLayoutInfo: () => ({ contentLeft: 40, contentWidth: 800 }),
    getSelection: () => ({ startLineNumber: selectionStart.lineNumber, startColumn: selectionStart.column,
      endLineNumber: selectionEnd.lineNumber, endColumn: selectionEnd.column, isEmpty: () => selectionStart.lineNumber === selectionEnd.lineNumber && selectionStart.column === selectionEnd.column,
      getStartPosition: () => selectionStart, getEndPosition: () => selectionEnd }),
    getSelections: () => [editor.getSelection()], getPosition: () => selectionEnd,
    setSelection(r) {
      selectionStart = { lineNumber: r.startLineNumber, column: r.startColumn };
      selectionEnd = { lineNumber: r.endLineNumber, column: r.endColumn };
      handlers.onDidChangeCursorSelection?.({ selection: editor.getSelection() });
    },
    setPosition(p) { editor.setSelection({ startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column }); } };
  for (const name of ['onDidScrollChange', 'onDidLayoutChange', 'onDidContentSizeChange', 'onDidChangeModelDecorations', 'onMouseMove', 'onMouseLeave', 'onMouseDown', 'onMouseUp', 'onDidChangeCursorSelection']) editor[name] = fn => { handlers[name] = fn; };
  const monaco = { services: { IWebWorkerService: {} }, colorIds: [], tokenizeModel() {},
    KeybindingsRegistry: { getDefaultKeybindings: () => [] }, KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyK: 41 }, isMacintosh: false,
    languages: { register() {}, setLanguageConfiguration() {}, setTokensProvider: () => ({ dispose() {} }) },
    editor: { ScrollType: { Immediate: 1 },
      EditorOption: Object.fromEntries(['lineNumbers', 'readOnly', 'minimap', 'wordWrap', 'lineHeight', 'occurrencesHighlight', 'selectionHighlight', 'fontInfo'].map(key => [key, key])),
      defineTheme() {}, setTheme() {}, addKeybindingRules() {},
      create(node, initialOptions, services) { created.push({ node, options: initialOptions, services }); Object.assign(options, initialOptions); return editor; },
      createModel(text, language) { let contentListener; const m = { ...fakeModel(text), getLineCount: () => m.getValue().split('\n').length,
        getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: m.getLineCount(), endColumn: m.getLineMaxColumn(m.getLineCount()) }),
        onDidChangeContent(fn) { contentListener = fn; },
        applyEdits(operations, undo) {
          edits.push(plain({ operations, undo }));
          for (const { range, text } of operations) {
            const old = m.getValue(), start = m.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
            const end = m.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
            Object.assign(m, fakeModel(old.slice(0, start) + text + old.slice(end)));
            if (old !== m.getValue()) contentListener?.({ changes: [{ range, text }] });
          }
        },
        dispose: () => disposed.push(m), language }; return m; }
    } };
  let decorations = [];
  const deltaDecorations = editor.deltaDecorations;
  Object.assign(editor, {
    deltaDecorations(old, values) { decorations = values; return deltaDecorations(old, values); },
    getLayoutInfo: () => ({ width: 860, height: 400, contentLeft: 40, contentWidth: 800, horizontalScrollbarHeight: 10 }),
    getOption: key => key === 'fontInfo' ? { fontFamily: 'monospace', fontSize: 14, fontWeight: 'normal', lineHeight: 20 } :
      key === 'lineNumbers' ? { renderFn: options.lineNumbers } : options[key],
    getScrollWidth: () => 860, getContribution: () => undefined, hasTextFocus: () => textFocus, focus() { textFocus = true; }, dispose() {},
    revealPositionInCenterIfOutsideViewport(position, mode) {
      if (mode === monaco.editor.ScrollType.Immediate) editor.setScrollPosition({
        scrollTop: Math.max(0, (position.lineNumber - 1) * 20 - 100), scrollLeft: 0
      });
    }
  });
  const startup = startPage(pageScripts(sources), { MacroMonaco: monaco, ...globals });
  const page = startup.runtime;
  // Tests can drive host globals without changing any component's interface.
  for (const name of Object.keys(startup.context)) if (!(name in page)) Object.defineProperty(page, name, {
    get: () => startup.context[name], set: value => { startup.context[name] = value; }, configurable: true
  });
  page.env = { sessionId: 'session', generation: 1, positionRevision: 1 };
  page.state.source = 'untitled:scroll'; page.restoring = false;
  const replaceChildren = page.syntax.replaceChildren;
  page.syntax.replaceChildren = function (node) { if (node.parentNode === this) textFocus = false; replaceChildren.call(this, node); };
  const createModel = monaco.editor.createModel;
  monaco.editor.createModel = (...args) => {
    const model = createModel(...args); model.updateOptions = () => {}; model.getAllDecorations = () => decorations; model.getDecorationsInRange = () => []; return model;
  };
  return { page, editor, zones, disposed, created, models, handlers, options, scrolls, reveals, edits, decorationCalls,
    ...startup, textFocus: () => textFocus };
}
function fakeMacroConnections(side, options) {
  const pane = fakeMacroPage(side, options), { page } = pane;
  const render = p => { page.renderPosition({ ...p, pane: side }); page.draw(); };
  const observe = () => { page.draw(); return plain(page.observation()); };
  return { ...pane, render, observe };
}

function connectMacroDrive(panel, side, received = []) {
  const pane = fakeMacroConnections(side), { page, editor, handlers } = pane;
  const viewport = { width: 860, height: 400 };
  let layout = editor.getLayoutInfo(), pendingLeft;
  editor.getLayoutInfo = () => layout;
  editor.layout = () => { layout = { ...layout, ...viewport, contentWidth: viewport.width - 60 }; };
  const reveal = (range, mode) => {
    if (mode !== page.monaco.editor.ScrollType.Immediate) return;
    const top = (range.startLineNumber - 1) * 20;
    const left = (range.startColumn - 1) * 8, right = (range.endColumn - 1) * 8;
    editor.setScrollPosition({
      scrollTop: top < editor.getScrollTop() || top + 20 > editor.getScrollTop() + layout.height - 10
        ? Math.max(0, top - 100) : editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft()
    });
    pendingLeft = left < editor.getScrollLeft() ? left : Math.max(editor.getScrollLeft(), right - layout.contentWidth);
  };
  editor.revealRangeInCenterIfOutsideViewport = reveal;
  editor.revealPositionInCenterIfOutsideViewport = (position, mode) => reveal({
    startLineNumber: position.lineNumber, startColumn: position.column, endColumn: position.column
  }, mode);
  const targetAt = (x, y) => {
    if (x < 40 || x >= Math.min(viewport.width, layout.width) - 20 || y < 0 || y >= Math.min(viewport.height, layout.height) - 10) return null;
    const lineNumber = Math.floor((y + editor.getScrollTop()) / 20) + 1;
    const columnAtPointer = (x + editor.getScrollLeft() - 40) / 8;
    const column = Math.floor(columnAtPointer) + 1;
    return { position: { lineNumber, column: Math.round(columnAtPointer) + 1 }, range: {
      startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column + 1
    } };
  };
  editor.getTargetAtClientPoint = targetAt;
  // Monaco applies horizontal reveal while rendering its lines.
  editor.render = () => { if (pendingLeft !== undefined) { editor.setScrollLeft(pendingLeft); pendingLeft = undefined; } };
  const node = { tagName: 'SPAN', getAttribute: name => name === 'class' ? 'mtk1' : null, dispatchEvent(e) {
    const target = targetAt(e.clientX, e.clientY);
    if (e.type === 'mousedown') { editor.setPosition(target.position); handlers.onMouseDown({ event: { leftButton: true }, target }); }
    if (e.type === 'mousemove') handlers.onMouseMove({ event: { leftButton: true }, target });
  } };
  Object.assign(page, { testEnabled: true, pendingDrives: new Set(), loading: false,
    requestAnimationFrame: fn => setImmediate(fn),
    MouseEvent: class { constructor(type, fields) { Object.assign(this, { type }, fields); } },
    PointerEvent: class { constructor(type, fields) { Object.assign(this, { type }, fields); } },
    send: (type, fields) => panel.send(type, fields) });
  page.document.elementFromPoint = (x, y) => x >= 40 && x < viewport.width - 20 && y >= 0 && y < viewport.height - 10 ? node : null;
  page.document.hasFocus = () => true;
  page.document.visibilityState = 'visible';
  page.editorSurface.contains = candidate => candidate === node;
  const validate = panel.receiver.validate;
  panel.receiver.validate = (value, kind) => {
    const result = validate(value, kind);
    if (kind === 'position') pane.render(result);
    if (kind === 'selection') page.selected = result;
    return result;
  };
  pane.render(panel.projection);
  const post = panel.webview.postMessage;
  panel.webview.postMessage = async m => {
    await post(m);
    if (m.type === 'testDrive') { received.push({ panel, operation: m.operation }); await page.testDrive(m); }
    return true;
  };
  return { ...pane, pointerNode: node, viewport };
}
module.exports = { fakeMacroPage, fakeMacroConnections, connectMacroDrive };
