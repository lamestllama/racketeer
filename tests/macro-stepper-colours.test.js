// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper colours behavior.
'use strict';
const { root, racket, helper, load, tick, plain } = require('./support/macro-common');
const test = require('./support/node-test');
const TokenColors = require('../vscode/macro-token-colors');
const { themeAPI } = require('./support/macro-theme');
const assert = require('node:assert/strict');
const wasmPath = require.resolve('../vscode/node_modules/vscode-oniguruma/release/onig.wasm');
const Model = require('../vscode/macro-view/model');
const Editor = require('../vscode/macro-view/monaco');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const Data = require('../vscode/macro-view-data');
const { decodeTerm } = require('../vscode/macro-stepper-codec');
const { fakeModel, pair } = require('./support/macro-fixtures');
const { request, owned } = require('./support/macro-worker');
const { fakeMacroConnections } = require('./support/macro-page');
const { onBoxBoundary } = require('./support/macro-geometry');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { pageScripts } = require('./support/macro-page-startup');

test('theme scope styles follow includes, parent specificity, customizations and fontStyle', async t => {
  const files = {
    '/themes/base.json': JSON.stringify({ colors: { 'editor.foreground': '#abb' }, tokenColors: [
      { scope: 'keyword', settings: { foreground: '#112233', fontStyle: 'italic' } },
      { scope: 'keyword.control', settings: { foreground: '#223344' } },
      { scope: 'source.racket meta.definition.racket keyword.control.racket', settings: { foreground: '#334455', fontStyle: 'bold' } },
      { scope: 'source.racket keyword.control.racket', settings: { foreground: '#445566' } },
      { scope: ['string', 'constant.numeric'], settings: { foreground: '#556677', fontStyle: 'italic strikethrough' } }
    ] }),
    '/themes/child.json': '{ // child theme\n "include": "base.json", "tokenColors": [{"scope":"keyword", "settings":{"foreground":"#667788"}}], }'
  };
  const custom = {
    strings: '#778899', numbers: { foreground: '#8899aa', fontStyle: '' },
    textMateRules: [{ scope: 'source.racket meta.definition.racket keyword.control.racket', settings: { foreground: '#990011', fontStyle: 'underline' } }],
    '[Sample]': { textMateRules: [{ scope: 'source.racket meta.definition.racket keyword.control.racket', settings: { foreground: '#aa1122', fontStyle: 'bold underline' } }] },
    '[Other]': { keywords: '#ff0000' }
  };
  const theme = await TokenColors.resolveTheme(themeAPI(files, custom));
  assert.equal(theme.foreground, '#AABBBB');
  const grammar = { scopeName: 'source.racket', patterns: [
    { match: 'a', name: 'meta.definition.racket keyword.control.racket' },
    { match: 'b', name: 'keyword.control.racket' }, { match: 'c', name: 'keyword.other.racket' },
    { match: 'd', name: 'string.quoted.racket' }, { match: 'e', name: 'constant.numeric.racket' }
  ] };
  const tokenizer = await TokenColors.createTokenizer(theme, { wasmPath, grammar }); t.after(() => tokenizer.dispose());
  const spans = tokenizer.tokenize('abcde?');
  const styles = spans.map(s => tokenizer.styles[s.style]);
  assert.deepEqual(styles, [
    { foreground: '#AA1122', fontStyle: 6 }, { foreground: '#445566', fontStyle: 1 },
    { foreground: '#667788', fontStyle: 1 }, { foreground: '#778899', fontStyle: 9 },
    { foreground: '#8899AA', fontStyle: 0 }, { foreground: '#AABBBB', fontStyle: 0 }
  ]);
  // A less specific customization cannot replace a specific theme rule.
  custom['[Sample]'].keywords = '#abcdef';
  const next = await TokenColors.createTokenizer(await TokenColors.resolveTheme(themeAPI(files, custom)), { wasmPath, grammar }); t.after(() => next.dispose());
  assert.equal(next.styles[next.tokenize('b')[0].style].foreground, '#445566');
});

test('theme plist token files, include cycles and unresolved themes use the editor foreground fallback', async t => {
  const files = {
    '/themes/child.json': '{"tokenColors":"base.tmTheme"}',
    '/themes/base.tmTheme': '<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array>' +
      '<dict><key>settings</key><dict><key>foreground</key><string>#123456</string></dict></dict>' +
      '<dict><key>scope</key><string>keyword.control.racket</string><key>settings</key><dict><key>foreground</key><string>#abcdef</string><key>fontStyle</key><string>italic</string></dict></dict>' +
      '</array></dict></plist>'
  };
  const theme = await TokenColors.resolveTheme(themeAPI(files));
  assert.equal(theme.foreground, '#123456');
  assert.equal(theme.settings[1].settings.foreground, '#ABCDEF');
  const tokenizer = await TokenColors.createTokenizer(theme, { wasmPath }); t.after(() => tokenizer.dispose());
  assert.deepEqual(tokenizer.styles[tokenizer.tokenize('(define x 1)')[1].style], { foreground: '#ABCDEF', fontStyle: 1 });
  files['/themes/child.json'] = '{"include":"child.json"}';
  for (const api of [themeAPI(files), themeAPI(files, {}, 'Missing')]) {
    const fallback = await TokenColors.resolveTheme(api);
    assert.deepEqual(fallback.settings, []);
    const plain = await TokenColors.createTokenizer(fallback, { wasmPath }); t.after(() => plain.dispose());
    assert.ok(plain.tokenize('(define x 1)').every(s => plain.styles[s.style].foreground === null));
  }
  files['/themes/child.json'] = '{"tokenColors":[{"scope":"keyword.control.racket","settings":{"foreground":"#000000"}}]}';
  const inherited = await TokenColors.createTokenizer(await TokenColors.resolveTheme(themeAPI(files)), { wasmPath });
  t.after(() => inherited.dispose());
  const tokens = inherited.tokenize('(define x 1)');
  assert.equal(inherited.styles[tokens[0].style].foreground, null, 'Unspecified defaults inherit the live editor foreground');
  assert.equal(inherited.styles[tokens[1].style].foreground, '#000000', 'Explicit black is distinct from an inherited default');
});

test('real Racket grammar tokenizes define, strings, numbers, comments and brackets with continuous line state', async t => {
  const theme = { foreground: '#101010', settings: [{ settings: { foreground: '#101010' } },
    ...['keyword.control', 'string', 'constant.numeric', 'comment', 'punctuation.section.parens'].map((scope, i) => ({ scope, settings: { foreground: `#${i + 2}02020` } }))] };
  const tokenizer = await TokenColors.createTokenizer(theme, { wasmPath }); t.after(() => tokenizer.dispose());
  const text = '(define [x "hello"] 42) ; comment\n#| block\ncontinued |# (define y 2)';
  const spans = tokenizer.tokenize(text, true);
  const at = needle => spans.find(s => s.start <= text.indexOf(needle) && s.end > text.indexOf(needle));
  for (const [needle, scope, foreground] of [
    ['define', 'keyword.control.racket', '#202020'], ['hello', 'string.quoted.double.racket', '#302020'],
    ['42', 'constant.numeric.racket', '#402020'], ['comment', 'comment.line.semicolon.racket', '#502020'],
    ['[', 'punctuation.section.parens.racket', '#602020'], ['continued', 'comment.block.racket', '#502020']
  ]) {
    assert.ok(at(needle).scopes.includes(scope), needle);
    assert.equal(tokenizer.styles[at(needle).style].foreground, foreground, needle);
  }
  assert.ok(spans.every(s => Model.validRange(text, [s.start, s.end])));
  assert.equal(tokenizer.styles.length, 6, 'Styles are shared across tokens');
  const lines = Editor.tokenLines(text, spans);
  assert.ok(lines[0].some(t => t.scopes === `macro${at('define').style}`));
  assert.ok(lines[1].some(t => t.scopes.endsWith('.comment')));
});

test('Monaco theme maps resolved CSS colors and the complete token style table', () => {
  const variables = { '--vscode-editor-background': 'rgb(10, 20, 30)', '--vscode-editor-foreground': '#abc',
    '--vscode-editorLineNumber-foreground': '#123456', '--vscode-editor-selectionBackground': 'rgba(2, 4, 6, 0.5)',
    '--vscode-scrollbarSlider-background': '#1234', '--vscode-editorBracketHighlight-foreground1': '#ffd700',
    '--vscode-editorBracketHighlight-foreground4': 'transparent', '--vscode-editor-findMatchBackground': '#345678' };
  const ids = ['editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editor.selectionBackground',
    'scrollbarSlider.background', 'editorBracketHighlight.foreground1', 'editorBracketHighlight.foreground4', 'editor.findMatchBackground', 'absent'];
  const styles = [{ foreground: '#e14f22', fontStyle: 15 }, { foreground: null, fontStyle: 0 }];
  const theme = Editor.theme(variables, styles, ids, 'vscode-light');
  assert.equal(theme.base, 'vs'); assert.equal(theme.inherit, true);
  assert.deepEqual(theme.colors, { 'editor.background': '#0a141e', 'editor.foreground': '#aabbcc',
    'editorLineNumber.foreground': '#123456', 'editor.selectionBackground': '#02040680',
    'scrollbarSlider.background': '#11223344', 'editorBracketHighlight.foreground1': '#ffd700',
    'editorBracketHighlight.foreground4': '#00000000', 'editor.findMatchBackground': '#345678' });
  assert.deepEqual(theme.rules.slice(0, 2), [{ token: 'macro0', foreground: 'e14f22', fontStyle: 'italic bold underline strikethrough' },
    { token: 'macro1', foreground: 'aabbcc', fontStyle: '' }]);
  variables['--vscode-editor-foreground'] = '#112233';
  const next = Editor.theme({ getPropertyValue: n => variables[n] }, styles, ids, 'vscode-high-contrast');
  assert.equal(next.base, 'hc-black'); assert.equal(next.rules[1].foreground, '112233');
  assert.equal(Editor.theme(variables, [], ids, 'vscode-high-contrast-light').base, 'hc-light');
  assert.equal(Editor.color('url(remote)'), undefined);
});

test('server UTF-16 token spans become stateful Monaco line tokens, preserving string and comment types', () => {
  const text = '(😀)\n#| x\ny |# "(" #\\('; // State is supplied by the server across lines.
  const spans = [{ start: 0, end: 4, style: 0 }, { start: 5, end: 14, style: 1, scopes: ['comment.block.racket'] },
    { start: 15, end: 18, style: 2, scopes: ['string.quoted.racket'] },
    { start: 19, end: text.length, style: 3, scopes: ['constant.character.racket'] }];
  const lines = Editor.tokenLines(text, spans);
  assert.deepEqual(lines, [[{ startIndex: 0, scopes: 'macro0' }], [{ startIndex: 0, scopes: 'macro1.comment' }],
    [{ startIndex: 0, scopes: 'macro1.comment' }, { startIndex: 4, scopes: '' }, { startIndex: 5, scopes: 'macro2.string' }, { startIndex: 8, scopes: '' }, { startIndex: 9, scopes: 'macro3.string' }]]);
  assert.deepEqual(Editor.tokenLines(text, spans.map(({ scopes, ...span }) => ({ ...span, type: Editor.tokenType(scopes) }))), lines, 'Compact production types preserve bracket exclusions');
  const provider = Editor.provider(lines), initial = provider.getInitialState();
  assert.equal(initial.clone(), initial); assert.equal(initial.equals(provider.getInitialState()), true);
  let state = initial;
  for (const line of lines) { const result = provider.tokenize('', state); assert.deepEqual(result.tokens, line); assert.equal(state.equals(result.endState), false); state = result.endState; }
});

test('introduced syntax uses seventeen live theme colours, written children and bracket colours retain priority', () => {
  const section = { id: 'scope', text: '(unless [x 42] "(")', focus: [[0, 19]], binderOccurrences: [], edges: [], occurrences: [
    { id: 'form', syntaxId: 'form', parentId: null, range: [0, 19], delimiterRanges: [[0, 1], [18, 19]], macroScopeGroup: 1 },
    { id: 'head', syntaxId: 'head', parentId: 'form', range: [1, 7], delimiterRanges: [], macroScopeGroup: 1 },
    { id: 'written', syntaxId: 'written', parentId: 'form', range: [8, 14], delimiterRanges: [[8, 9], [13, 14]], macroScopeGroup: 0 },
    { id: 'literal', syntaxId: 'literal', parentId: 'written', range: [11, 13], delimiterRanges: [], macroScopeGroup: 2 }
  ] };
  const tokens = [{ start: 0, end: 15, style: 0 }, { start: 15, end: 18, style: 1, type: 'string' }];
  let lines;
  const { page } = fakeMacroConnections('before');
  Object.assign(page, { editorModel: fakeModel(section.text), partsBySection: new Map([['scope', { section, offset: n => n }]]),
    tokenSections: { scope: tokens }, tokenProvider: null });
  page.monaco.languages.setTokensProvider = (_language, provider) => {
    lines = provider.tokenize(section.text, provider.getInitialState()).tokens;
    return { dispose() {} };
  };
  page.applyColors({ tokenSections: page.tokenSections, tokenStyles: [], themeName: 'test' });
  const at = offset => lines.filter(t => t.startIndex <= offset).at(-1).scopes;
  assert.equal(at(0), 'macro0.scope0', 'The introduced opening delimiter has the form group');
  assert.equal(at(1), 'macro0.scope0'); assert.equal(at(7), 'macro0.scope0', 'Enclosing whitespace has the form group');
  assert.equal(at(8), 'macro0', 'Group 0 keeps the normal token colour inside an introduced form');
  assert.equal(at(9), 'macro0'); assert.equal(at(11), 'macro0.scope1', 'Introduced non-identifier children have their own group');
  assert.equal(at(13), 'macro0'); assert.equal(at(15), 'macro1.scope0.string', 'String brackets retain their token type');
  assert.equal(at(18), 'macro0.scope0', 'The introduced closing bracket also has the form group');
  // A separate parenthesis outside the string carries the group too.
  const last = Editor.tokenLines('()', Editor.scopeTokens({ text: '()', occurrences: [
    { range: [0, 2], macroScopeGroup: 3 }
  ] }, [{ start: 0, end: 2, style: 0 }]))[0];
  assert.deepEqual(last, [{ startIndex: 0, scopes: 'macro0.scope2' }]);
  const nested = Editor.tokenLines('([])', Editor.scopeTokens({ text: '([])', occurrences: [
    { range: [0, 4], macroScopeGroup: 3 }, { range: [1, 3], macroScopeGroup: 4 }
  ] }, [{ start: 0, end: 4, style: 0 }]))[0];
  assert.deepEqual(nested, [{ startIndex: 0, scopes: 'macro0.scope2' }, { startIndex: 1, scopes: 'macro0.scope3' }, { startIndex: 3, scopes: 'macro0.scope2' }]);
  const names = Array.from({ length: 17 }, (_, i) => Editor.scopeVariable(i + 1));
  const vars = Object.fromEntries(names.map((name, i) => [name, i < 5 ? `#${i + 1}12233` : `#${(i + 1).toString(16).padStart(2, '0')}2233`]));
  vars['--vscode-charts-yellow'] = '#ffff00';
  vars['--vscode-editorBracketHighlight-foreground1'] = '#abcdef';
  vars['--vscode-editorBracketHighlight-foreground2'] = '#fedcba';
  const styles = [{ foreground: '#998877', fontStyle: 2 }, { foreground: '#776655', fontStyle: 1 }];
  const bracketIds = ['editorBracketHighlight.foreground1', 'editorBracketHighlight.foreground2'];
  const theme = Editor.theme(vars, styles, bracketIds);
  const foreground = (theme, scope) => theme.rules.filter(r => scope === r.token || scope.startsWith(r.token + '.')).sort((a, b) => b.token.length - a.token.length)[0].foreground;
  for (let group = 1; group <= 17; group++) {
    const token = Editor.tokenLines('x', [{ start: 0, end: 1, style: 0, group }])[0][0].scopes;
    assert.equal(foreground(theme, token), vars[names[group - 1]].slice(1));
    assert.notEqual(foreground(theme, token), 'ffff00', 'The palette excludes the arrow colour');
  }
  assert.equal(foreground(theme, at(8)), '998877');
  assert.equal(foreground(theme, at(15)), '112233', 'Group foreground overrides a string token foreground');
  assert.equal(theme.rules.find(r => r.token === 'macro1.scope0').fontStyle, 'italic');
  const model = fakeModel(section.text), part = { section, kind: 'after', offset: n => n };
  const decorations = Editor.decorations(model, [part]);
  assert.ok(decorations.some(d => d.options.inlineClassName === 'macro-after'), 'Focus backgrounds coexist with scope tokens');
  assert.ok(decorations.every(d => !/scope|color/i.test(d.options.inlineClassName || '')), 'Scope colour never overrides Monaco bracket decorations');
  // Fake Monaco paints bracket decorations over token foregrounds, just as
  // its bracket-highlighting classes do. Both layers must receive their colours.
  const bracketColor = (offset, depth) => ({ token: foreground(theme, at(offset)),
    painted: theme.colors[bracketIds[depth % bracketIds.length]] });
  assert.deepEqual(bracketColor(0, 0), { token: '112233', painted: '#abcdef' });
  assert.deepEqual(bracketColor(18, 0), { token: '112233', painted: '#abcdef' });
  assert.deepEqual(bracketColor(8, 1), { token: '998877', painted: '#fedcba' });
  assert.equal(foreground(theme, nested[1].scopes), '412233');
  assert.equal(theme.colors[bracketIds[1]], '#fedcba', 'Brackets inside introduced syntax keep the depth colour');
  vars['--vscode-charts-red'] = '#445566';
  assert.equal(foreground(Editor.theme(vars, styles, bracketIds), at(0)), '445566', 'Theme switches update group colours');
});

test('production tokens keep bracket exclusions without transporting scope stacks', async () => {
  const files = { '/themes/child.json': '{}' };
  const api = themeAPI(files);
  api.Uri.joinPath = (base, ...parts) => {
    const pathname = path.posix.join(base.path, ...parts);
    return { path: pathname, fsPath: pathname.endsWith('/out/onig.wasm') ? wasmPath : pathname, toString() { return pathname; } };
  };
  api.workspace.fs.readFile = async uri => uri.path.endsWith('/syntaxes/racket.tmLanguage.json')
    ? fs.readFileSync(path.join(root, 'vscode/syntaxes/racket.tmLanguage.json')) : Buffer.from(files[uri.path]);
  const text = '(define x "(") ; )\n', projection = { final: { id: 'p', text }, diagnostics: {} };
  const colors = await TokenColors.colorPosition(api, { path: '/extension' }, projection, {});
  const tokens = colors.tokenSections.p;
  assert.ok(tokens.every(t => t.scopes === undefined && t.bracket === undefined));
  assert.equal(tokens.find(t => text.slice(t.start, t.end).includes(';')).type, 'comment');
  assert.ok(tokens.some(t => t.type === 'string'));
  const inspection = await TokenColors.colorPosition(api, { path: '/extension' }, projection, {}, true);
  assert.deepEqual(Editor.tokenLines(text, tokens), Editor.tokenLines(text, inspection.tokenSections.p));
  assert.ok(inspection.tokenSections.p.every(t => Array.isArray(t.scopes)));
});

test('worker suffix positions drive name-only hover boxes, arrows and full-text tokens', async t => {
  const text = '#lang racket/base\n' +
    '(define-syntax-rule (wrap x) (let ([tmp x]) (list tmp x)))\n' +
    "(let ([tmp '|😀\r\nλ|]) (wrap tmp))\n";
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const session = createMacroSession(racket, helper, { ...request(text, 'module'), hiding: 'none',
    schemaVersion: 2, session: true, snapshot });
  t.after(() => session.stop());
  const summary = await session.start();
  Data.validateAnswer(summary, snapshot);
  for (let position = 1; position <= summary.stepCount; position++) {
    await session.request({ mode: 'position', snapshot, position });
  }
  const position = summary.stepCount + 1;
  const p = await session.request({ mode: 'position', snapshot, position });
  Data.validatePosition(p, summary, position);
  const section = p.final;
  const name = o => section.text.slice(...o.range);
  const suffixed = o => /^:[0-9]+/.test(section.text.slice(o.range[1]));
  const binder = section.occurrences.find(o => name(o) === 'tmp' && suffixed(o) && section.binderOccurrences.includes(o.id));
  assert.ok(binder, 'An introduced tmp binder has a printed suffix');
  assert.ok(section.text.includes('😀\r\nλ'), 'Byte and UTF-16 offsets differ before the binding use');
  for (const o of section.occurrences) {
    const term = p.terms[o.syntaxId];
    if (term.kind !== 'identifier') continue;
    const spelling = term.name.includes('\n') ? `|${term.name}|` : term.name;
    assert.equal(name(o), spelling, 'Identifier ranges exclude suffixes and retain reader escaping');
    if (suffixed(o)) {
      assert.ok(o.macroScopeGroup > 17);
      assert.ok(section.text.slice(o.range[1]).startsWith(`:${o.macroScopeGroup}`));
    }
    assert.ok(Model.validRange(section.text, o.range));
  }
  const pane = fakeMacroConnections('after');
  pane.page.document.elementFromPoint = () => null;
  pane.render({ ...p, tokenSections: {}, tokenStyles: [], themeName: 'test' });
  const target = pair(section.id, binder.id);
  pane.page.hover = target;
  const dom = pane.observe();
  assert.ok(dom.arrows.length > 0);
  assert.deepEqual(dom.boxes.map(({ sectionId, occurrenceId }) => ({ sectionId, occurrenceId })), Model.hoverBoxes(p, target));
  for (const box of dom.boxes) {
    assert.equal(box.right - box.left, 3 * 8, 'Hover geometry covers tmp characters only');
    const occurrence = section.occurrences.find(o => o.id === box.occurrenceId);
    assert.equal(name(occurrence), 'tmp');
  }
  for (const arrow of dom.arrows) {
    assert.ok(dom.boxes.some(b => b.occurrenceId === arrow.binder && onBoxBoundary(arrow.start, b)));
    assert.ok(dom.boxes.some(b => b.occurrenceId === arrow.reference && onBoxBoundary(arrow.end, b)));
  }
  const part = pane.page.partsBySection.get(section.id);
  for (const o of section.occurrences.filter(o => name(o) === 'tmp' && suffixed(o))) {
    assert.equal(Model.hit(section, o.range[0]).id, o.id);
    assert.notEqual(Model.hit(section, o.range[1])?.id, o.id, 'Suffix characters do not enlarge name hit boxes');
    const range = Editor.range(pane.page.editorModel, part, o.range);
    assert.equal(range.endColumn - range.startColumn, 3);
  }
  const tokenizer = await TokenColors.createTokenizer({ settings: [] }, { wasmPath });
  t.after(() => tokenizer.dispose());
  const tokens = tokenizer.tokenize(section.text, true);
  assert.ok(tokens.every(token => Model.validRange(section.text, [token.start, token.end])));
  const printed = `tmp:${binder.macroScopeGroup}`;
  assert.ok(tokens.some(token => section.text.slice(token.start, token.end).includes(printed)), 'Tokens include the actual printed suffix');
  const lines = Editor.tokenLines(section.text, tokens);
  const model = fakeModel(section.text), at = model.getPositionAt(binder.range[0]);
  const token = tokens.find(token => token.start <= binder.range[0] && token.end > binder.range[0]);
  assert.ok(lines[at.lineNumber - 1].some(line => line.startIndex <= at.column - 1 && line.scopes === `macro${token.style}`));
});

test('every view colour uses a live editor theme variable and local assets have strict CSP', () => {
  const css = fs.readFileSync(path.join(root, 'vscode/macro-view/view.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i);
  for (const declaration of css.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, value] = declaration;
    if (/color|background|border|outline|stroke|fill|decoration/.test(prop)) {
      let residual = value;
      for (let i = 0; i < 8; i++) residual = residual.replace(/var\(--vscode-[^()]*\)/g, '');
      residual = residual.replace(/-?(?:\d*\.)?\d+(?:px|em|rem|%)?/g, '')
        .replace(/\b(?:solid|dashed|dotted|double|none|underline)\b/g, '').replace(/[\s,]/g, '');
      assert.equal(residual, '', `${prop}: ${value} must obtain every colour from the selected theme`);
    }
  }
  for (const asset of ['view.js', 'model.js', 'protocol.js', 'geometry.js']) {
    const source = fs.readFileSync(path.join(root, 'vscode/macro-view', asset), 'utf8');
    new vm.Script(source, { filename: asset });
    assert.doesNotMatch(source, /\.innerHTML\s*=|\.style\.|setAttribute\(['"]style/);
  }
  assert.match(css, /vscode-high-contrast/);
  assert.match(css, /svg \.definite :is\(\.edge[^)]*\)\s*\{[^}]*stroke: var\(--vscode-charts-green\)/);
  assert.match(css, /svg \.possible :is\(\.edge[^)]*\)\s*\{[^}]*stroke: var\(--vscode-charts-yellow\)/);
  assert.match(css, /svg \.definite\.kept :is\(\.head, \.origin\)[^{]*\{[^}]*fill: var\(--vscode-charts-green\)/);
  assert.match(css, /svg \.possible\.kept :is\(\.head, \.origin\)[^{]*\{[^}]*fill: var\(--vscode-charts-yellow\)/);
  assert.doesNotMatch(css, /stroke-dasharray|--vscode-charts-(?:purple|blue)|magenta/);
  assert.doesNotMatch(css, /pre\.program|\.bracket-[1-6]|\.viewport/);
  assert.match(css, /editor-surface.*position: absolute/);
  assert.match(css, /macro-hover.*--vscode-charts-yellow/);
  const uri = { joinPath: (_base, ...parts) => parts.join('/') };
  const html = load({ vscode: { Uri: uri } }).panelHtml({ cspSource: 'local:', asWebviewUri: x => x }, 'extension');
  assert.match(html, /default-src &#39;none&#39;|default-src 'none'/);
  assert.match(html, /script-src 'nonce-/); assert.match(html, /style-src local: 'unsafe-inline'/);
  assert.match(html, /font-src local:/); assert.match(html, /worker-src 'none'/);
  assert.match(html, /out\/monaco\/editor.js/); assert.match(html, /out\/monaco\/editor.css/);
  assert.doesNotMatch(html, /unsafe-eval|https?:|\son\w+=/);
  assert.match(html, /frame-src 'none'/); assert.match(html, /connect-src 'none'/);
  new vm.Script(fs.readFileSync(path.join(root, 'tests/vscode-macro-stepper.js'), 'utf8'));
  const ignore = fs.readFileSync(path.join(root, 'vscode/.vscodeignore'), 'utf8');
  assert.doesNotMatch(ignore, /^macro-view\/\*\*/m);
  const build = fs.readFileSync(path.join(root, 'scripts/build-extension.js'), 'utf8');
  for (const file of ['view.js', 'view.css', 'model.js', 'geometry.js', 'protocol.js']) assert.ok(build.includes(`'${file}'`));
});

test('theme, token and bracket setting events recolor the page without replacing its selection or pins', async () => {
  const ui = fakeStepper(); await opened(ui); const panel = ui.panels[0];
  panel.send('select', pair()); await tick();
  panel.send('pin', { action: 'tack', ...pair() }); await tick();
  const initial = await ui.command('_observe'), starts = panel.messages.filter(m => m.type === 'positionBegin').length;
  for (const change of [ui.themeChange, ui.tokenChange,
    () => ui.bracketChange('editor.bracketPairColorization.enabled'),
    () => ui.bracketChange('editor.bracketPairColorization.independentColorPoolPerBracketType')]) {
    change(); await tick(); await tick();
    const latest = await ui.command('_observe');
    assert.deepEqual(latest.selection, initial.selection); assert.deepEqual(latest.pins, initial.pins);
    assert.equal(latest.revision, initial.revision);
  }
  const updates = panel.messages.filter(m => m.type === 'positionBegin').slice(starts);
  assert.deepEqual(updates.map(m => m.payloadKind), ['colors', 'colors', 'colors', 'colors']);
  ui.dispose();
});

test('a theme change during a position transfer waits for the matching program to commit', async () => {
  const ui = fakeStepper(); await opened(ui); const panel = ui.panels[0];
  panel.ack = false; const navigation = ui.command('next'); await tick();
  const begin = panel.messages.filter(m => m.type === 'positionBegin').at(-1);
  ui.themeChange(); await tick();
  assert.equal(panel.messages.filter(m => m.type === 'positionBegin').at(-1), begin);
  panel.ack = true;
  panel.send('transferAck', { transferId: begin.transferId, lastSequence: -1, success: true });
  await navigation; await tick(); await tick();
  assert.equal(panel.projection.position, 2);
  assert.ok(panel.messages.filter(m => m.type === 'positionBegin').some(m => m.payloadKind === 'colors'));
  ui.dispose();
});

test('Standard swap! exact text needs no suffix despite different groups', async t => {
  const text = '#lang racket/base\n' +
    '(define-syntax-rule (swap! a b) (let ([tmp a]) (set! a b) (set! b tmp)))\n' +
    '(let ([tmp 1] [other 2]) (swap! tmp other))\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const session = createMacroSession(racket, helper, { ...request(text, 'module'), hiding: 'standard', schemaVersion: 2, session: true, snapshot });
  t.after(() => session.stop());
  const summary = await session.start();
  const position = summary.steps.findIndex(s => s.macro === 'swap!') + 1;
  const p = await session.request({ mode: 'position', snapshot, position });
  const section = p.record.after;
  assert.deepEqual(section.focus.map(r => section.text.slice(...r).replace(/\s+/g, ' ')),
    ['(let ([tmp tmp]) (set! tmp other) (set! other tmp))']);
});

test('scope palette has seventeen unique slots and never cycles overflow', () => {
  const variables = Array.from({ length: 17 }, (_, i) => Editor.scopeVariable(i + 1));
  assert.equal(new Set(variables).size, 17);
  assert.ok(variables.every(v => !v.toLowerCase().includes('yellow')));
  assert.equal(Editor.tokenLines('x', [{ start: 0, end: 1, style: 0, group: 18 }])[0][0].scopes, 'macro0');
});

test('exact suffix and quote worked examples survive the worker transport', async () => {
  const fixture = path.join(root, 'tests/fixtures/macro-display.rkt');
  const run = owned(racket, fixture, {});
  run.process.start(); await run.process.done;
  assert.deepEqual(run.errors, []);
  assert.deepEqual(JSON.parse(run.output), {
    table: [['x', 'x', 'x'], ['x', 'x', 'x:1'], ['x', 'x', 'x:16'], ['x', 'x', 'x:17'],
      ['x', 'x:18', 'x:18'], ['x', 'x:44', 'x:44']],
    small: ['(list x x)', '(list x:1 x:2)'], fresh: 'fresh:18', names: '(list left:18 right:18)',
    finished: ['define-values:31', '#%app:42', '(quote:44 a:44)'], moved: '(quote a)',
    marked: ["'a:44", '(quote:44 a:44)', "'a:44", '(quote:44 a:44)', "'a", '(quote a)'],
    prefixes: ["'x", '`x', ',x', ',@x', "#'x", '#`x', '#,x', '#,@x'],
    quotes: ["'5", "'()", '(quote ())', "''x", '(quote x extra)', '(quote . x)', "'#%kernel", "'syntax/loc", '(quote 5)']
  });
});

test('display history survives hiding, backtracking and restoration, and reset starts at one', async t => {
  const text = '#lang racket/base\n' +
    '(define-syntax-rule (one x) (list x))\n' +
    '(define-syntax-rule (two x) (list x x))\n(one 1)\n(two 2)\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const input = { ...request(text, 'module'), hiding: 'standard', schemaVersion: 2, session: true, snapshot };
  const session = createMacroSession(racket, helper, input);
  t.after(() => session.stop());
  const initial = await session.start();
  assert.equal(initial.nextGroup, 1, 'Expansion without display allocates no groups');
  const journal = [];
  const ask = async query => {
    const result = await session.request({ ...query, snapshot });
    assert.equal(result.failed, undefined);
    journal.push(query);
    return result;
  };
  const second = await ask({ mode: 'position', position: 2, panes: true });
  const first = await ask({ mode: 'position', position: 1, panes: true });
  assert.deepEqual((await ask({ mode: 'position', position: 2, panes: true })).record, second.record);
  const all = await ask({ mode: 'reexpand', hiding: 'none' });
  assert.equal(all.nextGroup, first.nextGroup, 'Changing hiding alone allocates no groups');
  await ask({ mode: 'position', position: all.stepCount + 1, panes: true });
  await ask({ mode: 'reexpand', hiding: 'standard' });
  const returned = await ask({ mode: 'position', position: 2, panes: true });
  assert.equal(returned.record.after.text, second.record.after.text);
  assert.deepEqual(returned.record.after.occurrences.map(o => o.macroScopeGroup), second.record.after.occurrences.map(o => o.macroScopeGroup));
  const replacement = createMacroSession(racket, helper, input);
  t.after(() => replacement.stop());
  await replacement.start();
  for (const query of journal) await replacement.request({ ...query, snapshot, replay: true });
  const restored = await replacement.request({ mode: 'position', snapshot, position: 2, panes: true });
  assert.deepEqual(restored.record, returned.record);
  const reset = await ask({ mode: 'configure', grouping: 'macro' });
  assert.equal(reset.nextGroup, 1);
  const redrawn = await ask({ mode: 'position', position: 2, panes: true });
  const groups = [...redrawn.record.before.occurrences, ...redrawn.record.after.occurrences].map(o => o.macroScopeGroup);
  assert.equal(Math.min(...groups.filter(g => g > 0)), 1);
  const allScopes = await ask({ mode: 'configure', grouping: 'all' });
  assert.equal(allScopes.nextGroup, 1);
  const regrouped = await ask({ mode: 'position', position: 2, panes: true });
  assert.ok(regrouped.record.before.occurrences.some(o => regrouped.terms[o.syntaxId].name === 'one' && o.macroScopeGroup > 0));
});

test('Custom hiding and rule changes retain suffix history past the colour limit', async t => {
  const { workerRule, customSettings } = require('./support/macro-hiding');
  const text = '#lang racket/base\n(define-syntax-rule (keep a) (let ([x a]) x))\n' +
    Array.from({ length: 22 }, (_, i) => `(keep ${i})`).join('\n') + '\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const session = createMacroSession(racket, helper, { ...request(text, 'module'), schemaVersion: 2, session: true, snapshot });
  t.after(() => session.stop());
  const summary = await session.start();
  const at = position => session.request({ mode: 'position', snapshot, position, panes: true });
  // Visit the later programs first, then retain their assigned groups through
  // disabling hiding and removing the Custom rule.
  let first;
  for (let n = summary.stepCount; n >= 1; n--) first = await at(n);
  assert.ok(first.nextGroup > 18);
  const before = await at(summary.stepCount);
  assert.match(before.record.after.text, /x:18/);
  const rule = await workerRule(session, summary, snapshot, 'keep', 'hide');
  const hidden = await session.request({ mode: 'reexpand', snapshot, hiding: 'custom', custom: customSettings([rule]) });
  assert.equal(hidden.nextGroup, first.nextGroup);
  assert.equal(hidden.stepCount, 0);
  const disabled = await session.request({ mode: 'reexpand', snapshot, hiding: 'custom', custom: customSettings([rule], { enabled: false }) });
  assert.equal(disabled.nextGroup, first.nextGroup);
  assert.ok(disabled.stepCount > summary.stepCount);
  await at(disabled.stepCount + 1);
  const removed = await session.request({ mode: 'reexpand', snapshot, hiding: 'custom', custom: customSettings() });
  assert.equal(removed.stepCount, summary.stepCount);
  const after = await at(summary.stepCount);
  assert.equal(after.record.after.text, before.record.after.text);
  assert.deepEqual(after.record.after.occurrences.map(o => o.macroScopeGroup), before.record.after.occurrences.map(o => o.macroScopeGroup));
});

test('paired view restores its display journal and reset clears cached numbering for both panes', async t => {
  const ui = fakeStepper(); t.after(() => ui.dispose());
  await opened(ui);
  await ui.command('next');
  const hiding = ui.command('showAll'); await tick(); ui.answer(ui.pending[0]); await hiding;
  const original = ui.pending[0];
  const history = original.queries.filter(q => ['position', 'reexpand'].includes(q.mode));
  await original.stop();
  const panel = ui.panels[0];
  panel.send('select', pair()); await tick();
  const replacement = ui.pending.at(-1);
  assert.notEqual(replacement, original);
  ui.answer(replacement); await tick(); await tick();
  assert.deepEqual(plain(replacement.queries.filter(q => q.replay).map(({ replay, ...query }) => query)), plain(history));
  const resetting = ui.command('resetMarkNumbering'); await tick();
  assert.equal(replacement.queries.at(-1).mode, 'configure');
  ui.answer(replacement); await resetting;
  assert.ok(ui.panels.every(p => p.projection.position === 1));
  assert.deepEqual(plain((await ui.command('_observe')).loadedPositions), [1]);
  ui.window.showQuickPick = async choices => choices.find(c => c.value === 'all');
  const grouping = ui.command('foregroundGrouping'); await tick();
  assert.equal(replacement.queries.at(-1).grouping, 'all');
  ui.answer(replacement); await grouping;
  const refreshing = ui.command('refresh'); await tick();
  assert.equal(ui.pending.at(-1).request.grouping, 'all');
  ui.answer(ui.pending.at(-1)); await refreshing;
});

test('cached completion inspections reconstruct the terminal Before identities', async t => {
  const text = '#lang racket/base\n(define-syntax-rule (one x) (list x))\n' +
    '(define-syntax-rule (two x) (list x x))\n(one 1)\n(two 2)\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const session = createMacroSession(racket, helper, { ...request(text, 'module'), hiding: 'standard', schemaVersion: 2, session: true, snapshot });
  t.after(() => session.stop());
  const summary = await session.start(), position = summary.stepCount + 1;
  await session.request({ mode: 'position', snapshot, position: summary.stepCount, panes: true });
  const completed = await session.request({ mode: 'position', snapshot, position, panes: true });
  const occurrence = completed.terminalBefore.occurrences.findLast(o => completed.terms[o.syntaxId].name === 'two');
  assert.ok(occurrence);
  await session.request({ mode: 'position', snapshot, position: 1, panes: true });
  const reply = await session.request({ mode: 'inspect', snapshot, position, term: occurrence.syntaxId });
  assert.equal(reply.failed, undefined);
  const term = decodeTerm(reply.shared, reply.termData);
  assert.equal(term.name, 'two');
  assert.deepEqual(term.source, completed.terms[occurrence.syntaxId].source);
  assert.equal(term.macroScopeGroup, occurrence.macroScopeGroup);
});

test('overflow suffixes have no scope colour even inside a coloured enclosing form', () => {
  const section = { text: '(x:18)', occurrences: [
    { range: [0, 6], macroScopeGroup: 1 },
    { range: [1, 2], colorRange: [1, 5], macroScopeGroup: 18 }
  ] };
  assert.deepEqual(Editor.tokenLines(section.text, Editor.scopeTokens(section, [{ start: 0, end: 6, style: 0 }]))[0],
    [{ startIndex: 0, scopes: 'macro0.scope0' }, { startIndex: 1, scopes: 'macro0' }, { startIndex: 5, scopes: 'macro0.scope0' }]);
});

test('scope colours resolve duplicate chart and ANSI values using spare theme entries', () => {
  const names = [...Array.from({ length: 17 }, (_, i) => Editor.scopeVariable(i + 1)),
    '--vscode-terminal-ansiBlack', '--vscode-terminal-ansiBrightBlack'];
  const variables = Object.fromEntries(names.map((name, i) => [name, `#${(i + 1).toString(16).padStart(2, '0')}2233`]));
  variables['--vscode-charts-red'] = '#aa2233';
  variables['--vscode-terminal-ansiBrightRed'] = '#AA2233';
  variables['--vscode-terminal-ansiBrightBlue'] = variables['--vscode-charts-blue'];
  variables['--vscode-charts-yellow'] = '#ffff00';
  const resolved = () => Editor.theme(variables, [{ foreground: '#abcdef', fontStyle: 0 }], [])
    .rules.filter(r => r.token.startsWith('macro0.scope')).map(r => r.foreground);
  assert.equal(resolved().length, 17);
  assert.equal(new Set(resolved()).size, 17);
  assert.ok(!resolved().includes('ffff00'));
  const old = resolved();
  variables['--vscode-charts-red'] = '#123456';
  assert.notDeepEqual(resolved(), old);
  const unique = Object.fromEntries(names.map((name, i) => [name, `#${(i + 1).toString(16).padStart(2, '0')}3344`]));
  unique['--vscode-charts-yellow'] = unique['--vscode-charts-red'];
  const theme = Editor.theme(unique, [{ foreground: '#abcdef', fontStyle: 0 }], []);
  assert.ok(theme.rules.filter(r => r.token.includes('.scope')).every(r => r.foreground !== unique['--vscode-charts-yellow'].slice(1)));
});
