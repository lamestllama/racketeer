// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Debugs a real program of about a thousand lines that is not part of this
// repository: the MIT-licensed Tetris at the pinned commit below. Its archive
// is fetched at test time into the untracked test output folder, never into
// the source tree or the package.
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');

const execute = promisify(execFile);
const commit = 'bbf9dc58b8b1606f574ebf1a466eeef278689a68';
const url = `https://codeload.github.com/mosceo/tetris/zip/${commit}`;
const sha256 = '8ff1dca0f912f42a94b6a5ee17c3892a25660303f17452f7f22935175284f343';
const cached = path.resolve(__dirname, '..', '.test-output', 'third-party', `tetris-${commit}.zip`);
const deadline = 120000;
// tetris.rkt requires 2htdp/universe, whose toolkit needs a display on Linux.
// There scripts/test-gui.py runs this suite; Windows and macOS always have one.
const options = { skip: process.platform === 'linux' && !process.env.DISPLAY };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}

async function fetchArchive() {
  const existing = await fs.readFile(cached).catch(() => null);
  if (existing && digest(existing) === sha256) return { file: cached };
  let data;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { failure: `Cannot download ${url}: ${error.cause?.code || error.cause?.message || error.message}` };
  }
  assert.equal(digest(data), sha256, `Archive checksum mismatch: ${url}`);
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(`${cached}.partial`, data);
  await fs.rename(`${cached}.partial`, cached);
  return { file: cached };
}
let archive;
// The folder holding the extracted program, or nothing once the test has been
// skipped. Without a network only a local run skips, so CI cannot stop running it.
async function extract(t) {
  const { file, failure } = await (archive ||= fetchArchive());
  if (failure) {
    assert.ok(!process.env.CI, failure);
    t.skip(failure);
    return null;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racketeer-third-party-'));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  await execute('racket', ['-l', 'racket/base', '-l', 'file/unzip', '-e', `(unzip ${JSON.stringify(file)})`], { cwd: directory });
  return path.join(directory, `tetris-${commit}`);
}
// Selects the source as the extension does for a workspace holding the program.
async function launch(t, directory, breakpoints = []) {
  const client = new DapClient(undefined, { timeout: deadline });
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', {
    program: path.join(directory, 'unittest.rkt'), cwd: directory, sourceRoots: [directory]
  }));
  await client.event('initialized');
  const source = { path: path.join(directory, 'tetris.rkt') };
  const set = await ok(client.request('setBreakpoints', { source, breakpoints }));
  await ok(client.request('configurationDone'));
  return { client, source, set };
}
// Exit code 0 alone would hide a failing check, which RackUnit only prints.
async function finishes(client) {
  await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  const output = client.events.filter(event => event.event === 'output').map(event => event.body.output).join('');
  assert.doesNotMatch(output, /FAILURE|ERROR/, output);
}

test('a real program of about a thousand lines runs to exit 0 under the debugger within its deadline', options, async t => {
  const directory = await extract(t);
  if (!directory) return;
  const start = Date.now();
  const { client } = await launch(t, directory);
  await finishes(client);
  const elapsed = Date.now() - start;
  t.diagnostic(`Debug session took ${elapsed} ms`);
  assert.ok(elapsed < deadline, `Debug session took ${elapsed} ms`);
});

test('a breakpoint in a real program stops inside its function with named locals, then the program exits 0', options, async t => {
  const directory = await extract(t);
  if (!directory) return;
  const text = await fs.readFile(path.join(directory, 'tetris.rkt'), 'utf8');
  const line = text.split(/\r?\n/).indexOf('  (define entry (list-ref (row-entries r) x))') + 1;
  assert.ok(line > 0);
  const { client, source, set } = await launch(t, directory, [{ line }]);
  const stop = await client.event('stopped');
  assert.equal(stop.body.reason, 'breakpoint');
  assert.deepEqual(stop.body.hitBreakpointIds, [set.breakpoints[0].id]);
  const { threadId } = stop.body;
  const { stackFrames: [frame] } = await ok(client.request('stackTrace', { threadId }));
  assert.equal(path.basename(frame.source.path), 'tetris.rkt');
  assert.equal(frame.line, line);
  const { scopes } = await ok(client.request('scopes', { frameId: frame.id }));
  const { variables } = await ok(client.request('variables', {
    variablesReference: scopes.find(scope => scope.name === 'Locals').variablesReference
  }));
  const value = name => variables.find(variable => variable.name === name)?.value;
  assert.equal(value('x'), '2', JSON.stringify(variables));
  assert.equal(value('new-count'), '2', JSON.stringify(variables));
  const { breakpoints: [verified] } = await ok(client.request('setBreakpoints', { source, breakpoints: [{ line }] }));
  assert.equal(verified.verified, true);
  await ok(client.request('setBreakpoints', { source, breakpoints: [] }));
  await ok(client.request('continue', { threadId }));
  await finishes(client);
});
