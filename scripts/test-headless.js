// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function inventory(directory = root) {
  // Feature suites are discovered by filename, including the macro stepper suites.
  const tests = fs.readdirSync(path.join(directory, 'tests')).sort();
  return {
    racket: [...tests.filter(name => name.endsWith('.rkt')).map(name => `tests/${name}`), 'experiments/lexical-eval.rkt'],
    node: tests.filter(name => name.endsWith('.test.js') && !['gui-parity.test.js', 'plots-gui.test.js'].includes(name)).map(name => `tests/${name}`)
  };
}
function run() {
  const suites = inventory();
  if (process.argv.includes('--list')) { console.log(JSON.stringify(suites, null, 2)); return; }
  // Tests leave their temporary folders here, so that nothing still running can
  // fail one by holding a folder. The whole folder goes when the run ends, if it can.
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-')));
  const env = { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch };
  try {
    for (const [command, args] of [
      [process.execPath, ['scripts/stage-extension.js']],
      ['raco', ['test', '--timeout', '600', ...suites.racket]],
      // Each test has its own deadline (tests/support/node-test.js), so a file
      // takes the sum of its tests' times. The runner's limit is only a ceiling
      // for a file whose process never exits.
      [process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=1800000', ...suites.node]]
    ]) {
      const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
      if (result.error) throw result.error;
      if (result.status !== 0) { process.exitCode = result.status || 1; return; }
    }
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* It stays behind. */ }
  }
}
if (require.main === module) run();
module.exports = { inventory };
