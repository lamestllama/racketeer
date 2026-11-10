// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const { project, uri } = require('./workspace-index-project');
const range = (line, character, length) => ({ start: { line, character }, end: { line, character: character + length } });
const query = (p, method, key, line, character) => p.request(`textDocument/${method}`, {
  textDocument: { uri: key }, position: { line, character }
});
const local = '#lang racket/base\n(define (f x) (+ x x))\n(f 1)\n';

for (const enabled of [true, false]) test(`document navigation avoids discovery with scanning=${enabled}`, async t => {
  const p = await project(t, { RACKETEER_INDEX_WORKERS: '1' });
  p.settings.enabled = enabled;
  p.write('broken.rkt', '#lang racket/base\nmissing\n');
  const key = p.open('local.rkt', local); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 1, 17), [{ uri: key, range: range(1, 11, 1) }]);
  assert.deepEqual(await query(p, 'documentHighlight', key, 1, 17),
    [11, 17, 19].map(start => ({ range: range(1, start, 1) })));
  assert.deepEqual(await p.references(key, { line: 1, character: 17 }, true),
    [11, 17, 19].map(start => ({ uri: key, range: range(1, start, 1) })));
  assert.equal(p.progress.length, 0, 'Document requests never start discovery');
  assert.ok(!p.notifications.some(status => ['indexing', 'partial', 'ready'].includes(status.state)));
});

test('module references with scanning off leave the answer to the language server', async t => {
  const p = await project(t);
  p.settings.enabled = false;
  const key = p.open('module.rkt', '#lang racket/base\n(provide value)\n(define value 1)\nvalue\n'); await p.update();
  assert.equal(await p.references(key, { line: 3, character: 1 }, true), null);
});

test('definition follows unsaved imports outside workspace roots', async t => {
  const p = await project(t);
  p.settings.enabled = false;
  const outside = fs.mkdtempSync(path.join(path.dirname(p.directory), 'navigation-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'target.rkt');
  fs.writeFileSync(target, '#lang racket/base\n(provide old)\n(define old 0)\n');
  const text = '#lang racket/base\n(provide value)\n\n(define value 1)\n';
  const targetUri = p.open(uri(target), text);
  const consumer = `#lang racket/base\n(require (file ${JSON.stringify(target)}))\nvalue\n`;
  const key = p.open('consumer.rkt', consumer); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 2, 2), [{ uri: targetUri, range: range(3, 8, 5) }]);
  p.open(targetUri, text.replace('\n\n(define', '\n\n\n(define'), 2); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 2, 2), [{ uri: targetUri, range: range(4, 8, 5) }]);
  fs.writeFileSync(target, text);
  await p.update();
  const outsideKey = p.open(uri(path.join(outside, 'consumer.rkt')), consumer); await p.update();
  assert.deepEqual(await query(p, 'definition', outsideKey, 2, 2), [{ uri: targetUri, range: range(4, 8, 5) }]);
  assert.match(fs.readFileSync(target, 'utf8'), /define value/);
  assert.equal(p.progress.length, 0);
});

test('shared identities retain all distinct definition locations', async t => {
  const p = await project(t); p.settings.enabled = false;
  const model = '#lang racket/base\n(provide (struct-out a))\n(struct a ())\n';
  p.write('model.rkt', model);
  const text = `#lang racket/base
(require "model.rkt" (for-syntax racket/base racket/syntax))
(define-syntax (both stx)
  (syntax-case stx ()
    [(_ name)
     (with-syntax ([other (syntax-property (format-id #'name "struct:a" #:source #'name) 'original-for-check-syntax #t)])
       #'(list name other))]))
(let ([a? 7]) (both a?) a? struct:a)
`;
  const key = p.open('consumer.rkt', text); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 7, 20), [
    { uri: key, range: range(7, 7, 2) }, { uri: uri(p.filename('model.rkt')), range: range(2, 8, 1) }
  ]);
  assert.deepEqual(await query(p, 'documentHighlight', key, 7, 20),
    [range(7, 7, 2), range(7, 20, 2), range(7, 24, 2), range(7, 27, 8)].map(range => ({ range })));
});

test('macro-generated names use the default binding graph', async t => {
  const p = await project(t); p.settings.enabled = false;
  const generated = `#lang racket/base
(require (for-syntax racket/base racket/syntax))
(define-syntax (pair stx)
  (syntax-case stx () [(_ name)
    (with-syntax ([other (format-id #'name "~a-alt" #'name #:source #'name)])
      #'(begin (define name 1) (define other 2)))]))
(pair value)
value-alt
`;
  const macro = p.open('macro.rkt', generated); await p.update();
  assert.deepEqual(await query(p, 'definition', macro, 7, 2), [{ uri: macro, range: range(6, 6, 5) }]);
});

test('struct-generated names resolve their shared definition', async t => {
  const p = await project(t); p.settings.enabled = false;
  const model = '#lang racket/base\n(provide (struct-out a))\n(struct a ())\n';
  const shape = p.open('shape.rkt', model + 'a?\nstruct:a\n'); await p.update();
  for (const line of [3, 4]) assert.deepEqual(await query(p, 'definition', shape, line, 0),
    [{ uri: shape, range: range(2, 8, 1) }]);
});

test('untitled navigation preserves the real URI and lifetime without creating a file', async t => {
  const p = await project(t); p.settings.enabled = false;
  const before = fs.readdirSync(p.directory).sort();
  const memoryPaths = () => [...new Set([os.tmpdir(), path.parse(os.tmpdir()).root])]
    .flatMap(directory => fs.readdirSync(directory).filter(name => name.startsWith('racketeer-memory-'))
      .flatMap(name => [path.join(directory, name),
        ...fs.readdirSync(path.join(directory, name)).map(file => path.join(directory, name, file))])).sort();
  const memoryBefore = memoryPaths();
  const key = p.open('untitled:Navigation-1?cell=2#part', local); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 1, 17), [{ uri: key, range: range(1, 11, 1) }]);
  assert.deepEqual(await p.references(key, { line: 1, character: 17 }, false),
    [17, 19].map(start => ({ uri: key, range: range(1, start, 1) })));
  p.documents.delete(key); await p.update(true);
  p.open(key, local.replace('(define', '\n(define'), 1); await p.update(true);
  assert.deepEqual(await query(p, 'definition', key, 2, 17), [{ uri: key, range: range(2, 11, 1) }]);
  p.open(key, '#lang racket/base\n(require "definition.rkt")\nsquare\n', 2); await p.update();
  assert.equal(await query(p, 'definition', key, 2, 1), null, 'The in-memory path supplies no import directory');
  assert.deepEqual(fs.readdirSync(p.directory).sort(), before);
  assert.doesNotMatch(p.diagnostics(), /racketeer-memory/);
  assert.deepEqual(memoryPaths(), memoryBefore);
});

test('a failed source returns null while an analysed empty answer stays empty', async t => {
  const p = await project(t); p.settings.enabled = false;
  const key = p.open('broken.rkt', '#lang racket/base\n('); await p.update();
  for (const method of ['definition', 'documentHighlight']) assert.equal(await query(p, method, key, 1, 0), null);
  p.open(key, '#lang racket/base\nmissing\n', 2); await p.update();
  assert.equal(await query(p, 'definition', key, 1, 0), null);
  p.open(key, '#lang racket/base\n42\n', 3); await p.update();
  for (const method of ['definition', 'documentHighlight']) assert.deepEqual(await query(p, method, key, 1, 0), []);
  assert.deepEqual(await p.references(key, { line: 1, character: 0 }), []);
  p.open(key, '', 4); await p.update();
  for (const method of ['definition', 'documentHighlight']) assert.deepEqual(await query(p, method, key, 0, 0), []);
  assert.deepEqual(await p.references(key, { line: 0, character: 0 }), []);
});

for (const header of ['#lang racket/base', '#lang htdp/bsl', '']) test(`default navigation for reader ${header || 'without a header'}`, async t => {
  const p = await project(t); p.settings.enabled = false;
  const key = p.open('reader.rkt', `${header}\n(define (f x) x)\n`); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 1, 14), [{ uri: key, range: range(1, 11, 1) }]);
});


test('an unknown language uses the default binding graph', async t => {
  const p = await project(t); p.settings.enabled = false;
  p.write('custom.rkt', '#lang racket/base\n(require racket/base)\n(provide (all-from-out racket/base))\n');
  const key = p.open('unknown.rkt', '#lang s-exp "custom.rkt"\n(define (f x) x)\n'); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 1, 14), [{ uri: key, range: range(1, 11, 1) }]);
});

test('a blocked request is retired by same-version close and reopen', async t => {
  const p = await project(t); p.settings.enabled = false;
  const entered = p.filename('entered');
  const source = `#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ${JSON.stringify(entered)} void) (sync never-evt))\n`;
  const key = p.open('untitled:Lifetime', source); await p.update();
  let settled;
  const pending = query(p, 'definition', key, 1, 0).then(value => (settled = { value }), error => (settled = { error }));
  await until(() => { assert.equal(settled, undefined, JSON.stringify(settled)); return fs.existsSync(entered); },
    'document expansion reached its barrier');
  p.documents.delete(key); await p.update(true);
  p.open(key, local, 1); await p.update(true);
  const retired = await pending;
  assert.ok([-32800, -32801].includes(retired.error?.code), JSON.stringify(retired));
  assert.deepEqual(await query(p, 'definition', key, 1, 17), [{ uri: key, range: range(1, 11, 1) }]);
});


test('predicted navigation includes template occurrences without changing rename evidence', async t => {
  const p = await project(t); p.settings.enabled = false;
  const text = "#lang racket/base\n(define value 7)\n(define quoted #'value)\n(define (answer) (+ value 1))\n";
  const key = p.open('predicted.rkt', text); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 2, 17), [{ uri: key, range: range(1, 8, 5) }]);
  assert.deepEqual(await query(p, 'documentHighlight', key, 2, 17),
    [range(1, 8, 5), range(2, 17, 5), range(3, 20, 5)].map(range => ({ range })));
});


test('an unopened imported definition needs no project pass', async t => {
  const p = await project(t); p.settings.enabled = false;
  p.write('target.rkt', '#lang racket/base\n(provide value)\n(define value 1)\n');
  const key = p.open('consumer.rkt', '#lang racket/base\n(require "target.rkt")\nvalue\n'); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 2, 2),
    [{ uri: uri(p.filename('target.rkt')), range: range(2, 8, 5) }]);
  assert.equal(p.progress.length, 0);
});

test('an oversized definition target falls back while scanning keeps its size limit', async t => {
  const p = await project(t); p.settings.enabled = false;
  p.write('target.rkt', '#lang racket/base\n(provide value)\n(define value 1)\n;' + ' '.repeat(1048576));
  const key = p.open('consumer.rkt', '#lang racket/base\n(require "target.rkt")\nvalue\n'); await p.update();
  assert.equal(await query(p, 'definition', key, 2, 2), null);
  assert.equal(p.progress.length, 0);
  p.settings.enabled = true; await p.update();
  await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.equal(p.notifications.at(-1).failures, 1);
});

test('raised values during reading and expansion fall back for every navigation operation', async t => {
  const p = await project(t); p.settings.enabled = false;
  p.write('reader.rkt', '#lang racket/base\n(provide (rename-out [source-read read-syntax]))\n(define (source-read src in) (raise \'broken))\n');
  for (const text of ['#reader "reader.rkt"\n',
    "#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (raise 'broken))\n(define (f x) x)\n"]) {
    const key = p.open('broken.rkt', text); await p.update();
    for (const method of ['definition', 'documentHighlight', 'references']) {
      assert.equal(await query(p, method, key, 3, 14), null);
    }
  }
});


test('an untitled save location supplies only its real import directory', async t => {
  const p = await project(t); p.settings.enabled = false;
  p.write('draft.rkt', 'preserve this file');
  p.write('target.rkt', '#lang racket/base\n(provide value)\n(define value 1)\n');
  const key = p.open(uri(p.filename('draft.rkt')).replace(/^file:/, 'untitled:'),
    '#lang racket/base\n(require "target.rkt")\n(define answer value)\nanswer\n'); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 2, 16),
    [{ uri: uri(p.filename('target.rkt')), range: range(2, 8, 5) }]);
  assert.deepEqual(await query(p, 'definition', key, 3, 2), [{ uri: key, range: range(2, 8, 6) }]);
  assert.equal(fs.readFileSync(p.filename('draft.rkt'), 'utf8'), 'preserve this file');
});


test('untitled buffers stay outside the module-reference pass', async t => {
  const p = await project(t);
  p.open('untitled:Unrelated', '#lang racket/base\nmissing\n'); await p.update();
  const references = await p.references(p.origin, { line: 2, character: 10 }, false);
  assert.ok(references.some(location => location.uri === uri(p.filename('uses.rkt'))));
  assert.equal(p.notifications.at(-1).state, 'ready');
  assert.equal(p.notifications.at(-1).total, 2);
  assert.ok(references.every(location => location.uri.startsWith('file:')));
});

test('outside open buffers remain navigable without joining the workspace rename pass', async t => {
  const p = await project(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  p.open(uri(path.join(outside, 'broken.rkt')), '#lang racket/base\nmissing\n');
  const target = p.open(uri(path.join(outside, 'target.rkt')), '#lang racket/base\n(provide value)\n(define value 1)\n');
  const key = p.open(uri(path.join(outside, 'consumer.rkt')),
    '#lang racket/base\n(require "target.rkt")\nvalue\n'); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 2, 2), [{ uri: target, range: range(2, 8, 5) }]);
  const result = await p.rename(p.origin, 'squared');
  assert.deepEqual(Object.keys(result.changes).sort(), [p.origin, uri(p.filename('uses.rkt'))].sort());
  assert.deepEqual(p.notifications.at(-1), { state: 'ready', indexed: 2, total: 2, failures: 0 });
});

test('document positions use UTF-16 and clamp at the requested line end', async t => {
  const p = await project(t); p.settings.enabled = false;
  const key = p.open('unicode.rkt', '#lang racket/base\r\n(define (f 😀) 😀)\r\n(f 1)\r\n'); await p.update();
  assert.deepEqual(await query(p, 'definition', key, 1, 16), [{ uri: key, range: range(1, 11, 2) }]);
  assert.deepEqual(await query(p, 'documentHighlight', key, 1, 16),
    [range(1, 11, 2), range(1, 15, 2)].map(range => ({ range })));
  assert.deepEqual(await query(p, 'definition', key, 1, 1000), []);
});


test('a document request takes the occupied slot without waiting for a workspace file', async t => {
  const p = await project(t, { RACKETEER_INDEX_WORKERS: '1' });
  p.settings.timeoutSeconds = 5;
  const entered = p.filename('entered'), released = p.filename('released');
  p.write('a-blocked.rkt', `#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate void) (let wait () (unless (file-exists? ${JSON.stringify(released)}) (sleep 0.01) (wait))))\n`);
  const key = p.open('z-local.rkt', local); await p.update();
  const pending = p.references(p.origin).then(locations => ({ locations }), error => ({ error }));
  await until(() => fs.existsSync(entered), 'workspace expansion reached its barrier');
  try {
    assert.deepEqual(await query(p, 'definition', key, 1, 17), [{ uri: key, range: range(1, 11, 1) }]);
  } finally { p.write('released', ''); }
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.ok(result.locations.some(location => location.uri === uri(p.filename('uses.rkt'))));
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.equal(p.notifications.at(-1).failures, 0);
});

test('finite pass files finish while navigation requests continue arriving', async t => {
  const p = await project(t, { RACKETEER_INDEX_WORKERS: '1' });
  p.settings.timeoutSeconds = 5;
  for (const name of ['a', 'b']) {
    p.write(`${name}-slow.rkt`, `#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ${JSON.stringify(p.filename(`${name}-entered`))} #:exists 'append (lambda (out) (displayln 'enter out))) (sleep 1.5) (call-with-output-file ${JSON.stringify(p.filename(`${name}-finished`))} #:exists 'truncate void))\n`);
  }
  const key = p.open('z-local.rkt', local); await p.update();
  let finished = false;
  const pending = p.references(p.origin).then(locations => { finished = true; return locations; });
  await until(() => fs.existsSync(p.filename('a-entered')), 'finite workspace expansion entered');
  for (let i = 0; i < 16 && !finished; i++) {
    assert.deepEqual(await query(p, 'definition', key, 1, 17), [{ uri: key, range: range(1, 11, 1) }]);
  }
  assert.ok(finished, 'References finish while navigation continues');
  assert.ok((await pending).some(location => location.uri === uri(p.filename('uses.rkt'))));
  for (const name of ['a', 'b']) {
    assert.ok(fs.existsSync(p.filename(`${name}-finished`)));
    assert.ok(fs.readFileSync(p.filename(`${name}-entered`), 'utf8').trim().split('\n').length <= 2,
      'A pass operation is preempted at most once');
  }
  assert.deepEqual(p.notifications.at(-1), { state: 'ready', indexed: 5, total: 5, failures: 0 });
});

test('untitled worker failures report the real URI without exposing the in-memory path', { skip: process.platform === 'win32' }, async t => {
  const p = await project(t); p.settings.enabled = false;
  const key = p.open('untitled:Failed-Worker', `#lang racket/base
(require (for-syntax racket/base ffi/unsafe))
(begin-for-syntax
  (call-with-output-file "/dev/stderr" #:exists 'append
    (lambda (out) (displayln (syntax-source #'probe) out) (flush-output out)))
  ((get-ffi-obj "_exit" #f (_fun _int -> _void)) 7))
`); await p.update();
  await assert.rejects(query(p, 'definition', key, 1, 0), error => {
    assert.equal(error.code, -32803);
    assert.match(error.message, /worker exited with status 7/);
    assert.ok(error.message.includes(key));
    assert.doesNotMatch(error.message, /racketeer-memory-/);
    return true;
  });
  await until(() => p.diagnostics().includes('worker exited with status 7'), 'worker failure reported');
  assert.doesNotMatch(p.diagnostics(), /racketeer-memory-/);
});

test('an imported module identity in an untitled buffer joins the workspace pass', async t => {
  const p = await project(t);
  const key = p.open('untitled:Imported', `#lang racket/base\n(require (file ${JSON.stringify(p.filename('definition.rkt'))}))\n(square 3)\n`);
  await p.update();
  const locations = await p.references(key, { line: 2, character: 2 }, true);
  assert.ok(locations.some(location => location.uri === key && location.range.start.line === 2));
  assert.ok(locations.some(location => location.uri === uri(p.filename('uses.rkt'))));
  assert.ok(locations.some(location => location.uri === p.origin && location.range.start.line === 2));
  assert.equal(p.notifications.at(-1).state, 'ready');
  assert.equal(p.notifications.at(-1).total, 2);
});

test('a changed descriptor is ContentModified rather than a source fallback', async t => {
  const p = await project(t); p.settings.enabled = false;
  fs.mkdirSync(p.filename('.racketeer'));
  const descriptor = '.racketeer/language-adapters.rktd';
  const profile = expand => `((profile (match (language racket/base)) (editor (expand? ${expand}))))`;
  p.write(descriptor, profile('#t'));
  const entered = p.filename('entered'), released = p.filename('released');
  const key = p.open('policy.rkt', `#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate void) (let wait () (unless (file-exists? ${JSON.stringify(released)}) (sleep 0.01) (wait))))\n(define (f x) x)\n`);
  await p.update();
  let settled;
  const pending = query(p, 'definition', key, 3, 14).then(value => (settled = { value }), error => (settled = { error }));
  await until(() => { assert.equal(settled, undefined, JSON.stringify(settled)); return fs.existsSync(entered); },
    'descriptor was selected before expansion');
  p.write(descriptor, profile('#f')); p.write('released', '');
  assert.equal((await pending).error?.code, -32801);
  assert.deepEqual(await query(p, 'definition', key, 3, 14), []);
  p.write(descriptor, profile('#t'));
  assert.deepEqual(await query(p, 'definition', key, 3, 14), [{ uri: key, range: range(3, 11, 1) }]);
});
