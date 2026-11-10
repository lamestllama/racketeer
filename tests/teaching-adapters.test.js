// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const { project, edited } = require('./workspace-index-project');

for (const level of ['bsl', 'isl+', 'asl', 'bsl+', 'isl']) {
  test(`${level} workspace protocol preserves component edits and refuses reserved names and capture`, async t => {
    const p = await project(t);
    for (const [revision, ending] of ['\n', '\r\n'].entries()) {
      const text = (`#lang htdp/${level}\n(define-struct point (x y))\n` +
        '(define (shift n) (if (zero? n) 0 (shift (sub1 n))))\n' +
        '(define sample (make-point 3 4))\n(point-x sample)\n(shift 2) ; 😀\n').replaceAll('\n', ending);
      p.write('teaching.rkt', text);
      const key = p.open('teaching.rkt', text, revision + 1);
      await p.update();
      const field = { line: 1, character: 22 }, fun = { line: 2, character: 9 };
      assert.deepEqual(await p.rename(key, undefined, field), {
        start: { line: 1, character: 22 }, end: { line: 1, character: 23 }
      });
      const result = await p.rename(key, 'u', field);
      assert.deepEqual(Object.keys(result.changes), [key]);
      assert.equal(edited(text, result.changes[key]), text.replace('(x y)', '(u y)').replace('point-x', 'point-u'));
      const name = revision ? '偏移' : 'offset';
      const renamed = await p.rename(key, name, fun);
      assert.equal(edited(text, renamed.changes[key]), text.replaceAll('shift', name));
      for (const reserved of ['if', 'n']) await assert.rejects(p.rename(key, reserved, fun));
      assert.equal(fs.readFileSync(p.filename('teaching.rkt'), 'utf8'), text);
    }
  });
}

for (const level of ['isl+', 'asl', 'isl']) {
  test(`${level} workspace protocol keeps exact local field navigation and edits beside an outer structure`, async t => {
    const p = await project(t);
    p.settings.enabled = false;
    const range = (line, character, length) => ({ start: { line, character }, end: { line, character: character + length } });
    for (const [revision, ending] of ['\n', '\r\n'].entries()) {
      const text = (`#lang htdp/${level}\n(define-struct point (x))\n(define (outer n)\n` +
        '  (local [(define-struct point (x))\n          (define p (make-point n))]\n' +
        '    (point-x p)))\n(outer 3)\n(point-x (make-point 1)) ; 😀\n').replaceAll('\n', ending);
      p.write('local.rkt', text);
      const key = p.open('local.rkt', text, revision + 1);
      await p.update();
      const params = { textDocument: { uri: key }, position: { line: 5, character: 11 } };
      assert.deepEqual(await p.request('textDocument/definition', params), [{ uri: key, range: range(3, 32, 1) }]);
      assert.deepEqual(await p.request('textDocument/documentHighlight', params),
        [range(3, 32, 1), range(5, 11, 1)].map(value => ({ range: value })));
      assert.deepEqual(await p.references(key, params.position, true),
        [range(3, 32, 1), range(5, 11, 1)].map(value => ({ uri: key, range: value })));
      const result = await p.rename(key, 'u', { line: 3, character: 32 });
      assert.deepEqual(result.changes[key], [
        { range: range(3, 32, 1), newText: 'u' }, { range: range(5, 11, 1), newText: 'u' }
      ]);
      assert.equal(fs.readFileSync(p.filename('local.rkt'), 'utf8'), text);
    }
  });
}
