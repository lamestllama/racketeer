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
