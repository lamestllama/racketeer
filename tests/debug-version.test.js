// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDebugVersionCheck } = require('../vscode/debug-version');

test('debug version checks share only successful checks of the same executable and environment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-version-'));
  const executable = path.join(directory, 'racket');
  fs.writeFileSync(executable, 'first', { mode: 0o755 });
  const environment = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment); });
  const calls = [];
  const check = createDebugVersionCheck((file, args, options) => new Promise((resolve, reject) => calls.push({ file, args, options, resolve, reject })));
  const current = () => calls.at(-1).resolve({ stdout: 'Welcome to Racket v9.1 [cs].' });
  const first = check(executable), shared = check(executable);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  current();
  assert.deepEqual(await Promise.all([first, shared]), [undefined, undefined]);
  assert.equal(await check(executable), undefined);
  assert.equal(calls.length, 1);

  // Replacement still invalidates if size and modification time were retained.
  const stat = fs.statSync(executable), replacement = path.join(directory, 'replacement');
  fs.writeFileSync(replacement, 'other', { mode: 0o755 });
  fs.utimesSync(replacement, stat.atime, stat.mtime);
  fs.renameSync(replacement, executable);
  const replaced = check(executable);
  await Promise.resolve(); assert.equal(calls.length, 2); current(); await replaced;

  process.env.RACKETDAP_VERSION_TEST = 'changed';
  const changed = check(executable);
  await Promise.resolve(); assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).options.env.RACKETDAP_VERSION_TEST, 'changed');
  current(); await changed;

  process.env.PATH = directory + path.delimiter + environment.PATH;
  const selected = check('racket');
  await Promise.resolve(); assert.equal(calls.length, 4); current(); await selected;
  const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-version-'));
  const second = path.join(secondDirectory, 'racket'); fs.writeFileSync(second, 'second', { mode: 0o755 });
  process.env.PATH = secondDirectory + path.delimiter + environment.PATH;
  const resolved = check('racket');
  await Promise.resolve(); assert.equal(calls.length, 5);
  calls.at(-1).resolve({ stdout: 'Welcome to Racket v9.0 [cs].' });
  assert.match(await resolved, /too old/);
  const retry = check('racket');
  await Promise.resolve(); assert.equal(calls.length, 6);
  calls.at(-1).reject(new Error('probe failed'));
  await assert.rejects(retry, /probe failed/);
  const recovered = check('racket');
  await Promise.resolve(); assert.equal(calls.length, 7); current(); await recovered;
  assert.equal(await check('racket'), undefined); assert.equal(calls.length, 7);
  fs.unlinkSync(second);
  const removed = check('racket');
  await Promise.resolve(); assert.equal(calls.length, 8); current(); await removed;
});
