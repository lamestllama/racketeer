// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// The debugger compiled once into storage, through racketdap/launcher.rkt. Each test
// runs a copy of the sources, as an installed extension holds them: no compiled files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('./support/node-test');
const { DapClient } = require('./dap-client');
const { debuggerArgs } = require('../vscode/language-process');

const repository = path.resolve(__dirname, '..');
function folder(t) {
  // A space, because extension and storage folders can hold one.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debugger launch-'));
  // A builder that has made its folder visible still tidies before it exits.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
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
  const client = new DapClient(undefined, { timeout: 120000, leavesProcess: true,
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
  // Imported, not named on any command line: both processes load it this way.
  stamp(path.join(racketdap, 'protocol.rkt'), 'imported', '(define max-message');
  stamp(path.join(racketdap, 'worker/main.rkt'), 'worker', '(define bootstrap (read-message');
  stamp(path.join(racketdap, 'worker/expand.rkt'), 'expander', '(provide instrument-form');
  const run = async () => {
    const { output, stderr } = await session(launcherArgs(files), program);
    assert.match(output, /finished/);
    return { adapter: stamps(stderr, 'adapter'), worker: stamps(output, 'worker'), expander: stamps(output, 'expander'),
      adapterImport: stamps(stderr, 'imported'), workerImport: stamps(output, 'imported') };
  };
  const first = await run();
  await built(storage);
  const second = await run();
  const third = await run();
  for (const part of ['adapter', 'worker', 'expander', 'adapterImport', 'workerImport']) {
    assert.equal(third[part].length, 1, part);
    assert.deepEqual(third[part], second[part], `${part} compiled once`);
    assert.notDeepEqual(second[part], first[part], `${part} left its source`);
  }
  assert.equal(compiledFiles(racketdap).length, 0, 'Nothing is written beside the sources');
  assert.equal(finished(storage).length, 1);
  const [build] = finished(storage);
  assert.deepEqual(compiledFiles(path.join(storage, build)).filter(name => !name.split(path.sep).includes('racketdap')), [],
    'The build holds the debugger, not the libraries it uses');
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
  assert.match(launched.output, /worker[\\/]main\.rkt/, 'The run file is unchanged');
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

// The name the launcher gives its folder under these settings.
function folderName(launcher, env) {
  const modulePath = `(file ${JSON.stringify(launcher)})`;
  const key = spawnSync('racket', ['-e', `(begin
    (dynamic-require '${modulePath} #f)
    (parameterize ([current-namespace (module->namespace '${modulePath})])
      (display (eval '(folder-name)))))`], { encoding: 'utf8', env });
  assert.equal(key.status, 0, key.stderr);
  return key.stdout;
}
// Runs the builder directly, as a launch starts it, and returns the folder it publishes to.
function build({ racketdap, storage }, env) {
  const name = folderName(path.join(racketdap, 'launcher.rkt'), env);
  const building = path.join(storage, `${name}.building`), destination = path.join(storage, name);
  fs.mkdirSync(building, { recursive: true });
  const finishedBuild = spawnSync('racket', [path.join(racketdap, 'tools/compile-debugger.rkt'), building, destination],
    { encoding: 'utf8', env, timeout: 240000 });
  assert.equal(finishedBuild.status, 0, finishedBuild.stderr);
  return destination;
}

test('a source replaced during the build cannot certify the code compiled from what it replaced', { timeout: 300000 }, async t => {
  const files = folder(t);
  const target = path.join(files.racketdap, 'snapshot-probe.rkt');
  const replacement = '#lang racket/base\n(displayln "CURRENT")\n';
  // What an installer does when it replaces a file the compiler has already read.
  fs.writeFileSync(target, `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(target)} #:exists 'truncate
    (lambda (out) (display ${JSON.stringify(replacement)} out))))
(displayln "FORMER")
`);
  build(files);
  const launched = spawnSync('racket', [path.join(files.racketdap, 'launcher.rkt'), files.storage, target], { encoding: 'utf8', timeout: 30000 });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout, 'CURRENT\n');
});

test('a builder resuming after its folder was taken over leaves its successor alone', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { racketdap, storage } = files;
  const entered = path.join(storage, 'entered'), release = path.join(storage, 'release');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(racketdap, 'takeover-probe.rkt'), `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(entered)} #:exists 'truncate void)
  (let wait () (unless (file-exists? ${JSON.stringify(release)}) (sleep 0.05) (wait))))
`);
  const name = folderName(path.join(racketdap, 'launcher.rkt'));
  const building = path.join(storage, `${name}.building`), destination = path.join(storage, name);
  fs.mkdirSync(building);
  const builder = spawn('racket', [path.join(racketdap, 'tools/compile-debugger.rkt'), building, destination], { stdio: 'ignore' });
  const ended = new Promise(resolve => builder.once('close', resolve));
  t.after(() => { builder.kill('SIGKILL'); return ended; });
  const deadline = Date.now() + 240000;
  while (!fs.existsSync(entered)) {
    assert.ok(Date.now() < deadline, 'The builder never reached the probe');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // What a later launch does to a folder it takes for abandoned.
  fs.renameSync(building, `${destination}.stale-1`);
  fs.mkdirSync(building);
  const successor = path.join(building, 'successor');
  fs.writeFileSync(successor, '');
  fs.writeFileSync(release, '');
  await ended;
  assert.ok(fs.existsSync(successor), 'The successor keeps its folder');
  assert.ok(!fs.existsSync(destination), 'Nothing is published from a folder that was taken over');
});

// A library on the collection path, behind a re-export, and a debugger file whose
// expansion holds what the library's macro says. Its dates are in the past, as for
// anything installed before a build began.
function libraryProject(t) {
  const files = folder(t);
  const library = path.join(files.directory, 'collects', 'launch-library');
  fs.mkdirSync(library, { recursive: true });
  const macro = path.join(library, 'macro.rkt');
  const write = answer => fs.writeFileSync(macro, `#lang racket/base\n(provide answer)\n(define-syntax-rule (answer) (quote ${answer}))\n`);
  write('FORMER');
  fs.writeFileSync(path.join(library, 'main.rkt'), '#lang racket/base\n(require "macro.rkt")\n(provide answer)\n');
  const target = path.join(files.racketdap, 'library-probe.rkt');
  fs.writeFileSync(target, '#lang racket/base\n(require launch-library)\n(displayln (answer))\n');
  const env = { ...process.env, PLTCOLLECTS: `${path.dirname(library)}${path.delimiter}${process.env.PLTCOLLECTS || ''}` };
  const age = () => {
    const past = new Date(Date.now() - 3600000);
    for (const file of fs.readdirSync(library, { recursive: true })) fs.utimesSync(path.join(library, String(file)), past, past);
  };
  const launch = () => {
    const launched = spawnSync('racket', [path.join(files.racketdap, 'launcher.rkt'), files.storage, target], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(launched.status, 0, launched.stderr);
    return launched.stdout;
  };
  age();
  return { files, library, macro, write, target, env, age, launch };
}

test('a library upgraded after the build runs the debugger from source, behind a re-export too', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  const published = build(p.files, p.env);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')), 'The baseline needs a published build');
  assert.equal(p.launch(), 'FORMER\n');
  // The same length, so only the date tells.
  p.write('LATTER');
  assert.equal(p.launch(), 'LATTER\n');
});

test('a library dated in the future does not stop the build', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  const later = new Date(Date.now() + 3600000);
  fs.utimesSync(p.macro, later, later);
  assert.ok(fs.existsSync(path.join(build(p.files, p.env), 'manifest.rktd')), 'Otherwise every launch builds and nothing is published');
});

test('a library replaced during the build is not certified by what it became', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  fs.writeFileSync(path.join(p.files.racketdap, 'library-replacer.rkt'), `#lang racket/base
(require launch-library (for-syntax racket/base))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(p.macro)} #:exists 'truncate
    (lambda (out) (display ${JSON.stringify('#lang racket/base\n(provide answer)\n(define-syntax-rule (answer) (quote LATTER))\n')} out))))
`);
  const published = build(p.files, p.env);
  assert.ok(!fs.existsSync(published), 'A build that saw its library change is not published');
  assert.equal(p.launch(), 'LATTER\n');
});

test('a library with only compiled code keeps the build, until that code is replaced', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  const compileOnly = () => {
    const made = spawnSync('raco', ['make', p.macro], { env: p.env, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    fs.unlinkSync(p.macro);
  };
  compileOnly();
  p.age();
  const published = build(p.files, p.env);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')), 'A library without its source does not stop the build');
  assert.equal(p.launch(), 'FORMER\n');
  const manifest = fs.readFileSync(path.join(published, 'manifest.rktd'));
  p.write('LATTER');
  compileOnly();
  assert.equal(p.launch(), 'LATTER\n');
  assert.deepEqual(fs.readFileSync(path.join(published, 'manifest.rktd')), manifest);
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

test('the build waits until the worker has connected, or has failed to', { timeout: 300000, skip: process.platform === 'win32' }, async t => {
  const files = folder(t);
  const { directory, storage, program } = files;
  // A worker as slow to start as a slow machine's.
  const slowRacket = path.join(directory, 'slow-racket');
  fs.writeFileSync(slowRacket, '#!/bin/sh\nsleep 4\nexec racket "$@"\n', { mode: 0o755 });
  const client = new DapClient(undefined, { timeout: 120000,
    spawn: (command, _args, options) => spawn(command, launcherArgs(files), options) });
  t.after(() => client.close().catch(() => {}));
  await client.request('initialize', { adapterID: 'racketdap' });
  const launched = client.request('launch', { program, cwd: path.dirname(program), racketExecutable: slowRacket });
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.deepEqual(entries(storage), [], 'Nothing compiles while the worker is starting');
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
  const refused = await failing.request('launch', { program: again.program, cwd: again.directory, racketExecutable: 'false' });
  assert.equal(refused.success, false);
  await built(again.storage);
  await failing.close();
});

test('a building folder holds off a second build until it is abandoned', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { directory, racketdap, storage, program } = files;
  await session(launcherArgs(files), program);
  const [build] = await built(storage);
  fs.rmSync(path.join(storage, build), { recursive: true });
  const building = path.join(storage, `${build}.building`);
  fs.mkdirSync(building);
  fs.writeFileSync(path.join(building, 'in progress'), '');
  // A builder says that it started, so a second one is seen even before it finishes.
  const started = path.join(directory, 'builder started');
  const builder = path.join(racketdap, 'tools/compile-debugger.rkt');
  fs.writeFileSync(builder, fs.readFileSync(builder, 'utf8').replace('(module+ main\n',
    `(module+ main\n  (close-output-port (open-output-file ${JSON.stringify(started)} #:exists 'append))\n`));
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.ok(!fs.existsSync(started), 'No second build started');
  assert.deepEqual(entries(storage), [`${build}.building`]);
  assert.ok(fs.existsSync(path.join(building, 'in progress')));
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(building, old, old);
  assert.match((await session(launcherArgs(files), program)).output, /finished/);
  await built(storage);
  assert.ok(fs.existsSync(started));
  assert.deepEqual(finished(storage), [build]);
  assert.equal(entries(storage).length, 1, entries(storage).join());
});

// A tool's supervisor and worker, given a request, until the worker has finished.
function runTool(args, request) {
  return new Promise((resolve, reject) => {
    const child = spawn('racket', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test('tools run through the launcher as they do without it', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { racketdap, storage } = files;
  // A tool whose supervisor and worker are both debugger files.
  fs.writeFileSync(path.join(racketdap, 'tools/stamp-worker.rkt'), `#lang racket/base
(require (for-syntax racket/base) json racket/runtime-path "../tool-worker.rkt")
(define-runtime-path self "stamp-worker.rkt")
(define-syntax (compile-stamp stx) (datum->syntax #'here (current-inexact-milliseconds)))
(module+ main
  (run-tool-worker self
    (lambda (request)
      (write-json (hasheq 'stamp (compile-stamp) 'name (hash-ref request 'name)
                          'arguments (vector->list (current-command-line-arguments))))
      (flush-output))))
`);
  const owned = launcherArgs(files, 'tools/owned-command.rkt');
  // Everything an owned command starts ends with it, on Windows its builder too,
  // so this one stays until the build has finished, as a window's server does.
  const child = spawn('racket', [...owned, '-l', 'racket/base', '-e', '(void (read-byte)) (display "from the child") (exit 7)']);
  t.after(() => child.kill('SIGKILL'));
  let said = '', complaint = '';
  child.stdout.on('data', data => { said += data; });
  child.stderr.on('data', data => { complaint += data; });
  const ended = new Promise(resolve => child.on('close', resolve));
  const [build] = await built(storage);
  child.stdin.end();
  assert.equal(await ended, 7, complaint);
  assert.equal(said, 'from the child');
  const again = spawnSync('racket', [...owned, '-l', 'racket/base', '-e', '(exit 7)'], { encoding: 'utf8' });
  assert.equal(again.status, 7, again.stderr);
  const run = async () => {
    const { status, stdout, stderr } = await runTool(launcherArgs(files, 'tools/stamp-worker.rkt'), { name: 'a request' });
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout);
  };
  const [first, second] = [await run(), await run()];
  assert.deepEqual(first, second, 'The worker compiled once');
  assert.deepEqual(first.arguments, ['--worker']);
  assert.equal(first.name, 'a request');
  assert.deepEqual(entries(storage), [build]);
  assert.equal(compiledFiles(racketdap).length, 0);
});

test('a debugger file left out of the build loads from source, and its libraries as usual', { timeout: 300000 }, async t => {
  const files = folder(t);
  const { racketdap, storage, program, directory } = files;
  fs.writeFileSync(path.join(racketdap, 'tools/no-library.rkt'), '#lang racket/base\n(require no-such-library/here)\n');
  await session(launcherArgs(files), program);
  const [build] = await built(storage);
  assert.ok(!compiledFiles(path.join(storage, build)).some(name => name.endsWith('no-library_rkt.zo')));
  const missing = spawnSync('racket', launcherArgs(files, 'tools/no-library.rkt'), { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no-such-library/);
  // This one needs the bundled libraries its command line names, so the build cannot
  // compile it. Its libraries still come from their compiled files: reading them from
  // source too takes the tool from about a second to half a minute.
  assert.ok(!compiledFiles(path.join(storage, build)).some(name => name.endsWith('dependency-worker_rkt.zo')));
  const request = { version: 1, path: program, buffers: [], roots: [directory] };
  const collects = path.join(repository, 'vendor/collects');
  const worker = path.join(racketdap, 'tools/dependency-worker.rkt');
  const timed = async args => {
    const started = Date.now();
    const { status, stdout, stderr } = await runTool(['-S', collects, ...args], request);
    assert.equal(status, 0, stderr);
    return { result: JSON.parse(stdout), took: Date.now() - started };
  };
  const direct = await timed([worker]);
  const launched = await timed([path.join(racketdap, 'launcher.rkt'), storage, worker]);
  assert.deepEqual(launched.result, direct.result);
  assert.ok(launched.took < direct.took * 6 + 5000, `${launched.took} ms against ${direct.took} ms`);
});

test('the extension starts debugger files through the launcher when it has storage', () => {
  const context = { asAbsolutePath: file => `/extension/${file}` };
  assert.deepEqual(debuggerArgs(context, 'main.rkt'), ['/extension/runtime/racketdap/main.rkt']);
  assert.deepEqual(debuggerArgs({ ...context, globalStorageUri: { fsPath: '/storage' } }, 'tools/macro-stepper.rkt'),
    ['/extension/runtime/racketdap/launcher.rkt', path.join('/storage', 'debugger'), '/extension/runtime/racketdap/tools/macro-stepper.rkt']);
});

test('separate compiled roots track a compiled-only library replacement', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  const separate = path.join(p.files.directory, 'separate-compiled');
  p.env.PLTCOMPILEDROOTS = `${separate}${path.delimiter}`;
  let generation = 0;
  const compileOnly = () => {
    const made = spawnSync('raco', ['make', p.macro], { env: p.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(made.status, 0, made.stderr);
    fs.unlinkSync(p.macro);
    const past = new Date(Date.now() - (2 - generation++) * 3600000);
    for (const f of fs.readdirSync(separate, { recursive: true })) fs.utimesSync(path.join(separate, String(f)), past, past);
  };
  compileOnly();
  p.age();
  const published = build(p.files, p.env);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')), 'A published build is required');
  assert.equal(p.launch(), 'FORMER\n');
  p.write('LATTER'); compileOnly();
  const direct = spawnSync('racket', [p.target], { env: p.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, 'LATTER\n');
  assert.equal(p.launch(), 'LATTER\n');
});

test('switching compiled roots does not keep expansions from the former root', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  const rootA = path.join(p.files.directory, 'compiled-a');
  const rootB = path.join(p.files.directory, 'compiled-b');
  const make = (compiledRoot, answer) => {
    p.write(answer);
    p.env.PLTCOMPILEDROOTS = `${compiledRoot}${path.delimiter}`;
    const made = spawnSync('raco', ['make', p.macro], { env: p.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(made.status, 0, made.stderr);
    fs.unlinkSync(p.macro);
    const past = new Date(Date.now() - 3600000);
    for (const f of fs.readdirSync(compiledRoot, { recursive: true })) fs.utimesSync(path.join(compiledRoot, String(f)), past, past);
  };
  make(rootA, 'FORMER'); p.age();
  const published = build(p.files, p.env);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')));
  assert.equal(p.launch(), 'FORMER\n');
  make(rootB, 'LATTER');
  const direct = spawnSync('racket', [p.target], { env: p.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, 'LATTER\n');
  assert.equal(p.launch(), 'LATTER\n');
});

test('a library newly present in an earlier compiled root displaces the former expansion', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  const rootA = path.join(p.files.directory, 'compiled-a');
  const rootB = path.join(p.files.directory, 'compiled-b');
  const make = (compiledRoot, answer) => {
    p.write(answer);
    const env = { ...p.env, PLTCOMPILEDROOTS: `${compiledRoot}${path.delimiter}` };
    const made = spawnSync('raco', ['make', p.macro], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(made.status, 0, made.stderr);
    fs.unlinkSync(p.macro);
    const past = new Date(Date.now() - 3600000);
    for (const f of fs.readdirSync(compiledRoot, { recursive: true })) fs.utimesSync(path.join(compiledRoot, String(f)), past, past);
  };
  make(rootB, 'FORMER'); p.age();
  p.env.PLTCOMPILEDROOTS = [rootA, rootB, ''].join(path.delimiter);
  const published = build(p.files, p.env);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')));
  assert.equal(p.launch(), 'FORMER\n');
  make(rootA, 'LATTER');
  const direct = spawnSync('racket', [p.target], { env: p.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, 'LATTER\n');
  assert.equal(p.launch(), 'LATTER\n');
});

test('a development tree build ignores bytecode left beside debugger sources', { timeout: 300000 }, async t => {
  const p = folder(t);
  const target = path.join(p.racketdap, 'development-probe.rkt');
  fs.writeFileSync(target, '#lang racket/base\n(displayln (quote FORMER))\n');
  const made = spawnSync('raco', ['make', target], { encoding: 'utf8', timeout: 60000 });
  assert.equal(made.status, 0, made.stderr);
  const zo = path.join(p.racketdap, 'compiled', 'development-probe_rkt.zo');
  const former = fs.readFileSync(zo);
  fs.writeFileSync(target, '#lang racket/base\n(displayln (quote LATTER))\n');
  const past = new Date(Date.now() - 3600000); fs.utimesSync(target, past, past);
  const published = build(p);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')));
  const launched = spawnSync('racket', launcherArgs(p, 'development-probe.rkt'), { encoding: 'utf8', timeout: 30000 });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout, 'LATTER\n');
  assert.deepEqual(fs.readFileSync(zo), former, 'The old bytecode beside the sources is untouched');
  assert.deepEqual(compiledFiles(published).filter(name => !name.split(path.sep).includes('racketdap')), [],
    'Ordinary libraries are read from their installation roots');
});

test('a user-scope linked library is tracked without adding a collection root', { timeout: 300000 }, async t => {
  const p = libraryProject(t);
  p.env.PLTADDONDIR = path.join(p.files.directory, 'user-addon');
  delete p.env.PLTCOLLECTS;
  const linked = spawnSync('raco', ['link', '--user', '--name', 'launch-library', p.library],
    { env: p.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(linked.status, 0, linked.stderr);
  const published = build(p.files, p.env);
  assert.ok(fs.existsSync(path.join(published, 'manifest.rktd')));
  assert.equal(p.launch(), 'FORMER\n');
  p.write('LATTER');
  assert.equal(p.launch(), 'LATTER\n');
});
