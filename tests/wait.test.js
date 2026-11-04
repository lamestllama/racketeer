// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { until, deadline } = require('./support/wait');

test('a wait returns what its condition found, as soon as it finds it', async () => {
  let asked = 0;
  assert.equal(await until(() => ++asked === 3 && 'found'), 'found');
});

test('a wait still polls while a test holds a mocked timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let asked = 0;
  assert.equal(await until(() => ++asked === 3 && 'found'), 'found');
});

test('a wait that reaches the deadline names what it waited for', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const waiting = assert.rejects(until(() => false, 'the marker', () => 'details'), /Timed out: the marker details/);
  t.mock.timers.tick(deadline);
  await waiting;
});
