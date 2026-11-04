// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { spawnSync } = require('node:child_process');
const { root, addon } = require('./workspace-index-project');

test('concurrent index replies reach the client as whole messages', () => {
  const result = spawnSync('raco', ['test', '--timeout', '280', 'tests/fixtures/workspace-index-framing.rkt'], {
    cwd: root, env: { ...process.env, PLTADDONDIR: addon }, encoding: 'utf8', timeout: 240000
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 test passed/);
});
