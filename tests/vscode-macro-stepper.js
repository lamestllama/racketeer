// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const TokenColors = require('../vscode/macro-token-colors');
const Model = require('../vscode/macro-view/model');
const Editor = require('../vscode/macro-view/monaco');
const tokenWasm = require.resolve('../vscode/node_modules/vscode-oniguruma/release/onig.wasm');

// Workbench key dispatch, theme/high-contrast, zoom and screen-reader use
// require editor acceptance; command execution alone does not prove key routing.
const tabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t =>
  t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('racketeer.macroSteps'));
const command = (name, ...args) => vscode.commands.executeCommand(`racketdap.macroSteps.${name}`, ...args);
// These commands exist only in the isolated extension test host. Observations
// come from the real page after its renderer acknowledges a committed position.
async function observed(predicate = () => true, description = 'macro view is rendered') {
  let latest;
  await until(async () => {
    latest = await command('_observe');
    return !!latest && !latest.busy && latest.rendered?.position === latest.position &&
      latest.rendered.generation === latest.generation && latest.rendered.positionRevision === latest.revision && latest.pair.every(p => p.rendered?.position === latest.position && p.rendered.generation === latest.generation && p.rendered.positionRevision === p.revision) && predicate(latest);
  }, description, () => JSON.stringify(latest && { position: latest.position, count: latest.count, busy: latest.busy, hiding: latest.hiding, custom: latest.custom, failure: latest.failure, rendered: latest.rendered }));
  const file = path.basename(vscode.Uri.parse(latest.source).path);
  for (const pane of latest.pair) {
    const metadata = latest.projection?.record;
    // Positions are counted as navigation counts them, the finished position included.
    const status = latest.failure ? 'Error' : pane.side === 'before'
      ? `Step ${latest.position} of ${latest.count}`
      : latest.projection?.error ? 'Error' : !metadata ? 'Finished' : `[${metadata.label}]${metadata.macro ? ` ${metadata.macro}` : ''}`;
    const title = `${pane.side === 'before' ? 'Before' : 'After'} - ${status} - ${file}${latest.hiding === 'custom' && latest.custom.enabled ? ' (Custom)' : ''}`;
    assert.equal(pane.title, title);
    assert.ok(tabs().some(tab => tab.label === title && tab.group.viewColumn === pane.column), 'Workbench tab has the pane title and group');
    assert.equal(pane.rendered.observation.editorCount, 1, 'Each pane has one Monaco editor');
    assert.equal(pane.rendered.observation.wordWrap, 'off');
    const diagnostic = pane.side === 'after' && latest.projection?.error
      ? latest.projection.diagnostics[latest.projection.error].message : '';
    assert.equal(pane.rendered.observation.note, [diagnostic, latest.failure].filter(Boolean).join('\n'),
      'Only expansion errors appear above the program');
  }
  assert.ok(tabs().some(tab => tab.isActive && tab.label === latest.title));
  return latest;
}
async function focusSide(side) {
  const tab = tabs().find(t => t.label.startsWith(side === 'before' ? 'Before - ' : 'After - '));
  const group = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'][tab.group.viewColumn - 1];
  await vscode.commands.executeCommand(`workbench.action.focus${group}EditorGroup`);
  return observed(s => {
    const group = vscode.window.tabGroups.activeTabGroup, tab = group.activeTab;
    return s.side === side && group.viewColumn === s.panelColumn && tab?.label === s.title &&
      tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('racketeer.macroSteps');
  }, `${side} macro pane has workbench focus`);
}
async function go(name, position) {
  await command(name); return observed(s => position === 'end' ? s.position === s.count : s.position === position, name);
}
async function drive(operation) {
  const result = await command('_drive', operation); assert.ok(result, `Page adapter answered ${operation.type}`);
  assert.equal(result.driveError, undefined, result.driveError); return result;
}
async function defineColor(dom) {
  let token = dom.tokens.find(t => t.text.trim() === 'define');
  assert.ok(token, 'The page observes a printed define token');
  assert.ok(token.scopes.includes('keyword.control.racket'));
  const theme = await TokenColors.resolveTheme(vscode);
  assert.equal(dom.themeName, theme.name);
  // Resolve this actual scope stack independently of the printed program.
  const resolver = await TokenColors.createTokenizer(theme, { wasmPath: tokenWasm, grammar: {
    scopeName: token.scopes[0], patterns: [{ match: 'x', name: token.scopes.slice(1).join(' ') }]
  } });
  try {
    const expected = resolver.styles[resolver.tokenize('x')[0].style];
    assert.equal(token.resolved.foreground, expected.foreground);
    const hex = expected.foreground;
    assert.match(hex, /^#[\da-f]{6}$/i);
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
    const expectedColor = `rgb(${rgb.join(', ')})`;
    await until(async () => { token = (await drive({ type: 'observe' })).tokens.find(t => t.text === 'define'); return token?.color === expectedColor; }, 'The rendered Monaco token has the theme scope color');
    assert.equal(token.color, expectedColor);
    return token.color;
  } finally { resolver.dispose(); }
}
function appearances(p) {
  return Model.sections(p).flatMap(({ section }) => section.occurrences.map(o => ({
    section, occurrence: o, target: { sectionId: section.id, occurrenceId: o.id }
  })));
}
function sourceAppearance(p, renderedSections, source) {
  return appearances(p).find(a => {
    if (!renderedSections.includes(a.section.id)) return false;
    // Fully covered wrappers have no unique click target; use an occurrence
    // with a character that the pointer can select independently.
    if (Model.clickOffset(a.section, a.occurrence) === null) return false;
    const term = p.terms[a.occurrence.syntaxId];
    return term.source && p.sources[term.source.sourceId]?.value === source;
  });
}
function horizontalStep(beforeStep, afterStep, description) {
  const facts = afterStep.focusReveal;
  const message = `${description}: ${JSON.stringify({ beforeStep: beforeStep.focusViewport, reveal: facts, afterStep: afterStep.focusViewport })}`;
  assert.ok(facts, message);
  const { focusStart, horizontalRange } = facts.before;
  assert.equal(typeof focusStart.left, 'number', message);
  assert.equal(horizontalRange.start, beforeStep.scrollLeft, message);
  const visible = focusStart.left >= horizontalRange.start && focusStart.left < horizontalRange.end;
  const expected = visible ? beforeStep.scrollLeft : focusStart.left < horizontalRange.start
    ? Math.floor(focusStart.left) : Math.floor(focusStart.left - (horizontalRange.end - horizontalRange.start)) + 1;
  assert.equal(afterStep.scrollLeft, expected, message);
  assert.equal(facts.after.horizontalRange.start, afterStep.scrollLeft, message);
  assert.equal(afterStep.focusViewport.horizontalRange.start, afterStep.scrollLeft, message);
  assert.ok(Math.abs(afterStep.focusViewport.focusStart.left - focusStart.left) <= 1, message);
  assert.ok(afterStep.focusViewport.focusStart.left >= afterStep.scrollLeft &&
    afterStep.focusViewport.focusStart.left < afterStep.focusViewport.horizontalRange.end, message);
  return visible;
}

function incrementalStep(dom, side) {
  const edit = dom.modelEdit;
  assert.ok(edit, `${side} reports the model edit for this step`);
  assert.equal(edit.count, 1, `${side} makes one model edit per step`);
  assert.equal(edit.changes.length, 1);
  assert.deepEqual(edit.changes[0].range, edit.range, 'The recorded range comes from the model change event');
  assert.ok(edit.range.startLineNumber > 1, 'The unchanged program prefix stays in the model');
  assert.ok(edit.retained.length > 0, `${side} checks visible lines outside the changed range`);
  assert.ok(edit.retained.every(line => line.sameElement), `${side} retains rendered line elements outside the changed range: ${JSON.stringify(edit)}`);
  assert.doesNotMatch(dom.note, /Loading position|Expanding/);
}

exports.run = async function (extension, workspace) {
  const c = extension.packageJSON.contributes, prefix = 'racketdap.macroSteps.';
  const titles = { properties: 'Racket: Show Details', goToSource: 'Racket: Go to Source', copyTerm: 'Racket: Copy',
    tack: 'Racket: Keep Arrows', untackAll: 'Racket: Clear Kept Arrows', definition: 'Racket: Go to Binder', references: 'Racket: Show Uses' };
  for (const [name, title] of Object.entries(titles)) assert.equal(c.commands.find(e => e.command === prefix + name)?.title, title);
  const registered = await vscode.commands.getCommands(true);
  for (const name of ['relation', 'drawArrows', 'untack', 'cancel']) {
    assert.ok(!registered.includes(prefix + name)); assert.ok(!c.commands.some(e => e.command === prefix + name));
  }
  for (const [menu, entries] of Object.entries(c.menus)) for (const entry of entries) {
    if (!entry.command?.startsWith(prefix) || entry.when === 'false') continue;
    const name = entry.command.slice(prefix.length);
    assert.ok(!['relation', 'drawArrows', 'clearSelection', 'cancel', 'morePhases', 'untack'].includes(name), `${menu}: ${name}`);
    if (['definition', 'references'].includes(name)) assert.equal(menu, 'webview/context');
    if (name === 'openSavedSource') assert.match(entry.when, /racketdap\.macroSteps\.savedSourceAvailable/);
  }
  const config = vscode.workspace.getConfiguration('racketdap', workspace.uri);
  const workbench = vscode.workspace.getConfiguration('workbench');
  const editorColors = vscode.workspace.getConfiguration('editor');
  const previousTheme = workbench.inspect('colorTheme').workspaceValue;
  const previousColors = workbench.inspect('colorCustomizations').workspaceValue;
  const previousTokens = editorColors.inspect('tokenColorCustomizations').workspaceValue;
  const bracketSettings = vscode.workspace.getConfiguration('editor', { uri: workspace.uri, languageId: 'racket' });
  const previousBrackets = bracketSettings.inspect('bracketPairColorization.enabled').workspaceLanguageValue;
  const previousPools = bracketSettings.inspect('bracketPairColorization.independentColorPoolPerBracketType').workspaceLanguageValue;
  const previous = config.inspect('languageServer.enabled').workspaceValue;
  await config.update('languageServer.enabled', false, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('racketdap.restartLanguageServer'); await extension.exports.languageServerReady();
  const directory = path.join(workspace.uri.fsPath, 'macro-stepper-acceptance');
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'dirty λ😀.rkt'), support = path.join(directory, 'support.rkt');
  const marker = path.join(directory, 'expanded.txt'), runtime = path.join(directory, 'runtime-must-not-run.txt');
  const buffers = [];
  const closePanels = () => vscode.window.tabGroups.close(tabs());
  async function replace(document, text) {
    const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  let dom, document, sourceColumn, panelColumn, currentSide = 'before';
  const focusPanel = () => focusSide(currentSide);
  try {
    await bracketSettings.update('bracketPairColorization.enabled', true, vscode.ConfigurationTarget.Workspace, true);
    await bracketSettings.update('bracketPairColorization.independentColorPoolPerBracketType', false, vscode.ConfigurationTarget.Workspace, true);
    for (const file of [marker, runtime]) fs.rmSync(file, { force: true });
    fs.writeFileSync(support, '#lang racket/base\n(provide answer)\n(define-syntax-rule (helper) 42)\n(define-syntax-rule (answer) (list (helper)))\n(error "import runtime must not run")\n');
    fs.writeFileSync(source, '#lang racket/base\n(error "on-disk version must not be used")\n');
    const onDisk = fs.readFileSync(source, 'utf8');
    document = await vscode.workspace.openTextDocument(source); buffers.push(document);
    const editor = await vscode.window.showTextDocument(document); sourceColumn = editor.viewColumn;
    const text = `#lang racket/base\n(require "support.rkt" (for-syntax racket/base))\n` +
      `(begin-for-syntax (call-with-output-file ${JSON.stringify(marker)} #:exists 'append (lambda (out) (display "x" out))))\n` +
      '(define-syntax-rule (twice e) (list e e))\n' + Array.from({ length: 80 }, (_, i) => `(define padding${i} ${i})\n`).join('') +
      '(define result (answer))\n(define pair (twice 1))\n(or #f 1)\n; nothing here\n' +
      `(define long-line "${'x'.repeat(4000)}")\n` +
      `(call-with-output-file ${JSON.stringify(runtime)} (lambda (out) (display result out)))\n`;
    await replace(document, text);
    await vscode.commands.executeCommand('racketdap.stepMacrosInFile');
    let s = await observed(s => s.position === 1 && s.projection.record?.macro === 'answer');
    assert.equal(s.count, 4, 'Three rewrites plus completion');
    assert.deepEqual(s.loadedPositions, [1], 'Opening requests only the displayed position');
    const workerSession = s.workerSession; assert.ok(workerSession);
    assert.equal(tabs().length, 2); panelColumn = s.panelColumn; assert.notEqual(panelColumn, sourceColumn);
    assert.equal(s.sourceColumn, sourceColumn); assert.equal(s.rendered.mounted, true);
    const columns = Object.fromEntries(s.pair.map(p => [p.side, p.column]));
    const initialLayout = await vscode.commands.executeCommand('vscode.getEditorLayout');
    const groupNode = column => {
      let index = 0, found;
      const visit = (node, parent) => { if (node.groups) node.groups.forEach(n => visit(n, node)); else if (++index === column) found = parent; };
      visit(initialLayout); return found;
    };
    assert.notEqual(columns.before, columns.after);
    assert.equal(groupNode(columns.before), groupNode(columns.after), 'Before and After share the stack beside source');
    assert.equal(columns.after, columns.before + 1, 'Before opens above After');
    const stack = groupNode(columns.before);
    assert.equal(initialLayout.orientation, 0, 'The source and macro stack are beside each other');
    assert.equal(stack.groups.length, 2, 'The macro stack has two groups');
    // Move the actual tab using public workbench commands, as dragging it would.
    await focusSide('after');
    await vscode.commands.executeCommand('workbench.action.moveEditorToAboveGroup');
    await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
    s = await observed(s => s.side === 'after');
    const movedColumns = s.pair.map(p => p.column);
    await command('next'); s = await observed(s => s.position === 2);
    assert.deepEqual(s.pair.map(p => p.column), movedColumns, 'Stepping keeps both moved tabs in their groups');
    const movedLayout = await vscode.commands.executeCommand('vscode.getEditorLayout');
    assert.equal(movedLayout.groups.length, 3, 'Source, Before and After are now beside each other');
    assert.equal(movedLayout.orientation, 0);
    await go('first', 1);
    for (const side of ['before', 'after']) {
      s = await focusSide(side);
      await workbench.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
      await until(async () => (await drive({ type: 'observe' })).themeName === 'Default Dark Modern', 'Dark theme reaches the page');
      await drive({ type: 'revealStart' });
      const darkColor = await defineColor(await drive({ type: 'observe' }));
      const bracketView = await drive({ type: 'observe' });
      const outer = bracketView.brackets.find(b => b.sectionId === s.projection.record[side].id && b.start === 0);
      assert.ok(outer, 'The outer bracket is rendered by Monaco');
      assert.match(outer.className, /\bbracket-highlighting-0\b/);
      const inner = bracketView.brackets.find(b => b.sectionId === outer.sectionId && /\bbracket-highlighting-1\b/.test(b.className));
      assert.ok(inner); assert.notEqual(inner.color, outer.color);
      const fourth = bracketView.brackets.find(b => b.sectionId === outer.sectionId && /\bbracket-highlighting-3\b/.test(b.className));
      assert.ok(fourth, 'A fourth-level bracket is visible');
      assert.equal(fourth.color, outer.color, 'Monaco cycles the three visible theme colors');
      assert.ok(fourth.color);
      assert.doesNotMatch(fourth.color, /transparent|^rgba\(.*,\s*0(?:\.0+)?\)$|\/\s*0(?:\.0+)?%?\s*\)$/i);
      await bracketSettings.update('bracketPairColorization.enabled', false, vscode.ConfigurationTarget.Workspace, true);
      await until(async () => !(await drive({ type: 'observe' })).brackets.length, 'Disabling bracket colors reaches the page');
      await bracketSettings.update('bracketPairColorization.enabled', true, vscode.ConfigurationTarget.Workspace, true);
      await until(async () => (await drive({ type: 'observe' })).brackets.length > 0, 'Enabling bracket colors reaches the page');
      await workbench.update('colorTheme', 'Default Light+', vscode.ConfigurationTarget.Workspace);
      await until(async () => (await drive({ type: 'observe' })).themeName === 'Default Light+', 'Light theme reaches the page');
      await drive({ type: 'revealStart' });
      const lightColor = await defineColor(await drive({ type: 'observe' }));
      assert.notEqual(darkColor, lightColor, 'Switching built-in themes changes the actual keyword color');
      await editorColors.update('tokenColorCustomizations', {
        textMateRules: [{ scope: 'keyword.control.racket', settings: { foreground: '#e14f22', fontStyle: 'italic' } }]
      }, vscode.ConfigurationTarget.Workspace);
      await until(async () => (await drive({ type: 'observe' })).tokens.some(t => t.text.trim() === 'define' && t.color === 'rgb(225, 79, 34)'), 'Token customization reaches the page');
      await defineColor(await drive({ type: 'observe' }));
      await editorColors.update('tokenColorCustomizations', previousTokens, vscode.ConfigurationTarget.Workspace);
      let longView = await drive({ type: 'observe' });
      assert.equal(longView.wordWrap, 'off'); assert.equal(longView.readOnly, true);
      assert.equal(longView.minimapEnabled, bracketSettings.get('minimap.enabled', true));
      assert.equal((await drive({ type: 'find' })).findVisible, true, 'Monaco owns Find');
      await drive({ type: 'closeFind' });
      assert.ok(longView.scrollWidth > longView.contentWidth, 'Long lines extend the editor scroll width');
      longView = await drive({ type: 'scrollRight' });
      assert.ok(longView.scrollLeft > 0, 'The end of a long line is reachable with horizontal scrolling');
      await drive({ type: 'revealStart' });
      await drive({ type: 'key', key: 'F10' }); await observed(s => s.position === 2);
      await drive({ type: 'key', key: 'ArrowLeft', altKey: true }); await observed(s => s.position === 1);
      await drive({ type: 'key', key: 'ArrowRight', altKey: true }); await observed(s => s.position === 2);
      s = await go('first', 1);
      const focusSection = side === 'before' ? s.projection.record.before : s.projection.record.after;
      const focusLine = focusSection.text.slice(0, focusSection.focus[0][0]).split('\n').length;
      const focusView = await drive({ type: 'observe' });
      // No reveal helper: use Monaco's own scrolling, as a mouse wheel does,
      // leaving its cursor at the top while the expansion focus is visible.
      const height = focusView.lineHeight;
      const scrolled = await drive({ type: 'scrollEditor', top: Math.max(1, (focusLine - 5) * height), left: 0 });
      assert.ok(scrolled.scrollTop > 0);
      assert.equal(scrolled.cursor.lineNumber, 1, 'Wheel scrolling leaves the cursor at the top');
      assert.ok(scrolled.visibleRanges.some(r => r.startLineNumber <= focusLine && r.endLineNumber >= focusLine));
      const otherSide = side === 'before' ? 'after' : 'before';
      await focusSide(otherSide); const otherScroll = await drive({ type: 'observe' }); await focusSide(side);
      await command('next'); s = await observed(s => s.position === 2);
      // Wait several animation frames: a deferred cursor reveal used to undo
      // an immediately restored scroll offset after the title command.
      const stepped = await drive({ type: 'settle' });
      incrementalStep(stepped, side);
      assert.equal(stepped.scrollTop, scrolled.scrollTop, `${side} retains wheel scrolling when its focus remains visible`);
      horizontalStep(scrolled, stepped, `${side} reveals only an offscreen focus start`);
      await focusSide(otherSide); const otherStepped = await drive({ type: 'settle' });
      incrementalStep(otherStepped, otherSide);
      assert.equal(otherStepped.scrollTop, otherScroll.scrollTop, 'The other pane retains its own viewport');
      horizontalStep(otherScroll, otherStepped, `${otherSide} keeps its independent horizontal viewport`);
      await focusSide(side); s = await go('first', 1);
      // Place the next focus start inside the pane before repeating the title
      // command. Its end may extend beyond the viewport without causing a scroll.
      const nextStart = stepped.focusViewport.focusStart.left;
      const visibleScroll = await drive({ type: 'scrollEditor', top: scrolled.scrollTop,
        left: Math.max(0, Math.floor(nextStart - Math.min(16, stepped.contentWidth / 2))) });
      await command('next'); await observed(s => s.position === 2);
      const visibleStepped = await drive({ type: 'settle' });
      assert.equal(horizontalStep(visibleScroll, visibleStepped, `${side} keeps a visible focus start in place`), true);
      assert.equal(visibleStepped.scrollLeft, visibleScroll.scrollLeft);
      assert.equal(visibleStepped.scrollTop, visibleScroll.scrollTop);
      s = await go('first', 1);
    }
    await focusSide('after'); s = await observed();
    const afterStart = await drive({ type: 'revealAfterStart' });
    const afterLine = afterStart.sectionLines.find(l => l.sectionId === s.projection.record.after.id);
    assert.equal(afterLine.number, '1'); assert.equal(afterLine.renderedNumber, '1');
    // The After focus is near the bottom of its program.
    const introduced = appearances(s.projection).find(a => a.section === s.projection.record.after &&
      a.occurrence.macroScopeGroup > 0 && s.projection.terms[a.occurrence.syntaxId].name === 'list');
    assert.ok(introduced, 'The imported macro introduces a form');
    const coloured = await drive({ type: 'hover', target: introduced.target });
    const introducedToken = coloured.introduced.find(t => t.sectionId === introduced.section.id && t.occurrenceId === introduced.occurrence.id);
    assert.ok(introducedToken?.color, 'An introduced form has a rendered token');
    assert.equal(require('../vscode/macro-view/monaco').color(introducedToken.color), introducedToken.chartColor, 'The introduced form uses its live chart colour');
    const introducedForm = s.projection.record.after.occurrences.find(o => o.id === introduced.occurrence.parentId);
    const introducedBracket = coloured.brackets.find(b => b.sectionId === introduced.section.id && b.start === introducedForm.range[0]);
    assert.ok(introducedBracket, 'The introduced form retains Monaco bracket colouring');
    assert.match(introducedBracket.className, /bracket-highlighting-\d+/);
    const before = s.projection.record.before.text, after = s.projection.record.after.text;
    assert.match(before, /^\(module /); assert.match(before, /\(define pair \(twice 1\)\)/);
    assert.equal(after, before.replace('(define result (answer))', '(define result (list (helper)))'));
    assert.equal(fs.existsSync(marker), true); const expansions = fs.readFileSync(marker, 'utf8');
    assert.equal(fs.existsSync(runtime), false); assert.equal(fs.readFileSync(source, 'utf8'), onDisk); assert.equal(document.isDirty, true);
    s = await go('next', 2); assert.equal(s.projection.record.macro, 'helper'); assert.equal(s.rendered.mounted, true);
    // Imported coordinates without a worker fingerprint remain inspectable;
    // automatic following must not claim those coordinates are verified.
    assert.ok(tabs().some(t => t.isActive));
    s = await go('next', 3); assert.equal(s.projection.record.macro, 'twice');
    await go('next', 4); await go('next', 4); await go('previous', 3);
    await go('first', 1); await go('previous', 1); await go('last', 'end');
    await command('jump', 2); await observed(s => s.position === 2);
    await command('jump', 'end'); s = await observed(s => s.position === s.count);
    await command('jump', '1.5'); assert.equal((await observed()).position, s.count);
    assert.equal(fs.readFileSync(marker, 'utf8'), expansions, 'Navigation never executes transformers again');

    for (const side of ['before', 'after']) {
      currentSide = side; s = await focusSide(side);
      const final = appearances(s.projection).find(a => s.rendered.sections.includes(a.section.id) &&
        /^[a-zA-Z][a-zA-Z0-9]+$/.test(a.section.text.slice(...a.occurrence.range)) &&
        a.section.edges.some(e => e.binder === a.occurrence.id));
      assert.ok(final, 'Completion retains binding edges');
      await drive({ type: 'select', target: final.target });
      await observed(s => s.selection?.occurrenceId === final.target.occurrenceId);
      {
        dom = await drive({ type: 'observe' });
        assert.equal(dom.selectedText, '', 'A single click places a cursor without selecting the term text');
        assert.equal(dom.selection.startColumn, dom.selection.endColumn);
        assert.equal(dom.identityCount, 0, 'The current term has no selection boxes');
        assert.equal(dom.occurrencesHighlight, 'off'); assert.equal(dom.selectionHighlight, false);
        const combined = Editor.compose(Model.sections(s.projection));
        const part = combined.parts.find(p => p.section.id === final.section.id);
        const modelText = combined.text;
        const positionAt = offset => {
          const prefix = modelText.slice(0, offset).split('\n');
          return { lineNumber: prefix.length, column: prefix.at(-1).length + 1 };
        };
        const start = positionAt(part.offset(final.occurrence.range[0]));
        const end = positionAt(part.offset(final.occurrence.range[1] + 1));
        const textRange = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
        const selectedText = modelText.slice(part.offset(final.occurrence.range[0]), part.offset(final.occurrence.range[1] + 1));
        dom = await drive({ type: 'drag', target: final.target, endOffset: final.occurrence.range[1] + 1 });
        assert.equal(dom.selectedText, selectedText, 'Dragging selects exact editor text beyond the current term');
        assert.deepEqual(dom.selected, final.target, 'A drag keeps the term at the selection start');
        await command('copyTerm'); assert.equal(await vscode.env.clipboard.readText(), selectedText);
        dom = await drive({ type: 'doubleClick', target: final.target });
        assert.equal(dom.selectedText, final.section.text.slice(...final.occurrence.range), 'Double-click selects a word using Monaco');
        dom = await drive({ type: 'textSelection', selection: textRange, backwards: true });
        assert.equal(dom.selectedText, selectedText);
        assert.equal(dom.selection.positionColumn, start.column, 'The active cursor is at the start of the backwards selection');
        assert.deepEqual(dom.selected, final.target, 'Backwards selection uses its normalized start');
        await command('copyTerm'); assert.equal(await vscode.env.clipboard.readText(), selectedText);
        await drive({ type: 'cursor', position: start });
        dom = await drive({ type: 'editorAction', action: 'cursorRightSelect' });
        assert.equal(dom.selectedText, final.section.text[final.occurrence.range[0]], 'Keyboard selection is owned by Monaco');
        assert.deepEqual(dom.selected, final.target);
        await command('copyTerm'); assert.equal(await vscode.env.clipboard.readText(), dom.selectedText);
        // Custom colors expose the actual editor selection and occurrence styles.
        await workbench.update('colorCustomizations', { ...previousColors,
          'editor.selectionBackground': '#22668880', 'editor.wordHighlightBackground': '#12345670',
          'editor.wordHighlightStrongBackground': '#65432170', 'editor.wordHighlightBorder': '#112233',
          'editor.wordHighlightStrongBorder': '#332211'
        }, vscode.ConfigurationTarget.Workspace);
        for (const theme of ['Default Dark Modern', 'Default High Contrast', 'Default High Contrast Light']) {
          await workbench.update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
          await until(async () => (await drive({ type: 'observe' })).themeName === theme, 'Occurrence theme reaches Monaco');
          dom = await drive({ type: 'settle' });
          assert.ok(dom.selectionStyles.includes(dom.highlightColors.selectionBackground), 'Native text selection uses the editor theme color');
          assert.ok(dom.occurrenceStyles.some(h => h.className.includes('macro-word-highlight-strong')), 'The visible binder has a strong occurrence highlight');
          for (const highlight of dom.occurrenceStyles) {
            const strong = highlight.className.includes('macro-word-highlight-strong');
            const key = strong ? 'wordHighlightStrong' : 'wordHighlight';
            assert.equal(highlight.background, dom.highlightColors[key + 'Background']);
            assert.equal(highlight.outlineStyle, 'none', 'Occurrences never have term outlines');
            if (theme.includes('High Contrast')) {
              assert.equal(highlight.borderStyle, 'solid');
              assert.equal(highlight.borderColor, dom.highlightColors[key + 'Border']);
            } else assert.equal(highlight.borderStyle, 'none', 'Ordinary themes have no occurrence borders');
          }
          assert.equal(dom.identityCount, 0);
        }
        await workbench.update('colorCustomizations', previousColors, vscode.ConfigurationTarget.Workspace);
        await workbench.update('colorTheme', 'Default Light+', vscode.ConfigurationTarget.Workspace);
        await drive({ type: 'cursor', position: start });
        dom = await drive({ type: 'observe' });
        assert.equal(dom.selectedText, '');
        await command('copyTerm'); assert.equal(await vscode.env.clipboard.readText(), final.section.text.slice(...final.occurrence.range));
      }
      await command('properties'); s = await observed(s => s.propertiesVisible);
      dom = await drive({ type: 'settle' });
      assert.ok(dom.editorLayoutWidth >= 320 || dom.propertiesBelow, 'Properties preserve editor width or sit below it');
      await command('properties'); await observed(s => !s.propertiesVisible);
      await command('properties'); s = await observed(s => s.propertiesVisible && !!s.properties);
      dom = await drive({ type: 'observe' });
      assert.equal(dom.propertiesVisible, true); assert.match(dom.inspector, /Apparent identifier binding|Scopes/);
      assert.ok(dom.editorLayoutWidth >= 320 || dom.propertiesBelow, 'Properties preserve editor width or sit below it');
      await drive({ type: 'hover', target: final.target }); dom = await drive({ type: 'observe' });
      const outgoing = final.section.edges.filter(e => e.binder === final.occurrence.id);
      const line = o => final.section.text.slice(0, o.range[0]).split('\n').length;
      const name = o => `\`${final.section.text.slice(...o.range)}\``;
      const qualify = (sentence, occurrence, edges) => {
        const phase = edges[0]?.phase ?? occurrence.phase ?? s.projection.relationPhase ?? 0;
        if (phase === 1) sentence += ' at compile time';
        else if (phase === 'label') sentence += ' for documentation only';
        else if (phase !== 0 && phase !== null) sentence += ` at phase ${phase}`;
        if (occurrence.macroScopeGroup > 0 && s.projection.record?.macro) sentence += `, introduced by \`${s.projection.record.macro}\``;
        return sentence + '.';
      };
      const useLines = [...new Set(outgoing.map(e => line(final.section.occurrences.find(o => o.id === e.reference))))].sort((a, b) => a - b);
      const lineList = useLines.length === 1 ? useLines[0] : `${useLines.slice(0, -1).join(', ')} and ${useLines.at(-1)}`;
      assert.equal(dom.bindingSentence, qualify(`${name(final.occurrence)} on line ${line(final.occurrence)} is used on ${useLines.length === 1 ? 'line' : 'lines'} ${lineList}`, final.occurrence, outgoing), 'Hovered binder describes its uses using pane line numbers');
      assert.equal(dom.bindingAnnouncement, dom.bindingSentence);
      assert.doesNotMatch(dom.bindingSentence, /certain|possible|definite/i);
      const use = final.section.occurrences.find(o => o.id === outgoing[0].reference);
      const hoveredUse = await drive({ type: 'hover', target: { sectionId: final.section.id, occurrenceId: use.id } });
      assert.equal(hoveredUse.bindingSentence, qualify(`${name(use)} on line ${line(use)} refers to ${name(final.occurrence)} on line ${line(final.occurrence)}`, use, [outgoing[0]]), 'Hovered use describes its binder using pane line numbers');
      assert.equal(hoveredUse.bindingAnnouncement, hoveredUse.bindingSentence);
      assert.doesNotMatch(hoveredUse.bindingSentence, /certain|possible|definite/i);
      // Racket labels possible arrows "?" and definite ones away from phase 0 "phase N".
      const arrowLabel = e => e.certainty === 'possible' ? '?' : e.phase !== 0 && e.phase !== null ? `phase ${e.phase}` : null;
      const labelsAt = id => final.section.edges.filter(e => e.binder === id || e.reference === id).map(arrowLabel).filter(Boolean).sort();
      assert.deepEqual([...hoveredUse.arrowText].sort(), labelsAt(use.id));
      const useTarget = { sectionId: final.section.id, occurrenceId: use.id };
      await drive({ type: 'select', target: useTarget });
      await observed(s => s.selection?.occurrenceId === use.id);
      dom = await drive({ type: 'observe' });
      const expectedOccurrences = new Set([final.occurrence.id, ...outgoing.map(e => e.reference)]);
      assert.equal(dom.relatedCount, expectedOccurrences.size, 'A use highlights its binder and sibling uses through binding edges');
      assert.equal(dom.occurrenceHighlights.filter(h => h.className === 'macro-word-highlight-strong').length, 1);
      assert.equal(dom.occurrenceHighlights.filter(h => h.className === 'macro-word-highlight').length, expectedOccurrences.size - 1);
      await command('definition');
      await observed(s => s.selection?.occurrenceId === final.occurrence.id);
      dom = await drive({ type: 'observe' });
      assert.deepEqual(dom.selected, final.target, 'Go to Binder moves the editor cursor and current term');
      assert.equal(dom.selectedText, '', 'Go to Binder places a cursor');
      await drive({ type: 'hover', target: final.target }); dom = await drive({ type: 'observe' });
      assert.deepEqual([...dom.arrowText].sort(), labelsAt(final.occurrence.id));
      assert.ok(dom.arrows.length > 0, 'Monaco positions produce SVG paths'); assert.ok(dom.arrows.every(a => /^M /.test(a.path)));
      const connected = new Set(final.section.edges.filter(e => [e.binder, e.reference].includes(final.occurrence.id)).flatMap(e => [e.binder, e.reference]));
      assert.deepEqual(new Set(dom.boxes.filter(b => b.sectionId === final.section.id).map(b => b.occurrenceId)), connected);
      assert.ok(dom.boxes.every(b => b.right > b.left && b.bottom > b.top));
      assert.equal(dom.hoverDecorationCount, connected.size, 'Connected identifiers have Monaco box decorations');
      for (const arrow of dom.arrows) {
        const onEdge = (p, b) => {
          const epsilon = .01;
          return p.x >= b.left - epsilon && p.x <= b.right + epsilon && p.y >= b.top - epsilon && p.y <= b.bottom + epsilon &&
            Math.min(Math.abs(p.x - b.left), Math.abs(p.x - b.right), Math.abs(p.y - b.top), Math.abs(p.y - b.bottom)) < epsilon;
        };
        assert.ok(dom.boxes.some(b => b.sectionId === arrow.sectionId && b.occurrenceId === arrow.binder && onEdge(arrow.start, b)), 'Arrow starts on its source box edge');
        assert.ok(dom.boxes.some(b => b.sectionId === arrow.sectionId && b.occurrenceId === arrow.reference && onEdge(arrow.end, b)), 'Arrow ends on its target box edge');
      }
      await drive({ type: 'unhover' }); dom = await drive({ type: 'observe' }); assert.equal(dom.boxes.length, 0);
      await drive({ type: 'hover', target: final.target }); await command('tack');
      await observed(s => s.pins.length === 1);
      await drive({ type: 'unhover' }); dom = await drive({ type: 'observe' }); assert.ok(dom.boxes.length >= connected.size, 'Tacked boxes survive the end of hover');
      await command('untackAll'); await observed(s => s.pins.length === 0);
      dom = await drive({ type: 'observe' }); assert.equal(dom.boxes.length, 0);
      await command('tack');
      await drive({ type: 'select', target: { sectionId: final.section.id, occurrenceId: use.id } });
      await command('tack'); await observed(s => s.pins.length === 2);
      await command('untackAll'); await observed(s => s.pins.length === 0);
      await drive({ type: 'select', target: final.target });
      await command('copyTerm'); assert.equal(await vscode.env.clipboard.readText(), final.section.text.slice(...final.occurrence.range));
      const withSource = sourceAppearance(s.projection, s.rendered.sections, source);
      assert.ok(withSource); dom = await drive({ type: 'select', target: withSource.target });
      assert.deepEqual(dom.selected, withSource.target, 'The click selects the source term in its pane');
      s = await observed(s => s.selection?.sectionId === withSource.target.sectionId && s.selection?.occurrenceId === withSource.target.occurrenceId && !!s.properties);
      dom = await drive({ type: 'observe' });
      const location = s.properties.source;
      const [start, end] = Model.sourceOffsets(document.getText(), location.line, location.column, location.span);
      const point = offset => { const p = document.positionAt(offset); return `Ln ${p.line + 1}, Col ${p.character + 1}`; };
      assert.equal(dom.sourceLocation, `${source}, ${point(start)} to ${point(end)}`);
      assert.doesNotMatch(dom.inspector, /(?:position|span|column|line):|printed offsets/);
      await drive({ type: 'sourceLink' }); await until(() => vscode.window.activeTextEditor?.document === document, 'Go to source focuses the buffer');
      await focusPanel();
      assert.equal((await drive({ type: 'observe' })).morePhasesLink, 'more phases');
      const expectedPhases = [0, 1, -1];
      await drive({ type: 'morePhases' });
      await observed(s => expectedPhases.every(phase => s.properties?.inspectedPhases.includes(phase)));
      dom = await drive({ type: 'observe' }); assert.match(dom.inspector, /Scopes at phase 1:/);
      await drive({ type: 'key', key: 'Escape' });
      dom = await drive({ type: 'observe' });
      assert.deepEqual(dom.selected, withSource.target, 'Escape preserves the term at the cursor');
      assert.equal(dom.identityCount, 0);
      await drive({ type: 'clickElsewhere' });
      assert.deepEqual((await drive({ type: 'observe' })).selected, withSource.target, 'Focus elsewhere preserves the editor current term');

    }
    await command('showAll'); s = await observed(s => s.hiding === 'none' && s.position === 1); assert.ok(s.count > 4);
    assert.equal(s.workerSession, workerSession, 'Hiding re-expands in the retained session');
    await command('showMine'); s = await observed(s => s.hiding === 'standard' && s.position === 1); assert.equal(s.count, 4);
    assert.equal(s.workerSession, workerSession); assert.deepEqual(s.loadedPositions, [1]);
    const waitPicker = title => until(async () => {
      const handle = await command('_hidingPicker');
      return handle?.picker.title === title && handle;
    }, title);
    const acceptPicker = (handle, selected, active = selected[0]) => {
      handle.picker.selectedItems = selected;
      handle.picker.activeItems = active ? [active] : [];
      handle.accept();
    };
    // One keyboard smoke test: filter to a unique mode, then press Enter.
    // Avoid relative navigation and checkbox toggles, which depend on focus.
    const keyboardHiding = command('hiding');
    const keyboardMode = await waitPicker('Macro Hiding');
    keyboardMode.picker.value = 'Disable';
    await until(() => keyboardMode.picker.activeItems[0]?.value === 'disable', 'Disable has keyboard focus');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await keyboardHiding;
    s = await observed(s => s.hiding === 'none');
    await command('showMine');
    await observed(s => s.hiding === 'standard' && s.count === 4);
    const openingCustom = command('hiding');
    const modePick = await waitPicker('Macro Hiding');
    assert.equal(modePick.picker.items.find(item => item.description === 'Current').label, 'Standard');
    acceptPicker(modePick, [modePick.picker.items.find(item => item.value === 'custom')]);
    const customPick = await waitPicker('Custom Macro Hiding');
    assert.equal(customPick.picker.selectedItems.length, 5);
    const contracts = customPick.picker.items.find(item => item.key === 'contracts');
    acceptPicker(customPick, customPick.picker.items.filter(item => item !== contracts), contracts);
    await openingCustom;
    s = await observed(s => s.hiding === 'custom' && s.custom.contracts === false && s.count === 4);
    assert.ok(s.pair.every(pane => pane.title.endsWith(' (Custom)')));
    s = await focusSide('before');
    const macroName = appearances(s.projection).findLast(a => s.projection.terms[a.occurrence.syntaxId].name === 'twice');
    assert.ok(macroName);
    await drive({ type: 'select', target: macroName.target });
    await observed(s => s.selection?.occurrenceId === macroName.target.occurrenceId);
    await command('hideMacro');
    s = await observed(s => s.custom.rules.length === 1 && s.count === 3);
    assert.equal(s.custom.rules[0].label, "hide 'twice' defined in this module");
    const deletingRule = command('hidingRules');
    const rulesPick = await waitPicker('Macro Hiding Rules');
    assert.equal(rulesPick.picker.items[0].label, "hide 'twice' defined in this module");
    acceptPicker(rulesPick, [rulesPick.picker.items[0]]);
    await deletingRule;
    s = await observed(s => s.custom.rules.length === 0 && s.count === 4);
    await command('showMine');
    s = await observed(s => s.hiding === 'standard' && s.count === 4);
    const atLine = async line => {
      await vscode.window.showTextDocument(document, { viewColumn: sourceColumn, selection: new vscode.Range(line, 2, line, 2) });
      await vscode.commands.executeCommand('racketdap.stepMacros'); return observed();
    };
    s = await atLine(85); assert.equal(s.projection.record.macro, 'twice'); assert.equal(s.position, 3); assert.equal(tabs().length, 2);
    s = await atLine(86); assert.equal(s.hiding, 'line'); assert.equal(s.projection.record.macro, 'or');
    await command('showMine'); s = await observed(s => s.hiding === 'standard' && s.position === 1);
    s = await atLine(87);
    assert.equal(s.position, 1); assert.equal(s.hiding, 'standard');
    for (const side of ['before', 'after']) {
      await focusSide(side); assert.equal((await drive({ type: 'observe' })).note, '');
    }
    await go('next', 2); await go('first', 1);

    await replace(document, '; inserted\n' + text);
    s = await observed(s => s.stale);
    for (const side of ['before', 'after']) {
      await focusSide(side); dom = await drive({ type: 'observe' });
      assert.match(dom.banner, /out of date.*Refresh/); assert.equal(dom.note, '');
    }
    await go('next', 2); await replace(document, text); await observed(s => !s.stale);
    await replace(document, text + '; new buffer\n'); await observed(s => s.stale);
    await command('refresh'); s = await observed(s => !s.stale); assert.equal(s.position, 1);
    assert.equal(document.isDirty, true); assert.equal(fs.readFileSync(source, 'utf8'), onDisk); assert.equal(fs.existsSync(runtime), false);

    await vscode.window.tabGroups.close(tabs().find(t => t.label.startsWith('Before - ')));
    await until(() => tabs().length === 0, 'Closing Before closes After');
    const plain = await vscode.workspace.openTextDocument({ language: 'racket', content: '42\n(or #f 2)\n' }); buffers.push(plain);
    await vscode.window.showTextDocument(plain, { viewColumn: sourceColumn, selection: new vscode.Range(0, 0, 0, 0) });
    await vscode.commands.executeCommand('racketdap.stepMacros'); s = await observed(s => s.count === 1);
    assert.ok(s.projection.final); assert.equal(tabs().length, 2, 'The previous view was closed before opening another source');
    await vscode.window.showTextDocument(plain, { viewColumn: sourceColumn, selection: new vscode.Range(1, 0, 1, 0) });
    await vscode.commands.executeCommand('racketdap.stepMacros'); s = await observed(s => s.hiding === 'line');
    assert.equal(s.projection.record.macro, 'or'); assert.equal(tabs().length, 2);

    await closePanels();
    const hygiene = await vscode.workspace.openTextDocument({ language: 'racket', content: '#lang racket/base\n(define-syntax-rule (swap! a b) (let ([tmp a]) (set! a b) (set! b tmp)))\n(define (f) (let ([tmp 1] [other 2]) (swap! tmp other) (list tmp other)))\n' }); buffers.push(hygiene);
    await vscode.window.showTextDocument(hygiene, { viewColumn: sourceColumn }); await vscode.commands.executeCommand('racketdap.stepMacrosInFile');
    s = await observed(s => s.projection.record?.macro === 'swap!');
    s = await focusSide('after');
    const temps = appearances(s.projection).filter(a => a.section === s.projection.record.after && s.projection.terms[a.occurrence.syntaxId].name === 'tmp');
    assert.ok(new Set(temps.map(a => s.projection.terms[a.occurrence.syntaxId].relations.bound)).size >= 2, 'Identically printed identifiers retain different lexical contexts');
    const connectedTemp = temps.find(a => a.section.edges.some(e => e.reference === a.occurrence.id));
    assert.ok(connectedTemp);
    await drive({ type: 'select', target: connectedTemp.target }); s = await observed(s => !!s.selection);
    dom = await drive({ type: 'observe' }); assert.ok(dom.relatedCount > 0); assert.equal(dom.identityCount, 0);
    assert.equal(dom.relatedCount, Model.bindingOccurrences(s.projection, s.selection).length, 'Only identifiers connected by binding edges have occurrence highlights');

    await closePanels();
    const broken = await vscode.workspace.openTextDocument({ language: 'racket', content: "#lang racket/base\n(require (for-syntax racket/base))\n(define-syntax (bad stx) (raise-syntax-error #f \"failure context\" stx))\n(define-syntax (middle stx) (local-expand #'(bad) 'expression null))\n(define-syntax (outer stx) (local-expand #'(middle) 'expression null))\n(outer)\n" }); buffers.push(broken);
    await vscode.window.showTextDocument(broken, { viewColumn: sourceColumn }); await vscode.commands.executeCommand('racketdap.stepMacrosInFile');
    await focusSide('after'); await command('last'); s = await observed(s => !!s.projection.error); assert.match(s.projection.diagnostics[s.projection.error].message, /failure context/);
    await go('last', 'end'); s = await observed(s => !!s.projection.error); assert.equal(s.projection.final, null);
    const diagnostic = s.projection.diagnostics[s.projection.error];
    assert.equal((await drive({ type: 'observe' })).note, diagnostic.message);
    assert.ok(diagnostic.syntax.length > 0); assert.ok(diagnostic.contexts.length >= 3);
    const context = diagnostic.contexts.at(-1).section, occurrence = context.occurrences[0];
    await drive({ type: 'select', target: { sectionId: context.id, occurrenceId: occurrence.id } });
    await observed(s => s.selection?.sectionId === context.id && !!s.properties);
    dom = await drive({ type: 'observe' }); assert.match(dom.inspector, /Source location|Scopes/);
    await vscode.window.tabGroups.close(tabs().find(t => t.label.startsWith('After - ')));
    await until(() => tabs().length === 0, 'Closing After closes Before');
    await until(async () => await command('_workerCount') === 0, 'All tracked macro workers have ended');
    assert.equal(await command('_workerCount'), 0);
    return ['Macro view expands dirty buffers and relative imports without saving or running the module body',
      'Macro view opens beside source, reuses exact source panels and reports mounted focus',
      'Macro view commands navigate rewrites and completion, validate jumps and choose hiding',
      'Macro view selects final syntax, draws measured arrows, inspects phases and copies terms',
      'Macro view source actions and stale/undo/Refresh preserve source edits',
      'Macro view handles fragment fallback, zero rewrites, separate sources and expansion errors'];
  } finally {
    await closePanels();
    await editorColors.update('tokenColorCustomizations', previousTokens, vscode.ConfigurationTarget.Workspace);
    await workbench.update('colorCustomizations', previousColors, vscode.ConfigurationTarget.Workspace);
    await workbench.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Workspace);
    await bracketSettings.update('bracketPairColorization.enabled', previousBrackets, vscode.ConfigurationTarget.Workspace, true);
    await bracketSettings.update('bracketPairColorization.independentColorPoolPerBracketType', previousPools, vscode.ConfigurationTarget.Workspace, true);
    for (const buffer of buffers) if (!buffer.isClosed) {
      await vscode.window.showTextDocument(buffer, { viewColumn: sourceColumn || vscode.ViewColumn.One });
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await config.update('languageServer.enabled', previous, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('racketdap.restartLanguageServer'); await extension.exports.languageServerReady();
  }
};
