'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { languageServer } = require('./language-server-project');
const { uri, project, edited } = require('./workspace-index-project');
const text = hover => typeof hover?.contents === 'string' ? hover.contents : hover?.contents?.value || '';
const position = (source, needle, delta = 1) => {
  const offset = source.indexOf(needle) + delta;
  assert.ok(offset >= delta, needle);
  const prefix = source.slice(0, offset).split('\n');
  return { line: prefix.length - 1, character: prefix.at(-1).length };
};

test('tail hover describes relative contexts and keeps non-tail arguments distinct', { timeout: 120000 }, async t => {
  const p = await languageServer(t);
  const source = '#lang racket/base\n(define (f x)\n  (+ 1 (if x (f #f) 3)))\n(define (g x)\n  (if x (g #f) 4))\n';
  await p.open('tail.rkt', source); await p.expectDiagnostics('tail.rkt', false);
  const hover = async (needle, delta) => text(await p.request('hover', 'tail.rkt', { position: position(source, needle, delta) }));
  assert.match(await hover('(f #f)'), /In tail position relative to the expression at line 3, column 8/);
  assert.match(await hover('(g #f)'), /In tail position relative to the expression at line 5, column 3/);
  assert.match(await hover('(if x (g'), /In tail position relative to the expression at line 4, column 1/);
  assert.match(await hover('(if x (f'), /Expressions in tail position relative to this one/);
  assert.doesNotMatch(await hover('(if x (f'), /In tail position relative to the expression/);
  assert.doesNotMatch(await hover('x (f #f)', 0), /\*\*Tail position\*\*/);
  assert.match(await hover('(+ 1', 0), /\*\*Tail position\*\*/);
  assert.match(await hover('(+ 1'), /\*\*Tail position\*\*/);
});

test('workspace references and rename preserve UTF-16 coordinates across files', { timeout: 120000 }, async t => {
  const p = await project(t);
  const definition = '#lang racket/base\n(provide 😀) (define 😀 1)\n';
  const consumer = '#lang racket/base\n(require "unicode.rkt")\n(list "🙂" 😀 😀)\n';
  p.write('unicode.rkt', definition); p.write('consumer.rkt', consumer);
  const origin = p.open('unicode.rkt', definition), use = p.open('consumer.rkt', consumer);
  await p.update();
  const call = { line: 2, character: consumer.split('\n')[2].lastIndexOf('😀') };
  const references = await p.references(use, call, true);
  assert.equal(references.length, 4, JSON.stringify(references));
  for (const location of references) {
    const source = location.uri === origin ? definition : consumer;
    const { start, end } = location.range;
    assert.equal(start.line, end.line);
    assert.equal(source.split('\n')[start.line].slice(start.character, end.character), '😀');
  }
  const rename = await p.rename(use, 'face', call);
  assert.equal(edited(definition, rename.changes[origin]), definition.replaceAll('😀', 'face'));
  assert.equal(edited(consumer, rename.changes[use]), consumer.replaceAll('😀', 'face'));
});

test('tail hover follows Unicode unsaved edits and disappears on invalid source or close', { timeout: 120000 }, async t => {
  const p = await languageServer(t);
  const file = 'untitled:Untitled-1';
  const source = '#lang racket/base\n(define (λ😀 x) (λ😀 x))\n';
  await p.open(file, source); await p.expectDiagnostics(file, false);
  const call = { line: 1, character: source.split('\n')[1].lastIndexOf('λ😀') + 1 };
  assert.match(text(await p.request('hover', file, { position: call })), /line 2, column 1/);
  const changed = source.replace('(λ😀 x))', '(void (λ😀 x)))');
  p.forget(file); await p.change(file, changed, 2); await p.expectDiagnostics(file, false);
  const nested = { line: 1, character: changed.split('\n')[1].lastIndexOf('λ😀') + 1 };
  assert.doesNotMatch(text(await p.request('hover', file, { position: nested })), /\*\*Tail position\*\*/);
  p.forget(file); await p.change(file, source + '(broken', 3); await p.expectDiagnostics(file, true);
  assert.doesNotMatch(text(await p.request('hover', file, { position: call })), /\*\*Tail position\*\*/);
  await p.close(file); p.forget(file); await p.open(file, changed, 1); await p.expectDiagnostics(file, false);
  assert.doesNotMatch(text(await p.request('hover', file, { position: nested })), /\*\*Tail position\*\*/);
});

test('macro expansion supplies tail facts without guessing from source spelling', { timeout: 120000 }, async t => {
  const p = await languageServer(t);
  const source = '#lang racket/base\n(define-syntax-rule (finish e) e)\n(define (f x) (finish (f x)))\n(define (g x) (+ 1 (g x)))\n';
  await p.open('macro.rkt', source); await p.expectDiagnostics('macro.rkt', false);
  const tail = { line: 2, character: source.split('\n')[2].lastIndexOf('(f x)') + 1 };
  const argument = { line: 3, character: source.split('\n')[3].lastIndexOf('(g x)') + 1 };
  assert.match(text(await p.request('hover', 'macro.rkt', { position: tail })), /\*\*Tail position\*\*/);
  assert.doesNotMatch(text(await p.request('hover', 'macro.rkt', { position: argument })), /\*\*Tail position\*\*/);
});

test('existing import diagnostics, alias navigation and Outline use the same language server', { timeout: 120000 }, async t => {
  const p = await languageServer(t);
  p.write('library λ.rkt', '#lang racket/base\n(provide twice)\n(define (twice x) (* x 2))\n');
  const source = '#lang racket/base\n(require racket/list (rename-in (file "library λ.rkt") [twice double]))\n(define (answer x) (double x))\n';
  p.write('consumer.rkt', source); await p.open('consumer.rkt', source); await p.expectDiagnostics('consumer.rkt', false);
  const warnings = p.diagnostics.get(uri(p.filename('consumer.rkt')));
  const unused = warnings.find(d => d.message === 'unused require'); assert.ok(unused, JSON.stringify(warnings));
  assert.equal(unused.range.start.line, 1);
  assert.equal(source.split('\n')[1].slice(unused.range.start.character, unused.range.end.character), 'racket/list');
  const imported = position(source, '(double x)');
  const definition = await p.request('definition', 'consumer.rkt', { position: imported });
  assert.equal(definition.uri, uri(p.filename('library λ.rkt'))); assert.equal(definition.range.start.line, 2);
  assert.match(text(await p.request('hover', 'consumer.rkt', { position: imported })), /binding occurrences/);
  const symbols = await p.request('documentSymbol', 'consumer.rkt'); assert.ok(symbols.some(s => s.name === 'answer'));
  p.forget('consumer.rkt'); await p.change('consumer.rkt', source + '(first (list 1 2))\n', 2); await p.expectDiagnostics('consumer.rkt', false);
  assert.ok(!p.diagnostics.get(uri(p.filename('consumer.rkt'))).some(d => d.message === 'unused require'));
  assert.match(text(await p.request('hover', 'consumer.rkt', { position: { line: 3, character: 2 } })), /imported from/);
});

test('UTF-16 definition, highlights, diagnostics and incremental edits agree on astral characters', { timeout: 120000 }, async t => {
  const p = await languageServer(t), file = 'unicode.rkt';
  const source = '#lang racket/base\n(define 😀 1) (list 😀 😀)\n';
  p.write(file, source); await p.open(file, source); await p.expectDiagnostics(file, false);
  const line = source.split('\n')[1], call = { line: 1, character: line.lastIndexOf('😀') };
  const definition = await p.request('definition', file, { position: call });
  assert.deepEqual(definition.range, { start: { line: 1, character: 8 }, end: { line: 1, character: 10 } });
  const encoded = (await p.request('semanticTokens/full', file)).data;
  let row = 0, column = 0; const tokens = [];
  for (let i = 0; i < encoded.length; i += 5) {
    row += encoded[i]; column = encoded[i] ? encoded[i + 1] : column + encoded[i + 1];
    tokens.push({ row, column, length: encoded[i + 2], text: source.split('\n')[row].slice(column, column + encoded[i + 2]) });
  }
  assert.equal(tokens.filter(token => token.text === '😀' && token.length === 2).length, 3, JSON.stringify(tokens));
  const range = { start: call, end: { line: 1, character: call.character + 2 } };
  p.forget(file);
  await p.connection.sendNotification('textDocument/didChange', {
    textDocument: { uri: uri(p.filename(file)), version: 2 }, contentChanges: [{ range, text: 'missing' }]
  });
  await p.expectDiagnostics(file, true);
  const diagnostic = p.diagnostics.get(uri(p.filename(file))).find(d => /missing/.test(d.message));
  assert.deepEqual(diagnostic.range, { start: call, end: { line: 1, character: call.character + 7 } });
  p.forget(file);
  await p.connection.sendNotification('textDocument/didChange', {
    textDocument: { uri: uri(p.filename(file)), version: 3 }, contentChanges: [{ range: diagnostic.range, text: '😀' }]
  });
  await p.expectDiagnostics(file, false);
  assert.deepEqual((await p.request('definition', file, { position: call })).range, definition.range);
});
