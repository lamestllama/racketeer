// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DapClient } = require('./dap-client');
const expected = require('./fixtures/wxme-debug/expected.json');
const ok = async p => { const r = await p; assert.equal(r.success, true, r.message); return r.body; };
async function launch(t, name, configuration = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wxme-debug-'));
  const file = path.join(directory, 'λ😀.rkt'); fs.copyFileSync(path.join(__dirname, 'fixtures/wxme-debug', name + '.wxme'), file);
  const client = new DapClient(); t.after(() => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap', linesStartAt1: true, columnsStartAt1: true }));
  await ok(client.request('launch', { program: file, cwd: directory, ...configuration })); await client.event('initialized');
  return { client, file };
}
async function sourceAtStop(client, name) {
  const stop = await client.event('stopped');
  const stack = await ok(client.request('stackTrace', { threadId: stop.body.threadId }));
  const frame = stack.stackFrames[0];
  const source = await ok(client.request('source', { sourceReference: frame.source.sourceReference }));
  assert.equal(source.content, expected[name]); assert.equal(source.mimeType, 'text/x-racket');
  return { stop, frame };
}
test('WXME breakpoint locations use decoded text, tabs and object positions and retain the loaded snapshot', async t => {
  const { client, file } = await launch(t, 'objects');
  await ok(client.request('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 6, column: 2 }] }));
  await ok(client.request('configurationDone'));
  const { stop, frame } = await sourceAtStop(client, 'objects');
  assert.equal(stop.body.reason, 'breakpoint'); assert.equal(frame.line, 6); assert.equal(frame.column, 2);
  const locations = await ok(client.request('breakpointLocations', { source: frame.source, line: 6 }));
  assert.ok(locations.breakpoints.some(b => b.line === 6 && b.column === 2));
  fs.writeFileSync(file, '#lang racket/base\n(error "changed on disk")\n');
  assert.equal((await ok(client.request('source', { sourceReference: frame.source.sourceReference }))).content, expected.objects);
  await ok(client.request('continue', { threadId: stop.body.threadId })); await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  assert.equal(client.events.filter(e => e.event === 'output' && e.body.category === 'stdout').map(e => e.body.output).join(''), '42\n');
});
test('WXME runtime exceptions identify the decoded expression with UTF-16 end columns', async t => {
  const { client } = await launch(t, 'runtime-error');
  await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] })); await ok(client.request('configurationDone'));
  const { stop, frame } = await sourceAtStop(client, 'runtime-error');
  assert.equal(stop.body.reason, 'exception'); assert.equal(frame.line, 6); assert.equal(frame.column, 2);
  assert.equal(frame.endLine, 6); assert.equal(frame.endColumn, expected['runtime-error'].split('\n')[5].length);
  assert.match(JSON.stringify(await ok(client.request('exceptionInfo', { threadId: stop.body.threadId }))), /boom λ😀/);
  await ok(client.request('continue', { threadId: stop.body.threadId })); await client.event('terminated'); assert.equal((await client.event('exited')).body.exitCode, 1);
});
for (const name of ['text', 'nested']) test(`WXME ${name} source opens a position-preserving debug snapshot`, async t => {
  const { client } = await launch(t, name, { stopOnEntry: true }); await ok(client.request('configurationDone'));
  const { stop } = await sourceAtStop(client, name);
  await ok(client.request('continue', { threadId: stop.body.threadId })); await client.event('terminated'); assert.equal((await client.event('exited')).body.exitCode, 0);
});
test('WXME syntax failures retain the public reader location and source bytes', async t => {
  const { client, file } = await launch(t, 'syntax-error'); const before = fs.readFileSync(file);
  await ok(client.request('configurationDone')); await client.event('terminated'); assert.equal((await client.event('exited')).body.exitCode, 1);
  const output = client.events.filter(e => e.event === 'output').map(e => e.body.output).join(''); assert.match(output, /:5:15: missing-name/);
  assert.deepEqual(fs.readFileSync(file), before);
});
