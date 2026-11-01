// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WxmeDocument, normalize } = require('../vscode/wxme-document');
const { requestWxme, decodeWxme } = require('../vscode/wxme-process');
const root = path.resolve(__dirname, '..');
const viewer = path.join(root, 'racketdap/tools/wxme-view.rkt'), codec = path.join(root, 'racketdap/tools/wxme-edit.rkt');
const text = value => ({ kind: 'text', text: value });
const model = (parts = [text('a😀bcλ')]) => new WxmeDocument({ fsPath: '/original.wxme' }, Buffer.from('original'), { parts });
const fixture = name => path.join(__dirname, 'fixtures/wxme', name + '.wxme');
async function load(name) { const file = fixture(name); return new WxmeDocument({ fsPath: file }, fs.readFileSync(file), await decodeWxme('racket', viewer, file)); }
async function save(doc) { return requestWxme('racket', codec, doc.uri.fsPath, doc.request()); }
const gui = { skip: !process.env.RACKETDAP_TEST_WXME_GUI, timeout: 60000 };

test('wrapping a Unicode selection preserves original spans and stable identities', () => {
  const doc = model([text('a😀bcλ'), { kind: 'comment', parts: [text('existing')] }, text('end')]);
  const before = doc.tree, other = doc.tree[1];
  const change = doc.insert('0', 1, 4, 'comment');
  assert.deepEqual(doc.parts.slice(0, 3), [text('a'), { kind: 'comment', parts: [text('😀b')] }, text('cλ')]);
  assert.strictEqual(doc.tree[3], other);
  assert.deepEqual(doc.tree[1].parts[0].pieces, [{ source: '0', start: 1, end: 4 }]);
  assert.equal(doc.fields.get('1/0').part.text, 'existing');
  doc.applyState(change.before); assert.strictEqual(doc.tree, before); assert.equal(doc.changed(), false);
  doc.applyState(change.after); assert.equal(doc.parts[1].parts[0].text, '😀b');
  assert.throws(() => { doc.tree[0].pieces.push({ text: 'outside transaction' }); }, TypeError);
});

test('nested insert, text edit and removal undo restore the exact content and provenance', () => {
  const doc = model(), insertion = doc.insert('0', 1, 3, 'editor');
  const nested = doc.tree[1], inner = nested.parts[0].id;
  const edit = doc.edit(inner, '😁λ');
  const another = doc.insert(inner, 2, 3, 'comment');
  const tree = doc.tree, removal = doc.remove(nested.id);
  assert.deepEqual(doc.parts, [text('abcλ')]);
  doc.applyState(removal.before); assert.strictEqual(doc.tree, tree);
  doc.applyState(another.before); doc.applyState(edit.before); doc.applyState(insertion.before);
  assert.deepEqual(doc.parts, [text('a😀bcλ')]); assert.equal(doc.changed(), false);
});

test('invalid spans, surrogates, nesting and backup references leave the model intact', () => {
  const doc = model(), original = doc.tree;
  assert.throws(() => doc.insert('0', 2, 2, 'comment'), /Unicode/);
  assert.throws(() => doc.edit('0', '\ud800'), /Unicode/);
  assert.strictEqual(doc.tree, original);
  const backup = JSON.parse(doc.backup()); backup.tree[0].pieces[0].end = 2;
  assert.throws(() => doc.restore(backup), /span/); assert.strictEqual(doc.tree, original);
  let field = '0';
  for (let i = 0; i < 32; i++) { const change = doc.insert(field, 0, 0, 'editor'); field = change.focus; }
  const limit = doc.tree;
  assert.throws(() => doc.insert(field, 0, 0, 'comment'), /32 levels/); assert.strictEqual(doc.tree, limit);
});

test('recovery versions restore structural edits and reject a corrupt backup atomically', () => {
  const doc = model(); doc.insert('0', 1, 3, 'comment'); doc.edit(doc.tree[1].parts[0].id, 'new 😀');
  const restored = model(); restored.restore(JSON.parse(doc.backup()));
  assert.deepEqual(restored.tree, doc.tree); assert.deepEqual(restored.parts, doc.parts);
  const before = restored.tree, revision = restored.revision;
  const broken = JSON.parse(doc.backup()); broken.tree[2].id = broken.tree[0].id;
  assert.throws(() => restored.restore(broken), /duplicate/); assert.strictEqual(restored.tree, before); assert.equal(restored.revision, revision);
  const old = model(); old.restore({ version: 1, diskHash: doc.diskHash, edits: [{ path: [0], text: 'legacy recovery' }] });
  assert.equal(old.parts[0].text, 'legacy recovery');
});

test('piece-table edits retain unchanged source spans across multiple Unicode replacements', () => {
  const doc = model(); doc.edit('0', 'a😁bcλ'); doc.edit('0', 'prefix a😁bcλ'); doc.edit('0', 'prefix a😁bcλ suffix');
  assert.equal(doc.parts[0].text, 'prefix a😁bcλ suffix');
  assert.ok(doc.tree[0].pieces.some(p => p.source === '0' && p.start === 3 && p.end === 6));
  const before = doc.tree; const change = doc.edit('0', 'prefix a😁bλ suffix');
  doc.applyState(change.before); assert.strictEqual(doc.tree, before);
});

test('codec saves insertion, nested edits and object deletion without flattening existing images', gui, async () => {
  const doc = await load('images'); const image = doc.parts[1];
  doc.insert('0', 20, 20, 'comment');
  const comment = doc.tree[1]; doc.edit(comment.parts[0].id, 'new comment 😀');
  doc.insert(comment.parts[0].id, 0, 0, 'editor');
  doc.remove('3');
  const result = await save(doc);
  assert.deepEqual(normalize(result.parts), doc.parts);
  assert.deepEqual(result.parts.find(p => p.kind === 'image'), image);
  const reopened = await requestWxme('racket', codec, doc.uri.fsPath, { version: 1, bytes: result.bytes });
  assert.deepEqual(reopened.parts, result.parts);
});

test('codec imports a PNG and preserves image insertion through save and reopen', gui, async () => {
  const original = await load('images'), data = original.parts[1].data;
  const imported = await requestWxme('racket', codec, original.uri.fsPath, { version: 1, image: data });
  const doc = await load('text'); doc.insert('0', doc.parts[0].text.length, doc.parts[0].text.length, 'image', imported.parts[0]);
  const saved = await save(doc); assert.deepEqual(normalize(saved.parts), doc.parts);
  assert.deepEqual(saved.parts.find(p => p.kind === 'image'), imported.parts[0]);
  await assert.rejects(requestWxme('racket', codec, original.uri.fsPath, { version: 1, image: Buffer.from('not PNG').toString('base64') }), /PNG/);
});

test('styled Unicode and tabs retain their styles when moved into a box and saved', gui, async () => {
  const probe = (mode, input) => {
    const result = spawnSync('racket', [path.join(__dirname, 'support/wxme-style.rkt'), mode], { input: JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const bytes = probe('create', null);
  const opened = await requestWxme('racket', codec, '/style.wxme', { version: 1, bytes });
  const doc = new WxmeDocument({ fsPath: '/style.wxme' }, Buffer.from(bytes, 'base64'), opened);
  const original = probe('inspect', bytes);
  assert.deepEqual(original.slice(1, 4).map(c => c.weight), ['bold', 'bold', 'bold']);
  doc.insert('0', 1, 5, 'editor'); doc.edit('0', 'prefix A');
  const result = await save(doc), styles = probe('inspect', result.bytes);
  assert.deepEqual(styles.find(c => c.parts).parts, original.slice(1, 4));
  assert.deepEqual(styles.slice(-2), original.slice(-2));
  assert.deepEqual(normalize(result.parts), doc.parts);
  const xml = new WxmeDocument(doc.uri, doc.bytes, opened);
  xml.insert('0', 1, 5, 'xml');
  const xmlResult = await save(xml);
  assert.deepEqual(normalize(xmlResult.parts), xml.parts);
  assert.deepEqual(probe('inspect', xmlResult.bytes).find(c => c.parts).parts, original.slice(1, 4));
  // Public comment-box readers impose their own standard text style on load.
  const comment = new WxmeDocument(doc.uri, doc.bytes, opened);
  comment.insert('0', 1, 5, 'comment');
  const commentStyles = probe('inspect', (await save(comment)).bytes).find(c => c.parts).parts;
  assert.deepEqual(commentStyles, probe('inspect', probe('create-comment', null))[0].parts);
  comment.applyState(comment.initial);
  assert.deepEqual(probe('inspect', (await save(comment)).bytes), original);
});
