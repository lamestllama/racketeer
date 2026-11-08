// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { sessionWait } = require('./support/session-wait');

const session = { id: 'target', file: 'tests/attach.rkt' };
const other = { id: 'other', file: 'tests/wxme-source.rkt' };
const summary = { session, event: 'racketdap/test', body: { kind: 'summary' } };
const findSummary = own => own.find(message => message.event === 'racketdap/test' && message.body.kind === 'summary');

for (const ending of ['terminated', 'editor termination', 'launch failure', 'tracker exit', 'tracker error']) {
  test(`a missing summary fails immediately on ${ending} with only its session's diagnostics`, async () => {
    const messages = [
      { session, type: 'response', command: 'launch', success: ending !== 'launch failure', message: 'launch details' },
      { session, event: 'output', body: { output: 'worker startup failed' } },
      { ...summary, session: other, body: { kind: 'summary', total: 9 } }
    ];
    const ended = new Set();
    if (ending === 'terminated') messages.push({ session, event: 'terminated' });
    if (ending === 'editor termination') ended.add(session.id);
    if (ending.startsWith('tracker')) {
      messages.push({ session, [ending]: 'adapter details' }); ended.add(session.id);
    }
    const wait = sessionWait(messages, ended, session => session.file);
    await assert.rejects(wait(session, findSummary, 'racketdap/test summary'), error => {
      assert.match(error.message, /Session ended before tests\/attach.rkt: racketdap\/test summary/);
      assert.match(error.message, /launch details/);
      assert.match(error.message, /worker startup failed/);
      assert.doesNotMatch(error.message, /wxme|Timed out/);
      if (ending.startsWith('tracker')) assert.match(error.message, /adapter details/);
      return true;
    });
  });
}

test('a recorded summary is returned even after its session ends', async () => {
  const wait = sessionWait([summary, { session, event: 'terminated' }], new Set([session.id]), session => session.file);
  assert.equal(await wait(session, findSummary, 'summary'), summary);
});

test('an unrelated session ending does not interrupt an event wait', async () => {
  const messages = [{ session: other, event: 'terminated' }];
  const wait = sessionWait(messages, new Set([other.id]), session => session.file);
  const pending = wait(session, findSummary, 'summary');
  messages.push(summary);
  assert.equal(await pending, summary);
});

test('an event timeout names its file and includes only that session', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now += 240001);
  const messages = [{ session, event: 'output', body: { output: 'still starting' } },
    { session: other, event: 'output', body: { output: 'unrelated output' } }];
  const wait = sessionWait(messages, new Set(), session => session.file);
  await assert.rejects(wait(session, findSummary, 'summary'), error => {
    assert.match(error.message, /Timed out: tests\/attach.rkt: summary/);
    assert.match(error.message, /still starting/);
    assert.doesNotMatch(error.message, /wxme|unrelated output/);
    return true;
  });
});
