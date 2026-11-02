// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// The debugger compiled once into storage, through racketdap/launcher.rkt. Each test
// runs a copy of the sources, as an installed extension holds them: no compiled files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('./support/node-test');
const { DapClient } = require('./dap-client');
const { debuggerArgs } = require('../vscode/language-process');

const repository = path.resolve(__dirname, '..');
function folder(t) {
  // A space, because extension and storage folders can hold one.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debugger launch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const racketdap = path.join(directory, 'racketdap');
  fs.cpSync(path.join(repository, 'racketdap'), racketdap, { recursive: true, filter: file => path.basename(file) !== 'compiled' });
  const program = path.join(directory, 'program.rkt');
  fs.writeFileSync(program, '#lang racket/base\n(displayln "finished")\n');
  return { directory, racketdap, program, storage: path.join(directory, 'storage') };
}
const launcherArgs = ({ racketdap, storage }, file = 'main.rkt') =>
  [path.join(racketdap, 'launcher.rkt'), storage, path.join(racketdap, file)];
// One session, with these arguments to Racket; returns what it wrote.
async function session(args, program, { env, launch = {} } = {}) {
  const client = new DapClient(undefined, { timeout: 120000,
    spawn: (command, _args, options) => spawn(command, args, { ...options, env: { ...process.env, ...env } }) });
  try {
    const ok = async request => { const response = await request; assert.equal(response.success, true, response.message); };
    await ok(client.request('initialize', { adapterID: 'racketdap' }));
    await ok(client.request('launch', { program, cwd: path.dirname(program), ...launch }));
    await client.event('initialized');
    await ok(client.request('configurationDone'));
    await client.event('terminated');
    await client.close();
    const output = client.events.filter(event => event.event === 'output').map(event => event.body.output).join('');
    return { output, stderr: client.stderr };
  } finally { await client.close().catch(() => {}); }
}
const entries = storage => fs.existsSync(storage) ? fs.readdirSync(storage).sort() : [];
const finished = storage => entries(storage).filter(name => !/\.(building|stale-.*)$/.test(name));
// What a launch leaves to finish in the background.
async function built(storage, count = 1) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (!entries(storage).some(name => name.endsWith('.building')) && finished(storage).length >= count) return finished(storage);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No build finished: ${entries(storage)}`);
}
const compiledFiles = directory => fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith('.zo')).map(String);
const inBuild = (storage, build, file) => path.join(storage, build, compiledFiles(path.join(storage, build)).find(name => name.endsWith(file)));

// A value fixed when the file compiles: the same in two runs only if neither compiled it.
function stamp(file, label, before) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(before));
  fs.writeFileSync(file, text.replace(before, `(require (for-syntax racket/base))
(define-syntax (compile-stamp stx) (datum->syntax #'here (current-inexact-milliseconds)))
(eprintf "${label} ~a\\n" (compile-stamp))
${before}`));
}
const stamps = (text, label) => [...text.matchAll(new RegExp(`${label} ([0-9.]+)`, 'g'))].map(match => match[1]);

test('a launch runs from source and starts the build, and later launches load compiled code', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { racketdap, storage, program } = files;
  stamp(path.join(racketdap, 'main.rkt'), 'adapter', '(define input (current-input-port))');
  stamp(path.join(racketdap, 'worker/main.rkt'), 'worker', '(define bootstrap (read-message');
  stamp(path.join(racketdap, 'worker/expand.rkt'), 'expander', '(provide instrument-form');
  const run = async () => {
    const { output, stderr } = await session(launcherArgs(files), program);
    assert.match(output, /finished/);
    return { adapter: stamps(stderr, 'adapter'), worker: stamps(output, 'worker'), expander: stamps(output, 'expander') };
  };
  const first = await run();
  await built(storage);
  const second = await run();
  const third = await run();
  for (const part of ['adapter', 'worker', 'expander']) {
    assert.equal(third[part].length, 1, part);
    assert.deepEqual(third[part], second[part], `${part} compiled once`);
    assert.notDeepEqual(second[part], first[part], `${part} left its source`);
  }
  assert.equal(compiledFiles(racketdap).length, 0, 'Nothing is written beside the sources');
  assert.equal(finished(storage).length, 1);
});

test('a program and its children see what they see without the launcher', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { directory, racketdap, storage } = files;
  const program = path.join(directory, 'settings.rkt');
  fs.writeFileSync(program, `#lang racket/base
(require racket/system)
(write (list (current-compiled-file-roots) (use-compiled-file-check) (use-compiled-file-paths)
             (current-command-line-arguments) (find-system-path 'run-file)
             (current-library-collection-paths) (print-as-expression) (error-print-width)
             (getenv "PLTCOMPILEDROOTS") (getenv "PLT_COMPILED_FILE_ROOTS")
             (for/list ([name (environment-variables-names (current-environment-variables))]
                        #:when (regexp-match? #rx#"^PLT" name))
               name)))
(system* (find-executable-path "racket") "-l" "racket/base" "-e" "(write (current-compiled-file-roots))")
`);
  const launch = { args: ['an argument'] };
  await session(launcherArgs(files), program, { launch });
  await built(storage);
  const launched = await session(launcherArgs(files), program, { launch });
  const direct = await session([path.join(racketdap, 'main.rkt')], program, { launch });
  assert.equal(launched.output, direct.output);
  assert.ok(!launched.output.includes('storage'), launched.output);
  assert.ok(launched.output.includes(path.join('worker', 'main.rkt')), `The run file is unchanged: ${launched.output}`);
});

for (const [name, damage] of [
  ['a compiled file with a changed byte', file => { const bytes = fs.readFileSync(file); bytes[bytes.length >> 1] ^= 0xff; fs.writeFileSync(file, bytes); }],
  ['a cut short compiled file', file => fs.truncateSync(file, fs.statSync(file).size >> 1)],
  ['a missing compiled file', file => fs.rmSync(file)]
]) {
  test(`${name} runs from source and is compiled again`, { timeout: 300000 }, async t => {
    const files = folder(t);
    const { storage, program } = files;
    await session(launcherArgs(files), program);
    const [build] = await built(storage);
    const file = inBuild(storage, build, path.join('worker', 'compiled', 'session_rkt.zo'));
    const whole = fs.readFileSync(file);
    damage(file);
    assert.match((await session(launcherArgs(files), program)).output, /finished/);
    await built(storage);
    assert.deepEqual(fs.readFileSync(file), whole);
    assert.match((await session(launcherArgs(files), program)).output, /finished/);
    assert.deepEqual(finished(storage), [build]);
  });
}

test('a damaged manifest runs from source and is compiled again', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { storage, program } = files;
  await session(launcherArgs(files), program);
  const [build] = await built(storage);
  const manifest = path.join(storage, build, 'manifest.rktd');
  fs.writeFileSync(manifest, '(((');
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
  await built(storage);
  assert.notEqual(fs.readFileSync(manifest, 'utf8'), '(((');
});

for (const [name, spoil] of [
  ['storage that is a file', ({ storage }) => fs.writeFileSync(storage, 'a file')],
  ['storage that cannot be written', ({ storage }) => { fs.mkdirSync(storage); fs.chmodSync(storage, 0o555); }],
  ['storage under a file', files => { fs.writeFileSync(files.storage, 'a file'); files.storage = path.join(files.storage, 'below'); }]
]) {
  test(`with ${name} the debugger runs from source`,
    { timeout: 300000, skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
      const files = folder(t);
      const spoilt = files.storage;
      spoil(files);
      const before = fs.statSync(spoilt).isDirectory() ? entries(spoilt) : null;
      try {
        assert.match((await session(launcherArgs(files), files.program)).output, /finished/);
        if (before) assert.deepEqual(entries(spoilt), before);
      } finally { if (before) fs.chmodSync(spoilt, 0o755); }
    });
}

test('a storage path holding the list separator is an ordinary path', { timeout: 300000, skip: process.platform === 'win32' }, async t => {
  const files = folder(t);
  files.storage = path.join(files.directory, 'a:b');
  await session(launcherArgs(files), files.program);
  const [build] = await built(files.storage);
  assert.ok(compiledFiles(path.join(files.storage, build)).length);
  assert.match((await session(launcherArgs(files), files.program)).output, /finished/);
});

test('two first sessions at once both run and leave one usable build', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { storage, program } = files;
  for (const { output } of await Promise.all([session(launcherArgs(files), program), session(launcherArgs(files), program)]))
    assert.match(output, /finished/);
  await built(storage);
  assert.equal(entries(storage).length, 1, entries(storage).join());
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
});

test('changed sources are compiled again under the same folder', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { racketdap, storage, program } = files;
  stamp(path.join(racketdap, 'worker/main.rkt'), 'worker', '(define bootstrap (read-message');
  await session(launcherArgs(files), program);
  const [build] = await built(storage);
  const manifest = path.join(storage, build, 'manifest.rktd');
  const before = fs.readFileSync(manifest);
  // Reinstalling a build under the same version changes files in the same place.
  fs.appendFileSync(path.join(racketdap, 'protocol.rkt'), ';; edited\n');
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
  await built(storage);
  assert.notDeepEqual(fs.readFileSync(manifest), before);
  assert.deepEqual(finished(storage), [build]);
  const stamped = async () => stamps((await session(launcherArgs(files), program)).output, 'worker');
  assert.deepEqual(await stamped(), await stamped());
});

test('another Racket setup gets a folder of its own and leaves the first', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { directory, storage, program } = files;
  await session(launcherArgs(files), program);
  const [first] = await built(storage);
  assert.match((await session(launcherArgs(files), program, { env: { PLTADDONDIR: path.join(directory, 'addon') } })).output, /finished/);
  const both = await built(storage, 2);
  assert.ok(both.includes(first));
  assert.equal(both.length, 2);
});

test('the build waits until the worker has connected, or has failed to', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { storage, program } = files;
  const client = new DapClient(undefined, { timeout: 120000,
    spawn: (command, _args, options) => spawn(command, launcherArgs(files), options) });
  t.after(() => client.close().catch(() => {}));
  await client.request('initialize', { adapterID: 'racketdap' });
  assert.deepEqual(entries(storage), []);
  const launched = client.request('launch', { program, cwd: path.dirname(program) });
  await client.event('initialized');
  await launched;
  await client.request('configurationDone');
  await client.event('terminated');
  assert.equal(entries(storage).length, 1);
  await built(storage);

  const again = folder(t);
  const failing = new DapClient(undefined, { timeout: 120000,
    spawn: (command, _args, options) => spawn(command, launcherArgs(again), options) });
  t.after(() => failing.close().catch(() => {}));
  await failing.request('initialize', { adapterID: 'racketdap' });
  // A worker that never connects, as one too slow to start does not.
  const refused = await failing.request('launch', { program: again.program, cwd: again.directory, racketExecutable: process.platform === 'win32' ? 'cmd' : 'false' });
  assert.equal(refused.success, false);
  await built(again.storage);
  await failing.close();
});

test('a building folder holds off a second build until it is abandoned', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { storage, program } = files;
  await session(launcherArgs(files), program);
  const [build] = await built(storage);
  fs.rmSync(path.join(storage, build), { recursive: true });
  const building = path.join(storage, `${build}.building`);
  fs.mkdirSync(building);
  fs.writeFileSync(path.join(building, 'in progress'), '');
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
  assert.deepEqual(entries(storage), [`${build}.building`]);
  assert.ok(fs.existsSync(path.join(building, 'in progress')));
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(building, old, old);
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
  await built(storage);
  assert.deepEqual(finished(storage), [build]);
  assert.equal(entries(storage).length, 1, entries(storage).join());
});

test('the extension starts debugger files through the launcher when it has storage', () => {
  const context = { asAbsolutePath: file => `/extension/${file}` };
  assert.deepEqual(debuggerArgs(context, 'main.rkt'), ['/extension/runtime/racketdap/main.rkt']);
  assert.deepEqual(debuggerArgs({ ...context, globalStorageUri: { fsPath: '/storage' } }, 'tools/macro-stepper.rkt'),
    ['/extension/runtime/racketdap/launcher.rkt', path.join('/storage', 'debugger'), '/extension/runtime/racketdap/tools/macro-stepper.rkt']);
});
