// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Registry, parseRawGrammar } = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');
const { parse } = require('jsonc-parser');
const Model = require('./macro-view/model');
const { tokenType } = require('./macro-view/monaco');
let onig;
const groups = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable']
};
const color = value => typeof value === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
function normalize(value) {
  if (!color(value)) return undefined;
  return (value.length <= 5 ? '#' + [...value.slice(1)].map(c => c + c).join('') : value).toUpperCase();
}
function scoped(custom, name) {
  const result = {};
  for (const [key, value] of Object.entries(custom || {})) {
    const selectors = [...key.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
    if (selectors.some(s => s === name || s === '*' ||
      s.startsWith('*') && s.endsWith('*') && name.includes(s.slice(1, -1)) ||
      s.startsWith('*') && name.endsWith(s.slice(1)) || s.endsWith('*') && name.startsWith(s.slice(0, -1)))) {
      for (const [property, setting] of Object.entries(value || {})) {
        result[property] = Array.isArray(result[property]) && Array.isArray(setting) ? result[property].concat(setting) : setting;
      }
    }
  }
  return result;
}
function customRules(custom) {
  const rules = [];
  for (const [group, scope] of Object.entries(groups)) {
    const value = custom?.[group];
    if (value) rules.push({ scope, settings: typeof value === 'string' ? { foreground: value } : value });
  }
  return rules.concat(custom?.textMateRules || []);
}
// Theme files can be JSON with comments or a TextMate plist, including both
// kinds of include and the legacy tokenColors filename form.
async function readTheme(vscode, uri, stack = new Set()) {
  const key = uri.toString();
  if (stack.has(key)) throw Error('Cyclic theme include');
  stack.add(key);
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const errors = [];
    const data = /\.json$/i.test(uri.path) ? parse(text, errors, { allowTrailingComma: true }) : parseRawGrammar(text, uri.path);
    if (errors.length || !data || typeof data !== 'object') throw Error('Invalid theme');
    const relative = file => vscode.Uri.joinPath(uri, '..', file);
    const parent = data.include ? await readTheme(vscode, relative(data.include), stack) : { rules: [], colors: {} };
    const rules = [...parent.rules], colors = { ...parent.colors, ...data.colors };
    if (Array.isArray(data.settings)) {
      for (const rule of data.settings) {
        if (!rule.scope && rule.settings?.foreground) colors['editor.foreground'] = rule.settings.foreground;
        if (rule.scope) rules.push(rule);
      }
    } else if (typeof data.tokenColors === 'string') {
      const tokens = await readTheme(vscode, relative(data.tokenColors), stack);
      rules.push(...tokens.rules); Object.assign(colors, tokens.colors);
    } else if (Array.isArray(data.tokenColors)) rules.push(...data.tokenColors);
    return { rules, colors };
  } finally { stack.delete(key); }
}
async function resolveTheme(vscode, resource) {
  const name = vscode.workspace.getConfiguration('workbench').get('colorTheme', '');
  try {
    let contribution, provider;
    for (const extension of vscode.extensions.all) {
      const theme = extension.packageJSON.contributes?.themes?.find(t => (t.id || t.label) === name);
      if (theme) { contribution = theme; provider = extension; break; }
    }
    if (!contribution) throw Error('Theme unavailable');
    const theme = await readTheme(vscode, vscode.Uri.joinPath(provider.extensionUri, contribution.path));
    const custom = vscode.workspace.getConfiguration('editor', { uri: resource, languageId: 'racket' }).get('tokenColorCustomizations', {});
    const ui = vscode.workspace.getConfiguration('workbench').get('colorCustomizations', {});
    const foreground = normalize(scoped(ui, name)['editor.foreground'] || ui['editor.foreground'] || theme.colors['editor.foreground']);
    const rules = theme.rules.concat(customRules(custom), customRules(scoped(custom, name)))
      .filter(r => r.scope && r.settings).map(r => ({ scope: r.scope, settings: {
        foreground: normalize(r.settings.foreground), fontStyle: r.settings.fontStyle
      } }));
    // An unspecified default inherits the webview's editor foreground. Give it
    // a private color ID distinct from every explicit token color.
    const used = new Set(rules.map(r => r.settings.foreground));
    let defaultColor = foreground, candidate = 0;
    while (!defaultColor || used.has(defaultColor) && !foreground) defaultColor = `#${(candidate++).toString(16).padStart(6, '0')}`;
    return { name, foreground, settings: [{ settings: { foreground: defaultColor } }, ...rules] };
  } catch { return { name, foreground: undefined, settings: [] }; }
}
async function createTokenizer(theme, options = {}) {
  onig ||= oniguruma.loadWASM(fs.readFileSync(options.wasmPath || path.join(__dirname, 'onig.wasm')));
  await onig;
  const raw = options.grammar || JSON.parse(fs.readFileSync(path.join(__dirname, 'syntaxes/racket.tmLanguage.json'), 'utf8'));
  const registry = new Registry({ theme: { settings: theme.settings }, onigLib: Promise.resolve(oniguruma),
    loadGrammar: async scope => scope === raw.scopeName ? raw : null });
  const grammar = await registry.loadGrammar(raw.scopeName), styles = [], styleIds = new Map();
  const style = metadata => {
    const foregroundId = (metadata >>> 15) & 511, font = (metadata >>> 11) & 15;
    const value = { foreground: !theme.settings.length || foregroundId === 1 && !theme.foreground ? null : registry.getColorMap()[foregroundId], fontStyle: font };
    const key = JSON.stringify(value);
    if (!styleIds.has(key)) { styleIds.set(key, styles.length); styles.push(value); }
    return styleIds.get(key);
  };
  function tokenize(text, withScopes = false) {
    const spans = []; let offset = 0, state = null;
    for (const line of text.split('\n')) {
      const colored = grammar.tokenizeLine2(line, state);
      const tokens = grammar.tokenizeLine(line, state);
      let index = 0;
      for (const token of tokens.tokens) {
        while (index + 2 < colored.tokens.length && colored.tokens[index + 2] <= token.startIndex) index += 2;
        const start = offset + token.startIndex, end = offset + Math.min(line.length, token.endIndex);
        if (end > start) spans.push({ start, end, style: style(colored.tokens[index + 1]), ...(withScopes ? { scopes: token.scopes } : {}) });
      }
      state = colored.ruleStack; offset += line.length + 1;
    }
    return spans;
  }
  return { tokenize, styles, dispose: () => registry.dispose() };
}
async function colorPosition(vscode, extensionUri, projection, resource, withScopes = false) {
  const theme = await resolveTheme(vscode, resource);
  const tokenizer = await createTokenizer(theme, {
    wasmPath: vscode.Uri.joinPath(extensionUri, 'out/onig.wasm').fsPath,
    grammar: JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'syntaxes/racket.tmLanguage.json'))).toString('utf8'))
  });
  try {
    const tokenSections = Object.fromEntries(Model.sections(projection).map(({ section }) =>
      [section.id, tokenizer.tokenize(section.text, true).map(({ scopes, ...span }) => ({
        ...span, type: tokenType(scopes), ...(withScopes ? { scopes } : {})
      }))]));
    return { tokenSections, tokenStyles: tokenizer.styles, themeName: theme.name };
  } finally { tokenizer.dispose(); }
}
module.exports = { readTheme, resolveTheme, createTokenizer, colorPosition };
