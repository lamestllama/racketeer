// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const test = require('./support/node-test');
const { languageServer } = require('./language-server-project');
const { project, uri } = require('./workspace-index-project');
const range = (line, character, length) => ({ start: { line, character }, end: { line, character: character + length } });
const struct = '#lang racket/base\n(provide (struct-out a))\n(struct a ())\n';
const macro = `#lang racket/base
(require (for-syntax racket/base racket/syntax))
(provide x x-alt)
(define-syntax (define-pair stx)
  (syntax-case stx ()
    [(_ name)
     (with-syntax ([other (format-id #'name "~a-alt" #'name #:source #'name)])
       #'(begin (define name 1) (define other 2)))]))
(define-pair x)
`;
const cases = [
  ['struct predicate', struct, 'a?', range(2, 8, 1)],
  ['struct descriptor', struct, 'struct:a', range(2, 8, 1)],
  ['struct constructor', struct, 'a', range(2, 8, 1)],
  ['macro original name', macro, 'x', range(8, 13, 1)],
  ['macro generated name', macro, 'x-alt', range(8, 13, 1)]
];
for (const family of ['struct', 'macro']) {
  const selected = cases.filter(([description]) => description.startsWith(family));
  test(`shared binding protocol: ${family}`, async t => {
    const p = await languageServer(t);
    const model = selected[0][1];
    const names = selected.map(([, , name]) => name);
    const consumer = '#lang racket/base\n(require "model.rkt")\n' + names.map(name => `${name}\n${name}\n`).join('');
    p.write('model.rkt', model); p.write('consumer.rkt', consumer);
    await p.open('consumer.rkt', consumer); await p.expectDiagnostics('consumer.rkt', false);
    const failures = [];
    for (const [index, [description, , name, definition]] of selected.entries()) {
      const line = 2 + index * 2, position = { line, character: 0 };
      const expected = [range(line, 0, name.length), range(line + 1, 0, name.length)];
      async function check(feature, verify, extra = {}) {
        try { verify(await p.request(feature, 'consumer.rkt', { position, ...extra })); }
        catch (error) { failures.push(`${description} ${feature}: ${error.message}`); }
      }
      await check('definition', actual => assert.deepEqual(actual, { uri: uri(p.filename('model.rkt')), range: definition }));
      await check('references', actual => assert.deepEqual(actual.map(location => location.range), expected), { context: { includeDeclaration: false } });
      await check('documentHighlight', actual => assert.deepEqual(actual.map(highlight => highlight.range), expected));
      // The workspace server owns rename for imported names.
      await check('rename', actual => assert.equal(actual, null), { newName: 'renamed' });
    }
    const local = model + names.map(name => `${name}\n${name}\n`).join('');
    const firstLine = model.split('\n').length - 1;
    await p.open('model.rkt', local); await p.expectDiagnostics('model.rkt', false);
    for (const [index, [description, , name, definition]] of selected.entries()) {
      const line = firstLine + index * 2, position = { line, character: 0 };
      const expected = [range(line, 0, name.length), range(line + 1, 0, name.length)];
      try {
        assert.deepEqual(await p.request('definition', 'model.rkt', { position }), { uri: uri(p.filename('model.rkt')), range: definition });
        const references = await p.request('references', 'model.rkt', { position, context: { includeDeclaration: false } });
        assert.deepEqual(references.filter(location => location.uri === uri(p.filename('model.rkt')) && location.range.start.line >= firstLine).map(location => location.range), expected);
        const highlights = await p.request('documentHighlight', 'model.rkt', { position });
        assert.deepEqual(highlights.filter(highlight => highlight.range.start.line >= firstLine).map(highlight => highlight.range), expected);
        assert.equal(await p.request('rename', 'model.rkt', { position, newName: 'renamed' }), null);
        assert.equal(await p.request('prepareRename', 'model.rkt', { position }), null);
      } catch (error) { failures.push(`${description} local queries: ${error.message}`); }
    }
    assert.deepEqual(failures, []);
    assert.equal(fs.readFileSync(p.filename('model.rkt'), 'utf8'), model);
  });
  test(`shared binding workspace: ${family}`, async t => {
    const p = await project(t), model = selected[0][1];
    p.documents.clear(); p.write('definition.rkt', model);
    const names = selected.map(([, , name]) => name);
    const consumer = '#lang racket/base\n(require "definition.rkt")\n' + names.map(name => `${name}\n${name}\n`).join('');
    p.write('uses.rkt', consumer);
    const key = p.open('uses.rkt', consumer);
    await p.update();
    const failures = [];
    for (const [index, [description, , name, definition]] of selected.entries()) {
      const line = 2 + index * 2, position = { line, character: 0 };
      try {
        const locations = await p.references(key, position, true);
        const expected = [
          { uri: key, range: range(line, 0, name.length) },
          { uri: key, range: range(line + 1, 0, name.length) },
          { uri: p.origin, range: definition }
        ];
        for (const location of expected) assert.ok(locations.some(actual => isDeepStrictEqual(actual, location)), JSON.stringify({ location, locations }));
        assert.deepEqual(locations.filter(location => location.uri === key), expected.slice(0, 2));
        assert.deepEqual(await p.rename(key, undefined, position), range(line, 0, name.length));
        // A family member cannot be changed independently of its shared binder.
        await assert.rejects(p.rename(key, 'renamed', position), /Cannot analyse|another binding|binding|capture/);
      } catch (error) { failures.push(`${description}: ${error.message}`); }
    }
    assert.deepEqual(failures, []);
    assert.equal(fs.readFileSync(p.filename('definition.rkt'), 'utf8'), model);
    assert.equal(fs.readFileSync(p.filename('uses.rkt'), 'utf8'), consumer);
  });
}

const sharedConsumer = `#lang racket/base
(require "model.rkt" (for-syntax racket/base racket/syntax))
(define-syntax (both stx)
  (syntax-case stx ()
    [(_ name)
     (with-syntax ([other (syntax-property (format-id #'name "struct:a" #:source #'name) 'original-for-check-syntax #t)])
       #'(list name other))]))
(both a?)
a?
struct:a
`;

test('one written imported use keeps both identities throughout the protocol', async t => {
  const p = await languageServer(t);
  p.write('model.rkt', struct);
  const consumer = sharedConsumer;
  p.write('consumer.rkt', consumer);
  await p.open('consumer.rkt', consumer); await p.expectDiagnostics('consumer.rkt', false);
  const shared = range(7, 6, 2), predicate = range(8, 0, 2), descriptor = range(9, 0, 8);
  const location = { uri: uri(p.filename('model.rkt')), range: range(2, 8, 1) };
  assert.deepEqual(await p.request('definition', 'consumer.rkt', { position: shared.start }), [location]);
  for (const [position, expected] of [[predicate.start, [shared, predicate]], [descriptor.start, [shared, descriptor]], [shared.start, [shared, predicate, descriptor]]]) {
    const references = await p.request('references', 'consumer.rkt', { position, context: { includeDeclaration: false } });
    assert.deepEqual(references.filter(item => item.uri === uri(p.filename('consumer.rkt'))).map(item => item.range), expected);
    assert.deepEqual((await p.request('documentHighlight', 'consumer.rkt', { position })).map(item => item.range), expected);
    assert.equal(await p.request('rename', 'consumer.rkt', { position, newName: 'renamed' }), null);
  }
});

test('workspace references and rename retain every identity at a shared use', async t => {
  const p = await project(t);
  p.documents.clear();
  p.write('definition.rkt', struct);
  const consumer = sharedConsumer.replace('"model.rkt"', '"definition.rkt"');
  p.write('uses.rkt', consumer);
  const key = p.open('uses.rkt', consumer);
  await p.update();
  const shared = range(7, 6, 2), predicate = range(8, 0, 2), descriptor = range(9, 0, 8);
  for (const [position, expected] of [[predicate.start, [shared, predicate]], [descriptor.start, [shared, descriptor]], [shared.start, [shared, predicate, descriptor]]]) {
    const locations = await p.references(key, position, true);
    assert.deepEqual(locations.filter(item => item.uri === key).map(item => item.range), expected);
    assert.equal(locations.filter(item => item.uri === p.origin && isDeepStrictEqual(item.range, range(2, 8, 1))).length, 1);
  }
  await assert.rejects(p.rename(key, undefined, shared.start), /more than one binding/);
  await assert.rejects(p.rename(key, 'renamed', shared.start), /more than one binding/);
});

test('mixed local and imported shared use refuses rename and prepareRename', async t => {
  const p = await languageServer(t);
  p.write('model.rkt', struct);
  const consumer = sharedConsumer.replace('(both a?)', '(define a? 7)\n(both a?)');
  p.write('consumer.rkt', consumer);
  await p.open('consumer.rkt', consumer); await p.expectDiagnostics('consumer.rkt', false);
  const position = { line: 8, character: 6 };
  assert.equal(await p.request('rename', 'consumer.rkt', { position, newName: 'changed' }), null);
  assert.equal(await p.request('prepareRename', 'consumer.rkt', { position }), null);
});

test('shared lexical and imported use retains both owners in references and highlights', async t => {
  const p = await languageServer(t);
  p.write('model.rkt', struct);
  const consumer = sharedConsumer.replace('(both a?)\na?\nstruct:a', '(let ([a? 7]) (both a?) a? struct:a)');
  p.write('consumer.rkt', consumer);
  await p.open('consumer.rkt', consumer); await p.expectDiagnostics('consumer.rkt', false);
  const position = { line: 7, character: 20 };
  const expected = [range(7, 20, 2), range(7, 24, 2), range(7, 27, 8)];
  const references = await p.request('references', 'consumer.rkt', { position, context: { includeDeclaration: false } });
  assert.deepEqual(references.filter(item => item.uri === uri(p.filename('consumer.rkt'))).map(item => item.range), expected);
  assert.deepEqual((await p.request('documentHighlight', 'consumer.rkt', { position })).map(item => item.range), [range(7, 7, 2), ...expected]);
  assert.deepEqual(await p.request('definition', 'consumer.rkt', { position }), [
    { uri: uri(p.filename('consumer.rkt')), range: range(7, 7, 2) },
    { uri: uri(p.filename('model.rkt')), range: range(2, 8, 1) }
  ]);
  assert.equal(await p.request('rename', 'consumer.rkt', { position, newName: 'changed' }), null);
  assert.equal(await p.request('prepareRename', 'consumer.rkt', { position }), null);
});

test('mixed module local and imported shared use resolves every definition', async t => {
  const p = await languageServer(t);
  p.write('model.rkt', struct);
  const consumer = sharedConsumer.replace('(both a?)', '(define a? 7)\n(both a?)');
  p.write('consumer.rkt', consumer);
  await p.open('consumer.rkt', consumer); await p.expectDiagnostics('consumer.rkt', false);
  const definitions = await p.request('definition', 'consumer.rkt', { position: { line: 8, character: 6 } });
  assert.deepEqual(definitions, [
    { uri: uri(p.filename('consumer.rkt')), range: range(7, 8, 2) },
    { uri: uri(p.filename('model.rkt')), range: range(2, 8, 1) }
  ]);
});

test('shared local use includes every declaration in references and highlights', async t => {
  const p = await languageServer(t);
  const consumer = sharedConsumer
    .replace('"model.rkt" ', '')
    .replace('"struct:a"', '"x-alt"')
    .replace('(both a?)\na?\nstruct:a', '(define x 1)\n(define x-alt 2)\n(both x)\nx\nx-alt');
  p.write('consumer.rkt', consumer);
  await p.open('consumer.rkt', consumer); await p.expectDiagnostics('consumer.rkt', false);
  const position = { line: 9, character: 6 };
  const expected = [range(7, 8, 1), range(8, 8, 5), range(9, 6, 1), range(10, 0, 1), range(11, 0, 5)];
  const references = await p.request('references', 'consumer.rkt', { position, context: { includeDeclaration: true } });
  assert.deepEqual(references.map(item => item.range), expected);
  assert.deepEqual((await p.request('documentHighlight', 'consumer.rkt', { position })).map(item => item.range), expected);
});
