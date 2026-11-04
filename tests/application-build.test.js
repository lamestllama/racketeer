// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildPlan, executablePath } = require('../vscode/application-build');
const treeRemoval = require('./support/tree-removal');
const execute = promisify(execFile);

// Windows keeps a deleted file until the last handle to it closes, so a
// directory can stay nonempty briefly after the processes that used it exit.
// Retry for a few seconds, report the retries, and name what remains if the
// directory still cannot be removed.
async function removeTree(t, directory) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(directory, treeRemoval);
      if (attempt) t.diagnostic(`${directory} was removed after ${attempt} retries`);
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code) || attempt === 20) {
        const remaining = await fs.readdir(directory, { recursive: true }).catch(() => []);
        error.message += `; ${attempt} retries; remaining: ${remaining.join(', ') || 'nothing'}`;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

test('build arguments preserve paths and task variables without shell interpretation', () => {
  const source = '/project λ/source $(ignored).rkt', output = '/output λ/app';
  const plan = buildPlan({ action: 'executable', source, output, gui: true,
    libraries: ['racket/math'], languages: ['at-exp racket/base'] }, '/');
  assert.deepEqual(plan.args, ['exe', '--gui', '++lib', 'racket/math', '++lang', 'at-exp racket/base',
    '-o', executablePath(output, true), '--', source]);
  const variable = buildPlan({ action: 'executable', source: '${file}', output: '${workspaceFolder}/app' }, '/root');
  assert.equal(variable.source, '${file}');
  assert.ok(variable.output.startsWith('${workspaceFolder}/app'));
  assert.equal(executablePath('app', true, 'darwin'), 'app.app');
  assert.equal(executablePath('app.app', true, 'darwin'), 'app.app');
  assert.equal(executablePath('app', false, 'win32'), 'app.exe');
  assert.equal(executablePath('app.exe', true, 'win32'), 'app.exe');
});

test('invalid build definitions and direct input replacement are rejected', () => {
  const valid = { action: 'executable', source: 'main.rkt', output: 'app' };
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const update of [{ action: 'unknown' }, { source: '' }, { output: 'bad\0name' }, { gui: 'true' },
      { libraries: 'racket/math' }, { languages: [42] },
      { action: 'launcher', libraries: ['racket/math'] }, { action: 'distribution', gui: true },
      { action: 'distribution', source: 'app', output: './app' }]) {
      assert.throws(() => buildPlan({ ...valid, ...update }, '/project', platform));
    }
  }
  // An executable name receives its platform suffix before it is compared with the input.
  for (const platform of ['linux', 'darwin']) {
    for (const output of ['main.rkt', './main.rkt']) {
      assert.throws(() => buildPlan({ ...valid, output }, '/project', platform), /different from the input/);
    }
  }
  assert.equal(buildPlan({ ...valid, output: 'main.rkt' }, '/project', 'win32').output, 'main.rkt.exe');
  assert.equal(buildPlan({ ...valid, output: 'main.rkt', gui: true }, '/project', 'darwin').output, 'main.rkt.app');
  assert.throws(() => buildPlan({ ...valid, source: 'app.exe', output: 'app' }, '/project', 'win32'), /different from the input/);
  // Windows and macOS file systems treat names that differ only in case as one file.
  assert.throws(() => buildPlan({ ...valid, output: 'Main.rkt' }, '/project', 'darwin'), /different from the input/);
  assert.throws(() => buildPlan({ ...valid, source: 'App.EXE', output: 'app' }, '/project', 'win32'), /different from the input/);
  assert.equal(buildPlan({ ...valid, output: 'Main.rkt' }, '/project', 'linux').output, 'Main.rkt');
  assert.equal(executablePath('APP.EXE', false, 'win32'), 'APP.EXE');
});

test('public tools build a user-package launcher, embed modules and relocate runtime files', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket build λ '));
  t.after(() => removeTree(t, directory));
  const source = path.join(directory, 'source'), library = path.join(directory, 'library');
  await fs.mkdir(source); await fs.mkdir(library);
  await fs.writeFile(path.join(library, 'info.rkt'), '#lang info\n(define collection "build-example")\n(define deps \'("base"))\n');
  await fs.writeFile(path.join(library, 'main.rkt'), '#lang racket/base\n(provide answer)\n(define answer 42)\n');
  const env = { ...process.env, PLTADDONDIR: path.join(directory, 'addon') };
  await execute('racket', ['-l', 'raco', '--', 'pkg', 'install', '--scope', 'user', '--no-setup', '--deps', 'fail', '--link', '--', library], { env, timeout: 30000 });
  const program = path.join(source, 'main λ.rkt');
  await fs.writeFile(program, `#lang racket/base
(require build-example racket/runtime-path racket/file)
(define-runtime-path data "data.txt")
(displayln (list answer (file->string data) (vector->list (current-command-line-arguments))))
`);
  await fs.writeFile(path.join(source, 'data.txt'), 'payload λ');
  async function build(action, input, output, extra = {}) {
    const plan = buildPlan({ action, source: input, output, ...extra }, directory);
    await execute('racket', ['-l', 'raco', '--', ...plan.args], { cwd: directory, env, timeout: 60000 });
    return plan.output;
  }
  const launcher = await build('launcher', program, path.join(directory, 'launcher'));
  assert.match((await execute(launcher, ['argument λ'], { env })).stdout, /42 payload λ \(argument λ\)/);
  const exe = await build('executable', program, path.join(directory, 'app'));
  assert.match((await execute(exe, [], { env })).stdout, /42 payload λ/);
  const distribution = await build('distribution', exe, path.join(directory, 'distribution'));
  const moved = path.join(directory, 'moved distribution');
  await fs.rename(distribution, moved);
  await fs.rename(source, path.join(directory, 'hidden source'));
  await fs.rename(library, path.join(directory, 'hidden library'));
  const distributedExe = path.join(moved, ...(process.platform === 'win32' ? [] : ['bin']), path.basename(exe));
  const result = await execute(distributedExe, ['moved λ'], { cwd: os.tmpdir(), env });
  assert.match(result.stdout, /42 payload λ \(moved λ\)/);
  await assert.rejects(execute(launcher, [], { env }), /cannot open module file|no such file/i);
  // Embedded code remains usable without source; the undeployed runtime file does not.
  await assert.rejects(execute(exe, [], { env }), /data.txt|cannot open input file/i);
});

test('explicit dynamic libraries are embedded and compiler errors remain errors', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket dynamic build '));
  t.after(() => removeTree(t, directory));
  const program = path.join(directory, 'dynamic.rkt');
  await fs.writeFile(program, '#lang racket/base\n(displayln ((dynamic-require \'racket/math \'sqr) 7))\n');
  const plan = buildPlan({ action: 'executable', source: program, output: path.join(directory, 'app'), libraries: ['racket/math'] }, directory);
  await execute('racket', ['-l', 'raco', '--', ...plan.args], { timeout: 60000 });
  await fs.rename(program, path.join(directory, 'hidden.rkt'));
  assert.equal((await execute(plan.output)).stdout.trim(), '49');
  await fs.writeFile(program, '#lang racket/base\n(');
  await assert.rejects(execute('racket', ['-l', 'raco', '--', ...plan.args], { timeout: 60000 }), /expected a|read-syntax/);
});
