// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('./support/node-test.js');

const root = path.resolve(__dirname, '..');
// First-party documents are written in British spelling. Code is not prose: fenced blocks,
// inline code, link targets and hyphenated identifiers keep their names, as do vendored files.
const american = /(?<![-'/`])\b(?:behavior\w*|honor\w*|favors?|labeled|relabeling|canceled|canceling|analyzed|recognized|normalized|optimiz\w+|serializ\w+|synchroniz\w+|synthesiz\w+|tokeniz\w+|parameteriz(?:ation|ed)|(?:un)?initializ\w+)\b(?![-?!])/i;
// What a user or the protocol calls something, spelled as it is there.
const names = [/\*\*Racket: debug initialization\*\*/g, /Initialize, launch, configurationDone/g, /initialize, launch a small module/g];

function prose(line) {
  const text = names.reduce((result, name) => result.replace(name, ''), line);
  return text.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');
}

// Racketeer's own text describes behaviour on its own terms. What stays is what code must
// spell: Racket's module paths, the module a test refuses to load and the bundled server's
// value for a formatter. Upstream sources and binary
// fixtures are not its own text.
const application = /dr\s*racket/i;
const wxmeFixture = /^tests\/fixtures\/wxme(?:-debug|-xml)?\/[^/]+\.wxme$/;
const modulePath = /dr\s*racket\/check-syntax/gi, standInPath = /dr\s*racket\/private\/syncheck\/xref/gi, refusedModule = /#rx"dr\s*racket/gi, serverValue = /'dr\s*racket'/gi;
const spelled = new Map([
  ['racketdap/tools/bindings-service.rkt', modulePath],
  ['vscode/workspace-rename.rkt', modulePath],
  ['vscode/workspace-analysis-worker.rkt', modulePath],
  ['vscode/workspace-worker.rkt', standInPath],
  ['tests/deferred-imports.rkt', modulePath],
  ['tests/binding-contributions.rkt', modulePath],
  ['tests/bindings-service.rkt', modulePath],
  ['tests/predicted-bindings.rkt', modulePath],
  ['tests/source-positions.rkt', modulePath],
  ['vendor/patches/binding-identities.patch', modulePath],
  ['vendor/patches/generic-bindings.patch', modulePath],
  ['vendor/patches/tail-position-hover.patch', modulePath],
  ['vendor/patches/lazy-documentation.patch', modulePath],
  ['vendor/patches/url-string.patch', modulePath],
  ['vendor/patches/language-adapter-policy-cache.patch', /dr\s*racket\/check-syntax|dr\s*racket-format-edits|\(dr\s*racket\)/gi],
  ['tests/dependencies.test.js', refusedModule],
  ['tests/plots-gui.test.js', refusedModule],
  ['tests/wxme-xml-edit.test.js', refusedModule],
  ['vscode/language-client.js', serverValue],
  ['tests/rhombus-client.test.js', serverValue]
]);

function applicationMentions(file, contents) {
  if (file.startsWith('vendor/collects/')) return [];
  const found = application.test(file) ? [file] : [];
  if (!contents || contents.includes(0)) return found;
  const text = contents.toString('utf8');
  if (wxmeFixture.test(file) && /^#reader\(lib"read\.ss""wxme"\)WXME\d+ ##/.test(text)) return found;
  const kept = spelled.get(file);
  // Keep newlines and offsets while removing the few spellings code requires.
  const checked = kept ? text.replace(kept, match => match.replace(/[^\n]/g, ' ')) : text;
  for (const match of checked.matchAll(new RegExp(application.source, 'gi'))) {
    const line = checked.slice(0, match.index).split('\n').length;
    found.push(`${file}:${line}: ${JSON.stringify(match[0])}`);
  }
  return found;
}

test('first-party files describe behaviour without naming another application', () => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(listed.status, 0);
  const found = [];
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const contents = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()
      ? fs.readFileSync(path.join(root, file)) : undefined;
    found.push(...applicationMentions(file, contents));
  }
  assert.deepStrictEqual(found, []);
});

test('application scanning covers wrapped text, names and files outside the precise exceptions', () => {
  const mention = ['Dr', 'Racket'].join('');
  for (const [file, text] of [
    ['docs/naïve.txt', mention], ['README.md', ['Dr', 'Racket'].join('\n')],
    ['vendor/patches/pr-new.patch', mention], ['docs/example.wxme', mention],
    [`docs/${mention}.wxme`, 'ordinary text'],
    ['tests/fixtures/wxme/new.wxme', mention]
  ]) assert.ok(applicationMentions(file, Buffer.from(text)).length, file);
  assert.deepStrictEqual(applicationMentions('tests/fixtures/wxme/new.wxme',
    Buffer.from('#reader(lib"read.ss""wxme")WXME0111 ## \n' + mention)), []);
});

test('first-party documents use British spelling', () => {
  const listed = spawnSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(listed.status, 0);
  const found = [];
  for (const file of listed.stdout.split('\0').filter(name => name && !name.startsWith('vendor/collects/'))) {
    let fenced = false;
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('```')) { fenced = !fenced; return; }
      const match = !fenced && american.exec(prose(line));
      if (match) found.push(`${file}:${index + 1}: ${match[0]}`);
    });
  }
  assert.deepStrictEqual(found, []);
});
