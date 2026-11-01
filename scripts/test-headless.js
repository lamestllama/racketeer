// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function inventory(directory = root) {
  const tests = fs.readdirSync(path.join(directory, 'tests')).sort();
  return {
    racket: [...tests.filter(name => name.endsWith('.rkt')).map(name => `tests/${name}`), 'experiments/lexical-eval.rkt'],
    node: tests.filter(name => name.endsWith('.test.js') && !['gui-parity.test.js', 'macro-stepper-gui.test.js', 'plots-gui.test.js'].includes(name)).map(name => `tests/${name}`)
  };
}
function run() {
  const suites = inventory();
  if (process.argv.includes('--list')) { console.log(JSON.stringify(suites, null, 2)); return; }
  for (const [command, args] of [
    [process.execPath, ['scripts/stage-extension.js']],
    ['raco', ['test', '--timeout', '180', ...suites.racket]],
    // Each test has its own deadline (tests/support/node-test.js), so a file
    // takes the sum of its tests' times. The runner's limit is only a ceiling
    // for a file whose process never exits, within the CI job's 45 minutes.
    [process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=1800000', ...suites.node]]
  ]) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status || 1; return; }
  }
}
if (require.main === module) run();
module.exports = { inventory };
