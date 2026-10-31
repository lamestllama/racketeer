'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
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
