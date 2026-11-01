// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { root, addon } = require('./workspace-index-project');

test('workspace analysis works directly and owns independent, cancellable engine instances', { timeout: 120000 }, () => {
  const result = spawnSync('raco', ['test', '--timeout', '100', 'tests/fixtures/workspace-analysis.rkt'], {
    cwd: root, env: { ...process.env, PLTADDONDIR: addon }, encoding: 'utf8', timeout: 110000
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /2 tests passed/);
});
