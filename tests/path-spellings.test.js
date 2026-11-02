// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// A folder or a file can be reached by more than one path, and a client, a launch
// configuration and the loader need not agree on which one they use.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('./support/node-test.js');
const { session } = require('./support/dap-trace.js');

const skip = process.platform === 'win32';
// A project in a folder, and a link to that folder.
function project(t, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-spellings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const real = path.join(directory, 'real');
  const link = path.join(directory, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(real, name), text);
  return { real, link };
}
const top = async ({ client, ok }, threadId) => (await ok(client.request('stackTrace', { threadId }))).stackFrames[0];

const called = {
  'main.rkt': '#lang racket/base\n(require "dep.rkt")\n(step)\n(step)\n',
  'dep.rkt': '#lang racket/base\n(provide step)\n(define (step)\n  (display "a")\n  (display "b"))\n'
};

test('a request replaces the breakpoints of its own spelling only', { skip }, async t => {
  const { real, link } = project(t, called);
  const lines = [];
  await session({ program: path.join(real, 'main.rkt'), cwd: real },
    { [path.join(link, 'dep.rkt')]: [4], [path.join(real, 'dep.rkt')]: [5] }, async context => {
      const { client, ok } = context;
      let stopped = await client.event('stopped');
      lines.push((await top(context, stopped.body.threadId)).line);
      // The file has loaded: both spellings now reach the one source.
      const locations = await ok(client.request('breakpointLocations', { source: { path: path.join(link, 'dep.rkt') }, line: 4 }));
      assert.ok(locations.breakpoints.length > 0);
      await ok(client.request('setBreakpoints', { source: { path: path.join(real, 'dep.rkt') }, breakpoints: [] }));
      await ok(client.request('continue', { threadId: stopped.body.threadId }));
      stopped = await client.event('stopped');
      lines.push((await top(context, stopped.body.threadId)).line);
      await ok(client.request('continue', { threadId: stopped.body.threadId }));
    });
  assert.deepEqual(lines, [4, 4]);
});

for (const [kind, make] of [['hard', fs.linkSync], ['symbolic', fs.symlinkSync]]) {
  for (const breakpoint of ['a.rkt', 'b.rkt']) {
    test(`a file loaded under two names through a ${kind} link keeps a breakpoint on ${breakpoint} in ${breakpoint}`, { skip }, async t => {
      const { real } = project(t, {
        'main.rkt': '#lang racket/base\n(require (prefix-in a: "a.rkt") (prefix-in b: "b.rkt"))\n(a:f)\n(b:f)\n',
        'a.rkt': '#lang racket/base\n(provide f)\n(define (f)\n  (display "x"))\n'
      });
      make(path.join(real, 'a.rkt'), path.join(real, 'b.rkt'));
      const stops = [];
      await session({ program: path.join(real, 'main.rkt'), cwd: real }, { [path.join(real, breakpoint)]: [4] }, async context => {
        const stopped = await context.client.event('stopped');
        stops.push(path.basename((await top(context, stopped.body.threadId)).source.path));
        await context.ok(context.client.request('continue', { threadId: stopped.body.threadId }));
      });
      assert.deepEqual(stops, [breakpoint]);
    });
  }
}
