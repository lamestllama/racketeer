// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const { languageServer } = require('./language-server-project');
const content = h => typeof h?.contents === 'string' ? h.contents : h?.contents?.value || '';
const point = (source, needle, offset = 0) => {
  const index = source.indexOf(needle); assert.notEqual(index, -1);
  const lines = source.slice(0, index + offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
};

test('syntax-template predictions are distinguished from ordinary bindings and documentation', { timeout: 120000 }, async t => {
  const p = await languageServer(t), file = 'bindings.rkt';
  const source = '#lang racket/base\n(define value 7)\n(define quoted #\'value)\n(define (answer) (+ value 1))\n';
  await p.open(file, source); await p.expectDiagnostics(file, false);
  const template = point(source, "#'value", 2);
  const predicted = await p.request('hover', file, { position: template });
  assert.match(content(predicted), /\*\*Predicted binding\*\*/);
  assert.match(content(predicted), /syntax-template occurrence/);
  assert.match(content(predicted), /define value 7/);
  assert.deepEqual(predicted.range, { start: template, end: { ...template, character: template.character + 5 } });
  const ordinary = point(source, '(+ value', 3);
  assert.doesNotMatch(content(await p.request('hover', file, { position: ordinary })), /Predicted binding/);
  assert.doesNotMatch(content(await p.request('hover', file, { position: point(source, 'define value', 7) })), /Predicted binding/);
  assert.match(content(await p.request('hover', file, { position: point(source, '(+ value', 1) })), /https:\/\/docs.racket-lang.org\//);
  const definition = await p.request('definition', file, { position: ordinary });
  assert.equal(definition.range.start.line, 1);
});

test('predicted bindings follow Unicode unsaved changes, errors and document lifetimes', { timeout: 120000 }, async t => {
  const p = await languageServer(t), file = 'untitled:Bindings-λ';
  const source = '#lang racket/base\n(define λ😀 7) (define quoted #\'λ😀)\n';
  await p.open(file, source); await p.expectDiagnostics(file, false);
  const template = point(source, "#'λ😀", 2);
  const hover = await p.request('hover', file, { position: template });
  assert.match(content(hover), /Predicted binding/);
  assert.deepEqual(hover.range, { start: template, end: { ...template, character: template.character + 3 } });
  const changed = source.replace("#'λ😀", 'λ😀');
  p.forget(file); await p.change(file, changed, 2); await p.expectDiagnostics(file, false);
  const use = point(changed, 'quoted λ😀', 7);
  assert.doesNotMatch(content(await p.request('hover', file, { position: use })), /Predicted binding/);
  p.forget(file); await p.change(file, source, 3); await p.expectDiagnostics(file, false);
  assert.match(content(await p.request('hover', file, { position: template })), /Predicted binding/);
  p.forget(file); await p.change(file, source + '(broken', 4); await p.expectDiagnostics(file, true);
  assert.doesNotMatch(content(await p.request('hover', file, { position: template })), /Predicted binding/);
  await p.close(file); p.forget(file); await p.open(file, changed); await p.expectDiagnostics(file, false);
  assert.doesNotMatch(content(await p.request('hover', file, { position: use })), /Predicted binding/);
});

test('macro templates report predictions without labelling macro calls or spelling matches', { timeout: 120000 }, async t => {
  const p = await languageServer(t), file = 'macro.rkt';
  const source = '#lang racket/base\n(require (for-syntax racket/base))\n(define outer 1)\n(define-syntax (sample stx) #\'(let ([local outer]) (+ local outer)))\n(sample)\n(define quoted \'outer)\n; outer\n"outer"\n';
  await p.open(file, source); await p.expectDiagnostics(file, false);
  for (const position of [point(source, 'local outer', 6), point(source, '(+ local', 1)]) {
    assert.match(content(await p.request('hover', file, { position })), /Predicted binding/);
  }
  for (const position of [point(source, '(sample)', 1), point(source, "'outer", 1), point(source, '; outer', 2), point(source, '"outer"', 1)]) {
    assert.doesNotMatch(content(await p.request('hover', file, { position })), /Predicted binding/);
  }
});
