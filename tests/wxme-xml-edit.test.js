// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WxmeDocument, normalize } = require('../vscode/wxme-document');
const { renderEditor } = require('../vscode/wxme-editor-view');
const { decodeWxme, requestWxme } = require('../vscode/wxme-process');
const expected = require('./fixtures/wxme-xml/expected.json');
const treeRemoval = require('./support/tree-removal');
const fixture = name => path.join(__dirname, 'fixtures/wxme-xml', name + '.wxme');
const helper = path.resolve(__dirname, '../racketdap/tools/wxme-edit.rkt');
const viewer = path.resolve(__dirname, '../racketdap/tools/wxme-view.rkt');
const gui = { skip: process.env.RACKETDAP_TEST_WXME_GUI !== '1' };
const encode = (file, request) => requestWxme('racket', helper, file, request);
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxme-xml-edit-')); t.after(() => fs.rmSync(root, treeRemoval)); return root; }
function execute(file, output) {
  const result = spawnSync('racket', [file], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, output);
}

test('XML modes survive undo, removal and backup restoration with nested Unicode text', async () => {
  const file = fixture('preserve'), bytes = fs.readFileSync(file), decoded = await decodeWxme('racket', viewer, file);
  const doc = new WxmeDocument({ fsPath: file }, bytes, decoded), before = doc.tree;
  const mode = doc.changeMode('1', true); assert.equal(doc.parts[1].eliminateWhitespace, true);
  doc.applyState(mode.before); assert.strictEqual(doc.tree, before); doc.applyState(mode.after);
  doc.changeMode('1/1', true); doc.edit('1/1/0', '(list "λ😀")');
  const removed = doc.remove('1/3'); doc.applyState(removed.before);
  const restored = new WxmeDocument(doc.uri, bytes, decoded); restored.restore(JSON.parse(doc.backup()));
  assert.deepEqual(restored.parts, doc.parts);
  assert.match(renderEditor(doc), /data-mode="1" data-value="false"/);
  assert.match(renderEditor(doc), /Racket splice box/);
  const current = doc.tree;
  assert.throws(() => doc.changeMode('0', true), /Invalid/);
  assert.throws(() => doc.changeMode('1', 'true'), /Invalid/);
  assert.throws(() => doc.setTree(doc.tree.map(n => n.id === '1' ? { ...n, eliminateWhitespace: 1 } : n)), /Invalid/);
  assert.strictEqual(doc.tree, current);
});

test('independent codec preserves original XML/Racket boxes on an untouched roundtrip', gui, async () => {
  for (const name of ['preserve', 'eliminate', 'boxes', 'mixed']) {
    const file = fixture(name), bytes = fs.readFileSync(file), original = await decodeWxme('racket', viewer, file);
    const result = await encode(file, { version: 1, bytes: bytes.toString('base64') });
    assert.deepEqual(result.parts, original.parts); assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

for (const mode of ['preserve', 'eliminate']) test(`edited ${mode} XML retains execution, modes and source objects after reopening`, gui, async t => {
  const file = fixture(mode), bytes = fs.readFileSync(file), decoded = await decodeWxme('racket', viewer, file);
  const doc = new WxmeDocument({ fsPath: file }, bytes, decoded);
  doc.edit('1/1/0', '(number->string (+ base 5))');
  const result = await encode(file, doc.request()), saved = path.join(directory(t), 'edited λ😀.wxme');
  assert.deepEqual(normalize(result.parts), doc.parts); fs.writeFileSync(saved, Buffer.from(result.bytes, 'base64'));
  execute(saved, expected[mode].replace('"9"', '"12"'));
  const reopened = await encode(saved, { version: 1, bytes: result.bytes }); assert.deepEqual(reopened.parts, result.parts);
  doc.changeMode('1', mode === 'preserve');
  const changed = await encode(file, doc.request()); assert.deepEqual(normalize(changed.parts), doc.parts);
  fs.writeFileSync(saved, Buffer.from(changed.bytes, 'base64'));
  execute(saved, expected[mode === 'preserve' ? 'eliminate' : 'preserve'].replace('"9"', '"12"'));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('new XML, Racket and splice boxes save and execute without converting source to text', gui, async t => {
  const file = path.join(directory(t), 'new.wxme');
  const decoded = { parts: [{ kind: 'text', text: '' }] }, doc = new WxmeDocument({ fsPath: file }, Buffer.alloc(0), decoded);
  const prefix = '#lang racket/base\n(write ', xml = '<root>"λ😀"(list \'(item () "added"))</root>';
  doc.edit('0', prefix + xml + ')\n(newline)\n');
  const box = doc.insert('0', prefix.length, prefix.length + xml.length, 'xml');
  const xmlId = doc.nodes.get(box.focus).parent;
  doc.insert(box.focus, 6, 11, 'racket');
  const tail = [...doc.fields].find(([, entry]) => entry.part.text.startsWith('(list'));
  doc.insert(tail[0], 0, tail[1].part.text.indexOf('</root>'), 'splice');
  assert.equal(doc.nodes.get(xmlId).node.kind, 'xml');
  const result = await encode(file, { version: 1, tree: doc.tree });
  assert.deepEqual(normalize(result.parts), doc.parts); fs.writeFileSync(file, Buffer.from(result.bytes, 'base64'));
  execute(file, '(root () "λ😀" (item () "added"))\n');
});

test('XML codec runs with GUI application modules and fallback GUI box readers blocked', gui, t => {
  const output = path.join(directory(t), 'independent.wxme');
  const codec = path.resolve(__dirname, '../racketdap/tools/wxme-codec.rkt');
  const expression = `(require racket/file) (define resolve (current-module-name-resolver))
    (parameterize ([current-module-name-resolver (case-lambda
      [(p n) (resolve p n)] [(p r s l)
       (when (regexp-match? #rx"drracket|xml-snipclass|scheme-snipclass" (format "~s" p)) (error 'dependency "Forbidden dependency: ~s" p))
       (resolve p r s l)])])
      (define encode (dynamic-require '(file ${JSON.stringify(codec)}) 'encode-wxme))
      (define-values (bytes parts) (encode (file->bytes ${JSON.stringify(fixture('preserve'))}) #f #f))
      (call-with-output-file ${JSON.stringify(output)} (lambda (out) (write-bytes bytes out))) (void))`;
  const result = spawnSync('racket', ['-e', expression], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); execute(output, expected.preserve);
});

test('an embedded text-reader mapping cannot authorize loading a different GUI reader', gui, async t => {
  const root = directory(t), collection = path.join(root, 'racketeer-fixture'), marker = path.join(root, 'loaded');
  fs.mkdirSync(collection);
  fs.writeFileSync(path.join(collection, 'reader.rkt'), `#lang racket/base\n(call-with-output-file ${JSON.stringify(marker)} (lambda (out) (display "loaded" out)))\n(error "READER LOADED")\n`);
  const file = fixture('nested-gui-reader'), bytes = fs.readFileSync(file), previous = process.env.PLTCOLLECTS;
  process.env.PLTCOLLECTS = root + path.delimiter + (previous || '');
  try {
    const decoded = await decodeWxme('racket', viewer, file); assert.equal(decoded.parts[0].parts[0].kind, 'comment');
    await assert.rejects(encode(file, { version: 1, bytes: bytes.toString('base64') }), /Unsupported GUI object reader/);
    assert.equal(fs.existsSync(marker), false); assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { if (previous === undefined) delete process.env.PLTCOLLECTS; else process.env.PLTCOLLECTS = previous; }
});
