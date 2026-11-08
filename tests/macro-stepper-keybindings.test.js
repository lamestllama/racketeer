// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./support/node-test');
const { root, plain } = require('./support/macro-common');
const { fakeMacroConnections } = require('./support/macro-page');
const { project, fixtureAnswer } = require('./support/macro-fixtures');
const esbuild = require(require.resolve('esbuild', { paths: [path.join(root, 'vscode')] }));
const base = './vscode/node_modules/monaco-editor/esm/vs/';
// Bundle the shipped contributions and real keybinding service, not a list of
// expected folding shortcuts or a replacement key event dispatcher.
const bundle = esbuild.buildSync({
  stdin: { resolveDir: root, contents: `
    export * from './vscode/macro-view/monaco-entry.js';
    export { StandaloneServices, StandaloneKeybindingService } from '${base}editor/standalone/browser/standaloneServices.js';
    export { IKeybindingService } from '${base}platform/keybinding/common/keybinding.js';
    export { EditorExtensionsRegistry } from '${base}editor/browser/editorExtensions.js';
  ` },
  bundle: true, write: false, format: 'iife', globalName: 'Monaco', loader: { '.css': 'empty', '.ttf': 'empty' }
}).outputFiles[0].text;

function paneKeys(t, side, platform) {
  const noop = () => {}, event = () => ({ dispose: noop });
  const node = { style: {}, setAttribute: noop, append: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop };
  const document = { createElement: () => ({ ...node }), querySelectorAll: () => [], addEventListener: noop,
    removeEventListener: noop, documentElement: node, body: node, hasFocus: () => true };
  const context = vm.createContext({
    window: { document, location: { href: 'http://localhost/' }, addEventListener: noop,
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) },
    document, navigator: { userAgent: platform, language: 'en' }, HTMLElement: class {}, UIEvent: class {},
    customElements: { get: () => true }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console, URL, TextEncoder, TextDecoder, crypto: require('node:crypto').webcrypto, performance
  });
  vm.runInContext(bundle, context);
  const m = context.Monaco, listeners = new Map(), executed = [];
  // A new command and a second binding for it catch hard-coded command lists
  // and removals that accidentally disable every shortcut for a command.
  t.after(() => futureBinding.dispose());
  const futureBinding = m.KeybindingsRegistry.registerKeybindingRule({
    id: 'test.futureMacroChord', weight: 100,
    primary: m.KeyMod.chord(m.KeyMod.CtrlCmd | m.KeyCode.KeyK, m.KeyCode.KeyJ),
    secondary: [m.KeyMod.CtrlCmd | m.KeyCode.KeyJ]
  });
  const target = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const service = new m.StandaloneKeybindingService(
    { getContext: () => ({ getValue: name => ({ editorTextFocus: true, editorFocus: true, textInputFocus: true, editorReadonly: true,
      foldingEnabled: true, editorHasSelection: false }[name]) }) },
    { executeCommand: command => { executed.push(command); return Promise.resolve(); } },
    { publicLog2: noop }, { status: () => ({ dispose: noop }) }, { trace: noop, debug: noop },
    { onCodeEditorAdd: event, onCodeEditorRemove: event, onDiffEditorAdd: event, onDiffEditorRemove: event,
      listCodeEditors: () => [{ getOption: () => false, getContainerDomNode: () => target }], listDiffEditors: () => [] });
  t.after(() => service.dispose());
  m.StandaloneServices.get = id => { assert.equal(id, m.IKeybindingService); return service; };
  const pane = fakeMacroConnections(side);
  for (const name of ['KeybindingsRegistry', 'KeyCode', 'KeyMod', 'isMacintosh']) pane.page.monaco[name] = m[name];
  pane.page.monaco.editor.addKeybindingRules = m.editor.addKeybindingRules;
  const key = (keyCode, modifiers = {}) => {
    const e = { keyCode, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...modifiers };
    listeners.get('keydown')(e);
    return { prevented: e.prevented, stopped: e.stopped };
  };
  return { ...pane, m, service, executed, key, setup: () => pane.render(project(fixtureAnswer({}), 1)) };
}

const startsWithK = binding => /^(?:ctrl|meta)\+K$/.test(binding.chords[0]);

test('Macro Hiding contributes the rebindable chord with the pane readiness and focus guards', () => {
  const bindings = require('../vscode/package.json').contributes.keybindings;
  assert.deepEqual(bindings.filter(k => k.command === 'racketdap.macroSteps.hiding'), [{
    command: 'racketdap.macroSteps.hiding', key: 'ctrl+k h', mac: 'cmd+k h',
    when: "activeWebviewPanelId == 'racketeer.macroSteps' && racketdap.macroSteps.ready && !racketdap.macroSteps.busy && racketdap.macroSteps.focusWithin && !racketdap.macroSteps.inputFocus"
  }]);
});

for (const platform of ['Windows', 'Linux', 'Macintosh']) for (const side of ['before', 'after']) {
  test(`${platform} ${side}: setup removes every Ctrl/Cmd+K binding and preserves other keys`, t => {
    const p = paneKeys(t, side, platform), before = p.service.getKeybindings();
    assert.ok(before.some(startsWithK), 'The real folding contributions start with Ctrl/Cmd+K');
    p.setup();
    const after = p.service.getKeybindings();
    assert.equal(after.some(startsWithK), false);
    assert.deepEqual(plain(after.map(k => [k.command, k.chords])),
      plain(before.filter(k => !startsWithK(k)).map(k => [k.command, k.chords])));
  });

  test(`${platform} ${side}: Monaco leaves the hiding chord keydowns unhandled`, t => {
    const p = paneKeys(t, side, platform); p.setup();
    assert.deepEqual(p.key(75, platform === 'Macintosh' ? { metaKey: true } : { ctrlKey: true }),
      { prevented: false, stopped: false });
    assert.equal(p.service.inChordMode, false);
    assert.deepEqual(p.key(72), { prevented: false, stopped: false }, 'H also reaches the workbench');
    assert.deepEqual(p.executed, []);
    assert.ok(!p.m.EditorExtensionsRegistry.getEditorContributions().some(c => c.id === 'editor.contrib.readOnlyMessageController'),
      'The shipped editor does not show a read-only message for H');
    assert.deepEqual(p.key(37), { prevented: true, stopped: true }, 'Monaco still handles Left');
    assert.deepEqual(p.executed, ['cursorLeft']);
  });

  test(`${platform} ${side}: gutter clicks still fold and unfold after setup`, t => {
    const p = paneKeys(t, side, platform); p.setup();
    assert.equal(p.created[0].options.folding, true);
    assert.equal(p.created[0].options.foldingStrategy, 'indentation');
    const folding = p.m.EditorExtensionsRegistry.getEditorContributions().find(c => c.id === 'editor.contrib.folding');
    assert.ok(folding);
    const region = { startLineNumber: 1, isCollapsed: false };
    const controller = Object.assign(Object.create(folding.ctor.prototype), {
      hiddenRangeModel: {}, foldingModel: { getRegionAtLine: () => region,
        toggleCollapseState: regions => { assert.equal(regions.length, 1); assert.equal(regions[0], region); region.isCollapsed = !region.isCollapsed; } }, reveal() {}
    });
    const click = { event: { leftButton: true }, target: { type: p.m.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
      range: { startLineNumber: 1 }, detail: { offsetX: 10 }, element: { offsetLeft: 0 } } };
    for (const collapsed of [true, false]) {
      controller.onEditorMouseDown(click); controller.onEditorMouseUp(click);
      assert.equal(region.isCollapsed, collapsed);
    }
  });
}
