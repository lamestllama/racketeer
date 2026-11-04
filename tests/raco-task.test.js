// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { removeQuietly } = require('./cleanup');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const listeners = { process: new Set(), task: new Set(), cancel: new Set() };
  let launches = 0, terminated = 0, duringStart;
  const event = key => listener => { listeners[key].add(listener); return { dispose() { listeners[key].delete(listener); } }; };
  const fire = (key, value) => { for (const listener of listeners[key]) listener(value); };
  const token = { isCancellationRequested: false, onCancellationRequested: event('cancel') };
  const vscode = {
    Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); } },
    ProcessExecution: class { constructor(process, args, options) { Object.assign(this, { process, args, options }); } },
    TaskScope: { Workspace: 2 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
    tasks: {
      onDidEndTaskProcess: event('process'), onDidEndTask: event('task'),
      async executeTask(task) {
        launches++;
        const execution = { task, terminate() { terminated++; fire('task', { execution }); } };
        await duringStart?.(execution);
        return execution;
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vscode/raco-task.js'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require(name)
  });
  return { ...module.exports, listeners, fire, token,
    start(callback) { duringStart = callback; }, launches: () => launches, terminated: () => terminated };
}

test('immediate task exit is observed and unrelated task events cannot finish it', async () => {
  const h = harness();
  const task = h.racoTask({ executable: '/racket λ', cwd: '/project λ' }, 'Build', ['exe', 'main λ.rkt']);
  h.start(execution => {
    h.fire('process', { execution: { task: { definition: { id: 'other' } } }, exitCode: 0 });
    h.fire('process', { execution, exitCode: 7 });
    h.fire('task', { execution });
  });
  assert.equal((await h.runTask(task)).exitCode, 7);
  assert.deepEqual(Array.from(task.execution.args), ['-l', 'raco', '--', 'exe', 'main λ.rkt']);
  assert.equal(task.execution.options.cwd, '/project λ');
  assert.ok(Object.values(h.listeners).every(value => value.size === 0));
});

test('cancellation before launch and during startup releases the owned task and listeners', async () => {
  const h = harness(), task = h.racoTask({ executable: 'racket', cwd: '/' }, 'Build', ['exe']);
  h.token.isCancellationRequested = true;
  assert.equal((await h.runTask(task, h.token)).exitCode, undefined);
  assert.equal(h.launches(), 0);
  h.token.isCancellationRequested = false;
  h.start(() => { h.token.isCancellationRequested = true; h.fire('cancel'); });
  assert.equal((await h.runTask(task, h.token)).exitCode, undefined);
  assert.equal(h.terminated(), 1);
  assert.ok(Object.values(h.listeners).every(value => value.size === 0));
});

test('tasks that cannot start settle and failed launches release listeners', async () => {
  const h = harness(), task = h.racoTask({ executable: 'missing', cwd: '/' }, 'Build', []);
  h.start(execution => h.fire('task', { execution }));
  assert.equal((await h.runTask(task)).exitCode, undefined);
  h.start(() => { throw new Error('launch failed'); });
  await assert.rejects(h.runTask(task), /launch failed/);
  assert.ok(Object.values(h.listeners).every(value => value.size === 0));
});

for (const signal of ['SIGHUP', 'SIGKILL']) {
  test(`an owned task ends its compile-time descendants when it receives ${signal}`, { skip: process.platform === 'win32' && 'POSIX signals; Windows uses a job object' }, async t => {
    const { spawn } = require('node:child_process');
    const os = require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racket owned build '));
    const pids = path.join(directory, 'pids');
    let descendants = [];
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    t.after(() => {
      for (const pid of descendants) if (alive(pid)) process.kill(pid, 'SIGKILL');
      removeQuietly(directory);
    });
    // A compile-time child that ignores breaks starts a grandchild, then both wait.
    fs.writeFileSync(path.join(directory, 'slow.rkt'), `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (define racket (path->string (find-executable-path (find-system-path 'exec-file))))
  (subprocess (current-output-port) #f (current-error-port) racket "-e"
    (format "~s" \`(begin (require racket/os) (break-enabled #f)
      (define-values (grandchild o i e)
        (subprocess (current-output-port) #f (current-error-port) ,racket "-e" "(sync never-evt)"))
      (with-output-to-file ,${JSON.stringify(pids)} #:exists 'truncate
        (lambda () (write (list (getpid) (subprocess-pid grandchild)))))
      (sync never-evt))))
  (sync never-evt))
`);
    const task = harness().racoTask({ executable: 'racket', cwd: directory,
      owner: path.join(__dirname, '../racketdap/tools/owned-command.rkt') },
    'Build', ['exe', '-o', path.join(directory, 'slow'), '--', path.join(directory, 'slow.rkt')]);
    const child = spawn(task.execution.process, task.execution.args, { cwd: task.execution.options.cwd, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    await until(() => fs.existsSync(pids) || !fs.readFileSync(pids, 'utf8').trim(), 'The compile-time child started');
    descendants = fs.readFileSync(pids, 'utf8').replace(/[()]/g, '').trim().split(/\s+/).map(Number);
    // VS Code's terminal sends SIGHUP when a task is terminated.
    child.kill(signal);
    await exited;
    await until(() => !(descendants.some(alive)));
    assert.deepEqual(descendants.filter(alive), [], 'No descendant outlives the task');
  });
}
