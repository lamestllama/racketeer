'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');
const extensionRequire = createRequire(path.join(__dirname, '../vscode/package.json'));
const { Registry } = extensionRequire('vscode-textmate');
const { loadWASM, OnigScanner, OnigString } = extensionRequire('vscode-oniguruma');
const manifest = require('../vscode/package.json');
const config = require('../vscode/rhombus-language-configuration.json');

const ready = (async () => {
  await loadWASM(fs.readFileSync(extensionRequire.resolve('vscode-oniguruma/release/onig.wasm')));
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: text => new OnigString(text) }),
    loadGrammar: async scope => {
      const entry = manifest.contributes.grammars.find(grammar => grammar.scopeName === scope);
      return entry ? JSON.parse(fs.readFileSync(path.join(__dirname, '../vscode', entry.path), 'utf8')) : null;
    }
  });
  return registry.loadGrammar('source.rhombus');
})();
async function tokens(source) {
  const grammar = await ready;
  let state;
  return source.split('\n').map(line => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex),
      start: token.startIndex, end: token.endIndex, scopes: token.scopes }));
  });
}
function scope(lines, row, text, expected, occurrence = 0) {
  const line = lines[row].map(token => token.text).join('');
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = line.indexOf(text, index + 1);
  assert.ok(index >= 0, `Missing ${JSON.stringify(text)} on line ${row + 1}`);
  const token = lines[row].find(item => item.start <= index && item.end > index);
  assert.ok(token.scopes.some(item => item.startsWith(expected)), `${text}: ${token.scopes.join(', ')} does not include ${expected}`);
}
function absent(lines, row, text, unwanted) {
  const index = lines[row].map(token => token.text).join('').indexOf(text);
  assert.ok(index >= 0);
  assert.ok(!lines[row].find(item => item.start <= index && item.end > index).scopes.some(item => item.startsWith(unwanted)));
}

test('Rhombus file association and activation do not contribute debugger support', () => {
  const language = manifest.contributes.languages.find(item => item.id === 'rhombus');
  assert.deepEqual(language.extensions, ['.rhm']);
  assert.equal(language.configuration, './rhombus-language-configuration.json');
  assert.ok(manifest.activationEvents.includes('onLanguage:rhombus'));
  assert.ok(manifest.activationEvents.includes('workspaceContains:**/*.rhm'));
  assert.ok(!manifest.contributes.breakpoints.some(item => item.language === 'rhombus'));
  assert.ok(!manifest.contributes.debuggers.some(item => item.languages.includes('rhombus')));
  assert.equal(manifest.contributes.configurationDefaults['[rhombus]']['editor.defaultFormatter'], undefined);
});

test('nested block comments and adjacent operators preserve comment boundaries', async () => {
  const lines = await tokens('def x = 1+/* outer\n  /* inner */ still outer\n*/2 // line\ndef y = 3');
  scope(lines, 0, '+', 'keyword.operator');
  scope(lines, 0, 'outer', 'comment.block');
  scope(lines, 1, 'still outer', 'comment.block');
  scope(lines, 2, '2', 'constant.numeric');
  scope(lines, 2, 'line', 'comment.line');
  absent(lines, 3, 'def', 'comment');
});

test('strings are single-line, escaped quotes stay strings, and bytes disallow Unicode escapes', async () => {
  const lines = await tokens(String.raw`"a\" // /* def" #"b\377\u12" "\u03bb\U01f600"
"unterminated
 def after = 8`);
  scope(lines, 0, '//', 'string.quoted.double');
  scope(lines, 0, '\\"', 'constant.character.escape');
  scope(lines, 0, '\\377', 'constant.character.escape');
  scope(lines, 0, '\\u12', 'invalid.illegal.escape');
  scope(lines, 0, '\\u03bb', 'constant.character.escape');
  scope(lines, 0, '\\U01f600', 'constant.character.escape');
  absent(lines, 2, 'def', 'string');
});

test('booleans, void and documented numeric spellings have complete token scopes', async () => {
  const values = ['#true', '#false', '#void', '#inf', '#neginf', '#nan', '0', '-42', '+3', '1_234',
    '0xA_f', '-0o7_1', '0b10_01', '2/7', '1_0/3_1', '1.25', '.5', '4.', '1e-3', '2_0.5E+2'];
  const lines = await tokens(values.join(' '));
  for (const value of values) scope(lines, 0, value, /^#(?:true|false|void)$/.test(value) ? 'constant.language' : 'constant.numeric');
});

test('identifiers, keywords and numbers respect token boundaries and signed-number rules', async () => {
  const lines = await tokens('def defiant = x1 + 1+2 -3 x-4 ~label #%internal λ7 👩‍💻\n1x #trueish 0xZ 2__0\n1..3 1.+2');
  scope(lines, 0, 'def', 'keyword.control');
  scope(lines, 0, 'defiant', 'variable.other');
  scope(lines, 0, 'x1', 'variable.other');
  scope(lines, 0, '+2', 'keyword.operator');
  scope(lines, 0, '-3', 'constant.numeric');
  scope(lines, 0, '-4', 'keyword.operator');
  scope(lines, 0, '~label', 'constant.other.keyword');
  scope(lines, 0, '#%internal', 'variable.other');
  scope(lines, 0, 'λ7', 'variable.other');
  scope(lines, 0, '👩‍💻', 'variable.other');
  for (const value of ['1x', '#trueish', '0xZ', '2__0']) absent(lines, 1, value, 'constant');
  scope(lines, 2, '..', 'keyword.operator');
  scope(lines, 2, '.+', 'keyword.operator');
});

test('shrubbery quotes enclose code, and quote/hash operators remain distinct', async () => {
  const lines = await tokens("'def x = 1' '« 'inner' + 2 »' #' #, #;\ndef next = #false");
  scope(lines, 0, 'def', 'meta.quoted');
  scope(lines, 0, '1', 'constant.numeric');
  absent(lines, 0, 'def', 'string');
  scope(lines, 0, 'inner', 'meta.quoted');
  scope(lines, 0, "#'", 'keyword.operator');
  scope(lines, 0, '#,', 'keyword.operator');
  absent(lines, 1, 'def', 'meta.quoted');
});

test('separators, continuations and group-comment markers are distinct from operators', async () => {
  const lines = await tokens('#// def omitted = 1\nif x:\n | #true: f(a, b); g() \\\n | #false:« x :: Int || y :~ Int »');
  scope(lines, 0, '#//', 'comment.line.group-marker');
  absent(lines, 0, 'def', 'comment'); // Extent requires the shrubbery parser.
  scope(lines, 1, ':', 'punctuation.separator.block');
  scope(lines, 2, '|', 'punctuation.separator.block');
  scope(lines, 2, ';', 'punctuation.separator');
  scope(lines, 2, '\\', 'punctuation.separator.continuation');
  scope(lines, 3, '::', 'keyword.operator');
  scope(lines, 3, '||', 'keyword.operator');
  scope(lines, 3, ':~', 'keyword.operator');
});

test('at-notation separates literal text, nested braces, escaped expressions and comments', async () => {
  const lines = await tokens('@render(~style: 1){literal // "text" {nested} @bold{hello} @value\n@// ignored\n@//{comment {nested}} tail}{second}\ndef after = 4');
  scope(lines, 0, '~style', 'constant.other.keyword');
  scope(lines, 0, 'literal', 'string.unquoted.at');
  scope(lines, 0, '//', 'string.unquoted.at');
  scope(lines, 0, 'nested', 'string.unquoted.at');
  scope(lines, 0, 'hello', 'string.unquoted.at');
  scope(lines, 1, 'ignored', 'comment.line.at');
  scope(lines, 2, 'comment', 'comment.block.at');
  scope(lines, 2, 'tail', 'string.unquoted.at');
  scope(lines, 2, 'second', 'string.unquoted.at');
  absent(lines, 3, 'def', 'string');
});

test('documented custom at delimiters use only their own escape and closing sequence', async () => {
  const lines = await tokens('@render|{literal @bold{x} |@bold{escaped}}|\n@render|<<{literal } and @ |<<@value }>>|\ndef after = 2');
  scope(lines, 0, '@bold', 'string.unquoted.at');
  scope(lines, 0, 'escaped', 'string.unquoted.at');
  scope(lines, 1, 'literal', 'string.unquoted.at');
  scope(lines, 1, '|<<@value', 'meta.at-expression');
  absent(lines, 2, 'def', 'string');
});

test('Racket atom escapes use the existing Racket grammar without leaking it', async () => {
  const lines = await tokens('#{#t} ~#{|unusual keyword|} #{"a}b"} def after = 2');
  scope(lines, 0, '#t', 'constant.language.racket');
  scope(lines, 0, 'a}b', 'string.quoted.double.racket');
  scope(lines, 0, 'def', 'keyword.control.rhombus');
  absent(lines, 0, 'def', 'meta.embedded');
});

test('language configuration uses shrubbery comments, quote pairs and conservative indentation', () => {
  assert.deepEqual(config.comments, { lineComment: '//', blockComment: ['/*', '*/'] });
  assert.ok(config.brackets.some(([open, close]) => open === '«' && close === '»'));
  assert.ok(config.autoClosingPairs.some(item => item.open === "'" && item.close === "'"));
  for (const pair of config.autoClosingPairs) assert.deepEqual(pair.notIn, ['string', 'comment']);
  const increase = new RegExp(config.indentationRules.increaseIndentPattern);
  for (const line of ['fun square(x):', 'if ok: // body', 'def xs = [', 'block:«', 'if value |']) {
    assert.ok(increase.test(line), `Indent after ${line}`);
  }
  for (const line of ['def s = ":"', '// comment:', '/* comment:', 'value ::', 'value ||', 'def x = f(1)', 'def x = 2']) {
    assert.ok(!increase.test(line), `Do not indent after ${line}`);
  }
  const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);
  assert.ok(decrease.test('  »'));
  assert.ok(!decrease.test('  | alternative'));
  assert.ok(new RegExp(config.indentationRules.indentNextLinePattern).test('a + \\ // continued'));
  const word = new RegExp(config.wordPattern, 'g');
  assert.deepEqual('object.field + ~label λ7'.match(word), ['object', 'field', '~label', 'λ7']);
});
