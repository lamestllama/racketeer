// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { racketPath, versionProblem } = require('../vscode/racket-version');

test('a command path skips a file without execute permission', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racket-path-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const early = path.join(directory, 'early'), later = path.join(directory, 'later');
  fs.mkdirSync(early); fs.mkdirSync(later);
  const blocked = path.join(early, 'racket'), executable = path.join(later, 'racket');
  fs.writeFileSync(blocked, '#!/bin/sh\necho stale\n', { mode: 0o644 });
  fs.writeFileSync(executable, '#!/bin/sh\necho "Welcome to Racket v9.0 [cs]."\n', { mode: 0o755 });
  const env = { ...process.env, PATH: [early, later].join(path.delimiter) };
  assert.throws(() => fs.accessSync(blocked, fs.constants.X_OK));
  assert.doesNotThrow(() => fs.accessSync(executable, fs.constants.X_OK));
  const output = 'Welcome to Racket v9.0 [cs].';
  assert.equal(racketPath('racket', env), executable);
  assert.ok(versionProblem(output, 'racket', env).includes(executable));
});
