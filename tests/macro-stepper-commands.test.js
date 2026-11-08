// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper commands behavior.
'use strict';
const { root, load, tick } = require('./support/macro-common');
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const Model = require('../vscode/macro-view/model');
const fs = require('node:fs');
const path = require('node:path');
const { project, fixtureAnswer, pair } = require('./support/macro-fixtures');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { pageScripts } = require('./support/macro-page-startup');

test('manifest routes keys and all panel commands using activeWebviewPanelId with debugger and input guards', () => {
  const { contributes: c } = require('../vscode/package.json');
  const keys = cmd => c.keybindings.filter(k => k.command === cmd);
  assert.deepEqual(keys('racketdap.stepMacros').map(k => k.key), ['alt+shift+m', 'alt+shift+m']);
  assert.match(keys('racketdap.stepMacros')[0].when, /editorLangId == racket/);
  const f10 = keys('racketdap.macroSteps.next').find(k => k.key === 'f10');
  assert.match(f10.when, /activeWebviewPanelId == 'racketeer.macroSteps'/); assert.match(f10.when, /!inDebugMode/);
  for (const k of c.keybindings.filter(k => k.command.includes('.macroSteps.'))) {
    assert.match(k.when, /racketdap.macroSteps.ready/); assert.match(k.when, /!racketdap.macroSteps.busy/);
    assert.match(k.when, /racketdap.macroSteps.focusWithin/); assert.match(k.when, /!racketdap.macroSteps.inputFocus/);
  }
  assert.ok(keys('racketdap.macroSteps.next').some(k => k.key === 'alt+right' && !/inDebugMode/.test(k.when)));
  assert.ok(keys('racketdap.macroSteps.previous').some(k => k.key === 'alt+left'));
  assert.doesNotMatch(JSON.stringify(c), /racket-expansion/);
});

test('roving syntax focus reaches every program and context from one tab stop', () => {
  const p = project(fixtureAnswer({}), 1);
  assert.deepEqual(Model.rove(p, null, 'down'), pair('b1', 'root'));
  assert.deepEqual(Model.rove(p, pair('b1', 'root'), 'right'), pair('a1', 'root'));
  assert.deepEqual(Model.rove(p, pair('a1', 'root'), 'left'), pair('b1', 'root'));
  assert.deepEqual(Model.rove(p, pair('a1', 'root'), 'down'), pair('a1', 'b'));
  assert.deepEqual(Model.rove(p, pair('a1', 'b'), 'right'), pair('a1', 'r'));
  assert.deepEqual(Model.rove(p, pair('a1', 'r'), 'up'), pair('a1', 'root'));
});

test('the view has no button elements, custom toolbar, search, or context menu', () => {
  const source = pageScripts().filter(([file]) => !/\/(model|geometry|protocol|monaco)\.js$/.test(file)).map(([, source]) => source).join('\n');
  const html = load({ vscode: { Uri: { joinPath: (_base, ...parts) => parts.join('/') } } })
    .panelHtml({ cspSource: 'local:', asWebviewUri: x => x }, 'extension');
  assert.doesNotMatch(source + html, /<button\b|(?:element|createElement)\(['"]button['"]|\bbutton\s*=(?!=)/i);
  assert.doesNotMatch(source, /toolbar|showMenu|type\s*=\s*['"]search['"]|searchAll|searchStatus/);
  assert.match(source, /element\('a', 'Refresh'\)/);
  assert.match(source, /data-vscode-context/);
});

test('macro menus expose only the approved actions with concise titles', () => {
  const { contributes: c } = require('../vscode/package.json');
  const prefix = 'racketdap.macroSteps.';
  const commands = Object.fromEntries(c.commands.filter(e => e.command.startsWith(prefix)).map(e => [e.command.slice(prefix.length), e]));
  const titles = {
    first: 'First Macro Step', previous: 'Previous Macro Step', next: 'Next Macro Step', last: 'Finish Macro Steps',
    showAll: "Show Racket's Macros Too", showMine: 'Show Only My Macros',
    jump: 'Racket: Jump to Macro Step', refresh: 'Racket: Refresh Macro Steps',
    properties: 'Racket: Show Details', goToSource: 'Racket: Go to Source', copyTerm: 'Racket: Copy',
    tack: 'Racket: Keep Arrows', release: 'Racket: Release Kept Arrows', drawBindingArrows: 'Draw Binding Arrows', untackAll: 'Racket: Clear Kept Arrows',
    definition: 'Racket: Go to Binder', references: 'Racket: Show Uses',
    openSavedSource: 'Racket: Open Saved Macro Source',
    duplicate: 'Racket: Duplicate Stepper', duplicateCurrentTerm: 'Racket: Duplicate Stepper (Current Term Only)',
    removeSelectedTerm: 'Racket: Remove Selected Term',
    resetMarkNumbering: 'Racket: Reset Mark Numbering', foregroundGrouping: 'Racket: Foreground Colors'
  };
  for (const [name, title] of Object.entries(titles)) assert.equal(commands[name]?.title, title, name);
  for (const name of ['first', 'previous', 'next', 'last', 'showAll', 'showMine']) {
    assert.equal(commands[name].category, 'Racket'); assert.ok(commands[name].icon);
    assert.match(commands[name].enablement, /ready/);
  }
  for (const name of ['relation', 'drawArrows', 'untack', 'cancel']) assert.equal(commands[name], undefined, name);
  const overflow = ['duplicate', 'duplicateCurrentTerm', 'removeSelectedTerm', 'hidingRules', 'jump', 'copyTerm', 'goToSource', 'tack', 'release', 'untackAll', 'properties', 'refresh', 'openSavedSource', 'resetMarkNumbering', 'foregroundGrouping'];
  const navigation = ['first', 'previous', 'next', 'last', 'hiding'];
  const options = ['oneTermAtATime', 'factorCommonContext', 'includeRenamingSteps', 'alwaysSuffixMarkedIdentifiers', 'highlightRedexContractum', 'drawBindingArrows', 'taintIcons'];
  const expected = {
    'editor/title': [...navigation, ...overflow, ...options],
    'webview/context': [...overflow.filter(name => name !== 'hidingRules'), 'definition', 'references', 'hideMacro', 'showMacro'],
    commandPalette: [...navigation, ...overflow, ...options]
  };
  for (const [menu, names] of Object.entries(expected)) {
    const entries = c.menus[menu].filter(e => e.command?.startsWith(prefix));
    assert.deepEqual(entries.filter(e => e.when !== 'false').map(e => e.command.slice(prefix.length)).sort(), names.slice().sort(), menu);
    for (const entry of entries.filter(e => e.when !== 'false')) {
      assert.match(entry.when, menu === 'webview/context' ? /webviewId == 'racketeer.macroSteps'/ : /activeWebviewPanelId == 'racketeer.macroSteps'/);
      if (entry.command === prefix + 'openSavedSource') assert.match(entry.when, /racketdap\.macroSteps\.savedSourceAvailable/);
      if (menu === 'editor/title') assert.equal((entry.group || '').startsWith('navigation'), navigation.includes(entry.command.slice(prefix.length)));
    }
  }
  for (const name of ['clearSelection', 'morePhases', 'definition', 'references', 'hideMacro', 'showMacro', 'showAll', 'showMine']) {
    assert.equal(c.menus.commandPalette.find(e => e.command === prefix + name)?.when, 'false', name);
  }
  assert.ok(c.keybindings.some(e => e.command === prefix + 'clearSelection' && e.key === 'escape'));
});

test('only useful macro commands remain registered, including keyboard and details actions', () => {
  const ui = fakeStepper();
  try {
    for (const name of ['relation', 'drawArrows', 'untack', 'cancel']) assert.equal(ui.commands[`racketdap.macroSteps.${name}`], undefined, name);
    for (const name of ['clearSelection', 'morePhases', 'definition', 'references', 'untackAll']) assert.equal(typeof ui.commands[`racketdap.macroSteps.${name}`], 'function', name);
  } finally { ui.dispose(); }
});

test('the saved-source menu context follows the active pane and an untitled source being saved', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  const original = await opened(ui, 'unsaved'), [before, after] = ui.panels;
  const available = () => ui.contexts['racketdap.macroSteps.savedSourceAvailable'];
  assert.equal(available(), false);
  ui.close(original);
  const saved = await ui.source('saved');
  saved.uri = new saved.uri.constructor('file', '/workspace/saved.rkt');
  ui.save(saved); before.reveal(); await tick();
  assert.equal(available(), true);
  after.reveal(); assert.equal(available(), true, 'Both panes share source availability');
  await opened(ui, 'other'); assert.equal(available(), false);
  before.reveal(); assert.equal(available(), true);
});

test('the extension exposes the panel identity used by its registered views', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const extension = load({ vscode: {} });
  assert.equal(extension.viewType, ui.panels[0].type);
});
