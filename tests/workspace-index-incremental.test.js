// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { addon, uri, project } = require('./workspace-index-project');
const treeRemoval = require('./support/tree-removal');

const from = (locations, source) => locations.filter(location => location.uri === source);

// A file that leaves a line in its own log each time it is expanded. Nothing
// should require it, since an analysis of whatever did would expand it too.
function tracked(p, name, body) {
  const log = path.join(addon, `${path.basename(p.directory)}-${name}.log`);
  return { name, log, expansions: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0,
    text: `#lang racket/base
${body}
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(log)} #:exists 'append
    (lambda (out) (display "expanded\\n" out))))
` };
}

// A project with a consumer of `square` through `middle.rkt`, a file that has
// nothing to do with it, and whatever else a case needs.
async function workspace(t, { consumer = '(require "middle.rkt")\n(square 3)', files = {}, env } = {}) {
  const p = await project(t, env);
  const consumerFile = tracked(p, 'consumer.rkt', consumer), other = tracked(p, 'other.rkt', '(define unrelated 1)');
  p.write('middle.rkt', '#lang racket/base\n(require "definition.rkt")\n(provide square)\n');
  fs.unlinkSync(p.filename('uses.rkt'));
  p.write('consumer.rkt', consumerFile.text);
  p.write('other.rkt', other.text);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p.filename(name)), { recursive: true });
    p.write(name, text);
  }
  await p.update();
  await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  return { ...p, consumer: consumerFile, other, consumerUri: uri(p.filename('consumer.rkt')) };
}

const attempt = request => request.then(value => ({ value }), error => ({ code: error.code, message: error.message }));
const position = { line: 2, character: 10 };
// What a server says about `square`. References come from the pass; validating a
// rename expands every file again, so it comes after any counting.
const referencesTo = async (p, key) => ({
  references: await attempt(p.references(key, position, false)),
  withDeclaration: await attempt(p.references(key, position, true))
});
const renameOf = async (p, key) => {
  const edits = await attempt(p.rename(key, 'squared', position));
  const { state, indexed, failures } = p.notifications.at(-1);
  return { edits, status: { state, indexed, failures } };
};

// Compares a pass that reused results with a new server's, which has none, byte
// for byte. Returns the expansion counts of the pass, before anything else adds to them.
async function assertAsFresh(t, p, { env, key = p.origin } = {}) {
  const reused = await referencesTo(p, key);
  const counts = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  const edits = await renameOf(p, key);
  const fresh = await project(t, env, p);
  assert.equal(JSON.stringify({ ...reused, ...edits }, null, 1),
    JSON.stringify({ ...await referencesTo(fresh, key), ...await renameOf(fresh, key) }, null, 1));
  return counts;
}

test('an edit in a dependency reanalyses its consumers and reuses the rest, as a fresh pass answers', { timeout: 180000 }, async t => {
  const p = await workspace(t);
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  // middle.rkt now binds its own square, so the consumer no longer refers to the definition.
  p.write('middle.rkt', '#lang racket/base\n(provide square)\n(define (square x) x)\n');
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.ok(after.consumer > before.consumer, 'The consumer must be analysed again');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

test('an edit in a dependency of a dependency reanalyses every file that reached it', { timeout: 180000 }, async t => {
  const p = await workspace(t, { files: { 'bottom.rkt': '#lang racket/base\n(require "definition.rkt")\n(provide square)\n' } });
  p.write('middle.rkt', '#lang racket/base\n(require "bottom.rkt")\n(provide square)\n');
  await p.update(); await p.references(p.origin);
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  p.write('bottom.rkt', '#lang racket/base\n(provide square)\n(define (square x) x)\n');
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.ok(after.consumer > before.consumer, 'The consumer must be analysed again');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

test('a macro changing in another file reanalyses every file that used it, directly or not', { timeout: 180000 }, async t => {
  const macro = '#lang racket/base\n(provide call)\n(define-syntax-rule (call f) (f 1))\n';
  const p = await workspace(t, {
    consumer: '(require "macro.rkt" "definition.rkt")\n(call square)',
    files: { 'macro.rkt': macro, 'wrapper.rkt': '#lang racket/base\n(require "macro.rkt")\n(provide wrap)\n(define-syntax-rule (wrap f) (call f))\n' } });
  const second = tracked(p, 'second.rkt', '(require "wrapper.rkt" "definition.rkt")\n(wrap square)');
  p.write('second.rkt', second.text);
  await p.update();
  const secondUri = uri(p.filename('second.rkt'));
  const locations = await p.references(p.origin);
  assert.equal(from(locations, p.consumerUri).length, 1);
  assert.equal(from(locations, secondUri).length, 1);
  const before = { consumer: p.consumer.expansions(), second: second.expansions(), other: p.other.expansions() };
  // The macro now drops its argument, so neither file refers to square.
  p.write('macro.rkt', '#lang racket/base\n(provide call)\n(define-syntax-rule (call f) 1)\n');
  await p.update();
  const after = await assertAsFresh(t, p);
  const changed = await p.references(p.origin);
  assert.equal(from(changed, p.consumerUri).length, 0);
  assert.equal(from(changed, secondUri).length, 0);
  assert.ok(after.consumer > before.consumer, 'A direct user must be analysed again');
  assert.ok(second.expansions() > before.second, 'A user through another macro must be analysed again');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

test('a file added that shadows the one a relative import found reanalyses its consumers', { timeout: 180000 }, async t => {
  const p = await workspace(t, {
    consumer: '(require "chosen.rkt")\n(square 3)',
    files: { 'chosen.ss': '#lang racket/base\n(require "definition.rkt")\n(provide square)\n' } });
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  p.write('chosen.rkt', '#lang racket/base\n(provide square)\n(define (square x) x)\n');
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.ok(after.consumer > before.consumer, 'The consumer must load the new file');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

const userLinks = () => spawnSync('racket', ['-l', 'racket/base', '-l', 'setup/dirs', '-e', '(display (find-user-links-file))'],
  { env: { ...process.env, PLTADDONDIR: addon }, encoding: 'utf8' }).stdout;
function linking(t, links) {
  const file = userLinks();
  const write = entries => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries).replace(/[[\]]/g, match => match === '[' ? '(' : ')').replace(/,/g, ' '));
  };
  write(links);
  t.after(() => fs.rmSync(file, { force: true }));
  return write;
}
const ownSquare = '#lang racket/base\n(provide square)\n(define (square x) x)\n';
// The macro a collection supplies keeps its argument, or drops it.
const keeps = '#lang racket/base\n(provide call)\n(define-syntax-rule (call f) (f 1))\n';
const drops = '#lang racket/base\n(provide call)\n(define-syntax-rule (call f) 1)\n';
function outsideWorkspace(t, ...folders) {
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-collection-')));
  t.after(() => fs.rmSync(outside, treeRemoval));
  return folders.map(folder => {
    fs.mkdirSync(path.join(outside, folder));
    return path.join(outside, folder);
  });
}

test('a file added in an earlier root of a collection shadows the one an import found', { timeout: 180000 }, async t => {
  const [first, second] = outsideWorkspace(t, 'first', 'second');
  linking(t, [['probe-shadow', first], ['probe-shadow', second]]);
  fs.writeFileSync(path.join(second, 'lib.rkt'), keeps);
  const p = await workspace(t, { consumer: '(require probe-shadow/lib "definition.rkt")\n(call square)' });
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  fs.writeFileSync(path.join(first, 'lib.rkt'), drops);
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.ok(after.consumer > before.consumer, 'The consumer must load the shadowing file');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

test('a collection link changed reanalyses the files that used the collection', { timeout: 180000 }, async t => {
  const [one, two] = outsideWorkspace(t, 'one', 'two');
  const link = linking(t, [['probe-link', one]]);
  fs.writeFileSync(path.join(one, 'lib.rkt'), keeps);
  fs.writeFileSync(path.join(two, 'lib.rkt'), drops);
  const p = await workspace(t, { consumer: '(require probe-link/lib "definition.rkt")\n(call square)' });
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  // The file it found before stays exactly as it was.
  link([['probe-link', two]]);
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.ok(after.consumer > before.consumer, 'The consumer must follow the link');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

test('a file outside the workspace changed reanalyses the files that loaded it', { timeout: 180000 }, async t => {
  const [folder] = outsideWorkspace(t, 'library');
  linking(t, [['probe-outside', folder]]);
  fs.writeFileSync(path.join(folder, 'lib.rkt'), keeps);
  const p = await workspace(t, { consumer: '(require probe-outside/lib "definition.rkt")\n(call square)' });
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  fs.writeFileSync(path.join(folder, 'lib.rkt'), drops);
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.ok(after.consumer > before.consumer);
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
});

test('a library with only compiled code is compared by that code', { timeout: 180000 }, async t => {
  const p = await project(t);
  const folder = fs.mkdtempSync(path.join(addon, 'compiled-only-')), library = path.join(folder, 'macro.rkt');
  const compileOnly = text => {
    fs.writeFileSync(library, text);
    const made = spawnSync('raco', ['make', library], { encoding: 'utf8', env: { ...process.env, PLTADDONDIR: addon }, timeout: 60000 });
    assert.equal(made.status, 0, made.stderr);
    fs.unlinkSync(library);
  };
  compileOnly('#lang racket/base\n(provide call)\n(define-syntax-rule (call f) (f 1))\n');
  const consumer = tracked(p, 'consumer', `(require (file ${JSON.stringify(library)}) "definition.rkt")\n(call square)`);
  p.write('consumer.rkt', consumer.text);
  await p.update();
  const count = async () => from(await p.references(p.origin), uri(p.filename('consumer.rkt'))).length;
  assert.equal(await count(), 1, p.diagnostics());
  const expansions = consumer.expansions();
  await p.update();
  assert.equal(await count(), 1);
  assert.equal(consumer.expansions(), expansions, 'Unchanged compiled code keeps the result');
  compileOnly('#lang racket/base\n(provide call)\n(define-syntax-rule (call f) 1)\n');
  await p.update();
  assert.equal(await count(), 0, 'Replaced compiled code is read afresh');
});

test('a registered file replaced during an analysis is not recorded with its later bytes', { timeout: 180000 }, async t => {
  const p = await project(t);
  const part = p.filename('part.txt'), gate = p.filename('entered'), release = p.filename('release');
  fs.writeFileSync(part, '(define-syntax-rule (call f) (f 1))\n');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(part, past, past);
  p.write('uses.rkt', `#lang racket/base
(require racket/include "definition.rkt" (for-syntax racket/base))
(include "part.txt")
(begin-for-syntax
  (unless (file-exists? ${JSON.stringify(release)})
    (call-with-output-file ${JSON.stringify(gate)} #:exists 'truncate void)
    (let wait () (unless (file-exists? ${JSON.stringify(release)}) (sleep 0.01) (wait)))))
(call square)\n`);
  await p.update();
  const consumer = uri(p.filename('uses.rkt'));
  const first = p.references(p.origin);
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(gate)) {
    assert.ok(Date.now() < deadline, p.diagnostics());
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // A copy that keeps its date, while the analysis holds what it read before.
  fs.writeFileSync(part, '(define-syntax-rule (call f) 1)\n');
  fs.utimesSync(part, past, past);
  fs.writeFileSync(release, '');
  assert.equal(from(await first, consumer).length, 1, 'The analysis read the former text');
  await p.diskChange('part.txt');
  assert.equal(from(await p.references(p.origin), consumer).length, 0, 'The next pass reads what the file holds');
});

test('a registered file seen unchanged from one pass to the next keeps its reader\'s result', { timeout: 180000 }, async t => {
  const p = await project(t);
  p.write('part.txt', '(define-syntax-rule (call f) (f 1))\n');
  const consumer = tracked(p, 'consumer', '(require racket/include "definition.rkt")\n(include "part.txt")\n(call square)');
  p.write('consumer.rkt', consumer.text);
  await p.update();
  const count = async () => from(await p.references(p.origin), uri(p.filename('consumer.rkt'))).length;
  assert.equal(await count(), 1, p.diagnostics());
  // The first pass has no earlier sight of the file, so the second reads it again.
  await p.update();
  assert.equal(await count(), 1);
  const expansions = consumer.expansions();
  await p.update();
  assert.equal(await count(), 1);
  assert.equal(consumer.expansions(), expansions, 'Seen unchanged at both ends, the result stands');
});

test('a file deleted is dropped, its consumers fail as in a fresh pass, and the rest are reused', { timeout: 180000 }, async t => {
  const p = await workspace(t);
  const before = { other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  fs.unlinkSync(p.filename('middle.rkt'));
  await p.update();
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.equal(after.other, before.other, 'An unrelated file must be reused');
  // A file with no consumers goes without a failure.
  p.write('middle.rkt', '#lang racket/base\n(require "definition.rkt")\n(provide square)\n');
  await p.update(); await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  fs.unlinkSync(p.filename('other.rkt'));
  await p.update();
  await assertAsFresh(t, p);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
});

// An included file's own locations belong to no analysed file, so what shows is its effect.
const keepsForm = '(define-syntax-rule (call f) (f 1))\n', dropsForm = '(define-syntax-rule (call f) 1)\n';
const includer = name => `(require racket/include "definition.rkt")\n(include "${name}")\n(call square)`;

for (const included of ['part.rktl', 'part.txt']) {
  test(`an included file changed reanalyses the files that included it (${included})`, { timeout: 180000 }, async t => {
    const p = await workspace(t, { consumer: includer(included), files: { [included]: keepsForm } });
    assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1, p.diagnostics());
    const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
    p.write(included, dropsForm);
    await p.diskChange(included);
    const after = await assertAsFresh(t, p);
    assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0);
    assert.ok(after.consumer > before.consumer, 'The includer must be analysed again');
    assert.equal(after.other, before.other, 'An unrelated file must be reused');
  });
}

test('a file included while open is read from the disk, as a fresh pass reads it', { timeout: 180000 }, async t => {
  const p = await workspace(t, { consumer: includer('part.rktl'), files: { 'part.rktl': keepsForm } });
  p.open('part.rktl', dropsForm);
  await p.update(true);
  await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1, 'The includer reads the disk');
  const before = p.consumer.expansions();
  p.write('part.rktl', dropsForm);
  await p.diskChange('part.rktl');
  const after = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0, 'A buffer cannot hide a change on disk');
  assert.ok(after.consumer > before);
});

test('an unsaved buffer counts as its file: dependents follow it, and closing it restores the disk', { timeout: 180000 }, async t => {
  const p = await workspace(t);
  const original = fs.readFileSync(p.filename('middle.rkt'), 'utf8');
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  const buffer = p.open('middle.rkt', ownSquare);
  await p.update(true);
  const edited = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 0, 'The buffer, not the disk, decides');
  assert.ok(edited.consumer > before.consumer, 'A dependent must be analysed again for a changed buffer');
  assert.equal(edited.other, before.other, 'An unrelated file must be reused');
  assert.equal(fs.readFileSync(p.filename('middle.rkt'), 'utf8'), original);
  // Edited back to what the disk holds, nothing depends on the buffer any more.
  p.documents.get(buffer).text = original; p.documents.get(buffer).version++;
  await p.update(true);
  await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  const open = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  p.documents.delete(buffer);
  await p.update(true);
  const closed = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), p.consumerUri).length, 1);
  assert.deepEqual(closed, open, 'Closing a buffer that matches the disk changes nothing');
});

test('a failed file is analysed again by every pass until it succeeds', { timeout: 180000 }, async t => {
  const p = await workspace(t);
  const failing = tracked(p, 'failing.rkt', '(require "later.rkt")\n(square 3)');
  p.write('failing.rkt', failing.text);
  await p.update();
  await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'partial');
  // Nothing about it changes, and only the other file does.
  p.write('other.rkt', p.other.text + '; changed\n');
  await p.update();
  const first = await p.references(p.origin);
  assert.equal(from(first, uri(p.filename('failing.rkt'))).length, 0);
  assert.equal(p.notifications.at(-1).state, 'partial');
  assert.match(p.diagnostics(), /failing\.rkt/);
  const failures = (p.diagnostics().match(/incomplete: \S*failing\.rkt/g) || []).length;
  assert.equal(failures, 2, 'Each pass tries it again');
  p.write('later.rkt', '#lang racket/base\n(require "definition.rkt")\n(provide square)\n');
  await p.update();
  await assertAsFresh(t, p);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.equal(from(await p.references(p.origin), uri(p.filename('failing.rkt'))).length, 1);
});

test('a macro reading an unregistered file sees it only after a change to a file loaded with it, or a refresh', { timeout: 180000 }, async t => {
  const p = await workspace(t, {
    consumer: `(require (for-syntax racket/base racket/file) "definition.rkt" "helper.rkt")
(define-syntax (from-data stx)
  (syntax-case stx ()
    [(_ f) (if (equal? (file->string "data.txt") "keep") #'(f 1) #'1)]))
(from-data square)`,
    files: { 'data.txt': 'keep', 'helper.rkt': '#lang racket/base\n' } });
  const count = async () => from(await p.references(p.origin), p.consumerUri).length;
  assert.equal(await count(), 1);
  p.write('data.txt', 'drop');
  await p.diskChange('data.txt');
  assert.equal(await count(), 1, 'The limit: nothing says this file was read');
  p.write('helper.rkt', '#lang racket/base\n; changed\n');
  await p.update();
  assert.equal(await count(), 0, 'A change to a file loaded alongside it brings the analysis back');
  p.write('data.txt', 'keep');
  await p.diskChange('data.txt');
  assert.equal(await count(), 0, 'The limit again');
  await p.request('workspace/executeCommand', { command: 'racketeer.refreshWorkspaceIndex' });
  assert.equal(await count(), 1, 'A refresh forgets every result');
});

test('a reused pass answers without analysing anything but the request', { timeout: 180000 }, async t => {
  const p = await workspace(t, { env: { RACKETEER_INDEX_TRACE: '1' } });
  const analyses = () => p.diagnostics().match(/analyse \S+: starting/g).length;
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions(), analyses: analyses() };
  await p.diskChange('other.rkt');
  const locations = await p.references(p.origin);
  assert.equal(from(locations, p.consumerUri).length, 1);
  assert.equal(p.notifications.at(-1).state, 'ready');
  assert.equal(p.consumer.expansions(), before.consumer);
  assert.equal(p.other.expansions(), before.other);
  assert.equal(analyses(), before.analyses + 1, 'Only the file the request names');
});

test('a lower size limit applies to files a pass would otherwise reuse', { timeout: 180000 }, async t => {
  const p = await workspace(t);
  p.settings.maxFileBytes = 10;
  await p.update();
  await assertAsFresh(t, p);
  assert.equal(p.notifications.at(-1).state, 'partial');
});

test('a file added or edited that nothing loads is analysed alone', { timeout: 180000 }, async t => {
  const p = await workspace(t);
  const second = tracked(p, 'second.rkt', '(require "definition.rkt")\n(square 4)');
  const before = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  p.write('second.rkt', second.text);
  await p.update();
  const added = await assertAsFresh(t, p);
  assert.equal(added.consumer, before.consumer);
  assert.equal(added.other, before.other);
  const secondUri = uri(p.filename('second.rkt'));
  assert.equal(from(await p.references(p.origin), secondUri).length, 1);
  const unchanged = { consumer: p.consumer.expansions(), other: p.other.expansions() };
  p.write('second.rkt', second.text + '(square 5)\n');
  await p.update();
  const edited = await assertAsFresh(t, p);
  assert.equal(from(await p.references(p.origin), secondUri).length, 2);
  assert.deepEqual(edited, unchanged, 'A consumer of the definition does not depend on another consumer');
});
