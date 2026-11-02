// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { setTimeout: delay } = require('node:timers/promises');
const { project } = require('./workspace-index-project');

const traced = { RACKETEER_INDEX_TRACE: '1' };
const untraced = { RACKETEER_INDEX_TRACE: undefined };
async function until(p, pattern, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (!pattern.test(p.diagnostics())) {
    assert.ok(Date.now() < deadline, `${pattern} not logged:\n${p.diagnostics()}`);
    await delay(50);
  }
}

test('a traced index names each worker and every wait it passes, with a monotonic time', { timeout: 120000 }, async t => {
  const p = await project(t, traced);
  await p.references(p.origin);
  const worker = /Workspace analysis worker at (\d+) ms: analyse \S*definition\.rkt: (.*)/g;
  const events = [...p.diagnostics().matchAll(worker)].slice(0, 5);
  assert.deepEqual(events.map(event => event[2].replace(/ after \d+ ms$/, '')),
    ['starting', 'started', 'kill requested', 'killed', 'reaped'], p.diagnostics());
  const times = events.map(event => Number(event[1]));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), p.diagnostics());
  assert.match(p.diagnostics(), /worker at \d+ ms: discover: starting/);
});

test('an untraced index logs no worker that starts and stops promptly', { timeout: 120000 }, async t => {
  const p = await project(t, untraced);
  await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.doesNotMatch(p.diagnostics(), /: (starting|kill requested)\n|timer at/);
});

test('a traced index shows its timer running at regular intervals', { timeout: 120000 }, async t => {
  const p = await project(t, traced);
  await until(p, /timer at \d+ ms: running\n[^]*timer at \d+ ms: running\n/, 30);
});

test('a pause of the whole server is reported when its timer wakes', { timeout: 120000,
  skip: process.platform === 'win32' }, async t => {
  const p = await project(t, untraced);
  // The timer runs once the server is serving: stopping it earlier leaves no tick to compare.
  await p.update();
  p.child.kill('SIGSTOP');
  await delay(7000);
  p.child.kill('SIGCONT');
  await until(p, /timer at \d+ ms: woke \d+ ms after it last ran\n/, 10);
});

test('an untraced index logs a worker that takes seconds to stop, naming its file', { timeout: 120000,
  skip: process.platform === 'win32' }, async t => {
  const p = await project(t, untraced);
  // A place cannot be killed out of a blocking C call, so the stop waits for it.
  p.write('stuck.rkt', `#lang racket/base
(require (for-syntax racket/base ffi/unsafe))
(begin-for-syntax ((get-ffi-obj "sleep" #f (_fun _uint -> _uint)) 15))\n`);
  p.settings.timeoutSeconds = 5;
  await p.update();
  const asking = p.references(p.origin).catch(() => {});
  await until(p, /worker at \d+ ms: analyse \S*stuck\.rkt: killed after \d+ ms\n[^]*stuck\.rkt: reaped after \d+ ms\n/, 90);
  assert.doesNotMatch(p.diagnostics(), /: (starting|kill requested)\n/);
  await asking;
});
