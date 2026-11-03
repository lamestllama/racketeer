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
// spell: Racket's module path, the module a test refuses to load and the bundled server's
// value for a formatter. Upstream sources, upstream pull requests as submitted and binary
// fixtures are not its own text.
const application = /dr\s*racket/i;
const upstream = /^vendor\/collects\/|^vendor\/patches\/pr-|\.wxme$/;
const modulePath = /dr\s*racket\/check-syntax/gi, refusedModule = /#rx"dr\s*racket/gi, serverValue = /'dr\s*racket'/gi;
const spelled = new Map([
  ['vscode/workspace-rename.rkt', modulePath],
  ['tests/predicted-bindings.rkt', modulePath],
  ['tests/source-positions.rkt', modulePath],
  ['vendor/patches/tail-position-hover.patch', modulePath],
  ['tests/dependencies.test.js', refusedModule],
  ['tests/plots-gui.test.js', refusedModule],
  ['tests/wxme-xml-edit.test.js', refusedModule],
  ['vscode/language-client.js', serverValue],
  ['tests/rhombus-client.test.js', serverValue]
]);

test('first-party files describe behaviour without naming another application', () => {
  const listed = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(listed.status, 0);
  const found = [];
  for (const file of listed.stdout.split('\n').filter(name => name && !upstream.test(name))) {
    if (application.test(file)) found.push(file);
    if (!fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) continue;
    const contents = fs.readFileSync(path.join(root, file));
    if (contents.includes(0)) continue;
    contents.toString('utf8').split('\n').forEach((line, index) => {
      const kept = spelled.get(file);
      if (application.test(kept ? line.replace(kept, '') : line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(found, []);
});

test('first-party documents use British spelling', () => {
  const listed = spawnSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(listed.status, 0);
  const found = [];
  for (const file of listed.stdout.split('\n').filter(name => name && !name.startsWith('vendor/collects/'))) {
    let fenced = false;
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('```')) { fenced = !fenced; return; }
      const match = !fenced && american.exec(prose(line));
      if (match) found.push(`${file}:${index + 1}: ${match[0]}`);
    });
  }
  assert.deepStrictEqual(found, []);
});
