// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const rpc = require(require.resolve('vscode-jsonrpc/node', { paths: [path.join(__dirname, '../vscode')] }));
const { addon, root, uri, project } = require('./workspace-index-project');

const windows = process.platform === 'win32';
const quoted = text => JSON.stringify(text);
const workers = count => ({ RACKETEER_INDEX_TRACE: '1', RACKETEER_INDEX_WORKERS: count === undefined ? undefined : String(count) });

const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Compile-time programs. A file's macro runs in whichever worker analyses it.
const compileTime = (body, requires = '') =>
  `#lang racket/base\n(require (for-syntax racket/base ${requires}))\n(begin-for-syntax\n${body})\n`;
const library = windows ? '(ffi-lib "msvcrt")' : '#f';
const endProcess = status => `((get-ffi-obj "_exit" ${library} (_fun _int -> _void)) ${status})`;
const writePid = file => `(call-with-output-file ${quoted(file)} #:exists 'truncate (lambda (out)
  (write ((get-ffi-obj ${windows ? '"_getpid"' : '"getpid"'} ${library} (_fun -> _int))) out)))`;
const blockForever = windows
  ? '((get-ffi-obj "Sleep" (ffi-lib "kernel32") (_fun _uint32 -> _void)) 70000)'
  : '((get-ffi-obj "sleep" #f (_fun _uint -> _uint)) 70)';
const pidFrom = (file, describe) => until(() => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return /^\d+$/.test(text) && Number(text);
}, 60, describe);

// Files of a project whose analysis waits at compile time for a gate to be opened,
// and which say when each reached it. Each refers to `square`, so it shows in answers.
function gates(p) {
  const prefix = path.join(addon, `${path.basename(p.directory)}-gate-`);
  const entered = name => `${prefix}${name}-entered`, gate = name => `${prefix}${name}-open`;
  const write = (name, after = '', comment = '') => p.write(name, `#lang racket/base
${comment}(require (for-syntax racket/base) "definition.rkt")
(begin-for-syntax
  (call-with-output-file ${quoted(entered(name))} #:exists 'truncate void)
  (let wait () (unless (file-exists? ${quoted(gate(name))}) (sleep 0.02) (wait)))
  ${after})
(square 3)
`);
  return {
    write,
    open: name => fs.writeFileSync(gate(name), ''),
    hasEntered: name => fs.existsSync(entered(name)),
    entered: name => until(() => fs.existsSync(entered(name)), () => `${name} did not start\n${p.diagnostics()}`)
  };
}

// What the trace says, in the order it happened.
const label = name => new RegExp(`analyse \\S*${name.replace('.', '\\.')}: finished`);
const finished = (p, name) => until(() => label(name).test(p.diagnostics()), () => `${name} did not end\n${p.diagnostics()}`);
const finishedAt = (p, name) => p.diagnostics().search(label(name));
const most = p => {
  let now = 0, peak = 0;
  for (const line of p.diagnostics().split('\n')) {
    if (/: starting$/.test(line)) peak = Math.max(peak, ++now);
    else if (/: finished/.test(line)) now--;
  }
  return peak;
};
const started = p => (p.diagnostics().match(/analyse \S+: starting/g) || []).length;

// Files counted so far by the progress a client sees: only its number of finished files moves.
const counted = p => p.progress.filter(value => value.message).map(value => value.message).filter(message => !message.startsWith('0/'));
const finishedFiles = p => { const last = counted(p).at(-1); return last ? Number(last.split('/')[0]) : 0; };

const attempt = request => request.then(value => ({ value }), error => ({ code: error.code, message: error.message }));
// What a client can learn from a server, once its pass has ended. Rename comes last,
// since it analyses every file again.
const answers = async p => {
  const references = await attempt(p.references(p.origin, undefined, false));
  const withDeclaration = await attempt(p.references(p.origin, undefined, true));
  const status = p.notifications.at(-1);
  const incomplete = p.diagnostics().match(/^Workspace analysis incomplete: .*$/gm);
  const progress = counted(p);
  const rename = await attempt(p.rename(p.origin, 'squared'));
  return JSON.stringify({ references, withDeclaration, status, incomplete, progress, rename }, null, 1);
};

const ampleMemory = 12000 * 1024 * 1024;
const scarceMemory = 2500 * 1024 * 1024;
const defaults = (available = ampleMemory) => {
  const result = spawnSync('racket', ['-l', 'racket/base', '-l', 'racket/future', '-e', `
    (dynamic-require (string->path ${quoted(path.join(root, 'vscode/racket-environment.rkt'))}) #f)
    (define default-workers (dynamic-require (string->path ${quoted(path.join(root, 'vscode/workspace-analysis.rkt'))}) 'default-workers))
    (define (workers processors) (default-workers processors ${available}))
    (write (cons (workers (processor-count)) (map workers '(1 2 3 4 6 8 16 64))))`],
  { env: { ...process.env, PLTADDONDIR: addon }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [here, ...table] = result.stdout.slice(1, -1).split(' ').map(Number);
  return { here, table };
};

test('a default is half the processors, within a cap', () => {
  assert.deepEqual(defaults().table, [1, 1, 1, 2, 3, 3, 3, 3]);
});

test('a default also follows available memory', () => {
  assert.deepEqual(defaults(scarceMemory).table, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(defaults(6000 * 1024 * 1024).table, [1, 1, 1, 2, 2, 2, 2, 2]);
});

// Every gated file is reached at once, and the one after them only when one ends.
for (const [count, describe, available = ampleMemory] of [
  [3, 'three workers'], [undefined, 'the default'], [undefined, 'the default with scarce memory', scarceMemory]
]) {
  test(`a pass runs as many workers at once as it may, and no more (${describe})`, async t => {
    const p = await project(t, { ...workers(count), RACKETEER_TEST_AVAILABLE_MEMORY_BYTES: String(available) });
    const g = gates(p), limit = count || defaults(available).here;
    const names = ['a.rkt', 'b.rkt', 'c.rkt', 'd.rkt', 'e.rkt', 'f.rkt'];
    for (const name of names) g.write(name);
    p.settings.timeoutSeconds = 90;
    await p.update();
    const asking = p.references(p.origin);
    for (const name of names.slice(0, limit)) await g.entered(name);
    await delay(4000);
    assert.deepEqual(names.filter(g.hasEntered), names.slice(0, limit), 'Each of the first files runs at once, and none after them');
    for (const name of names) g.open(name);
    assert.equal((await asking).length, names.length + 2, 'Each file, uses.rkt and the provide');
    assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
    assert.equal(most(p), limit);
  });
}

test('one worker keeps to one process at a time', async t => {
  const p = await project(t, workers(1));
  p.write('a.rkt', '#lang racket/base\n(require "definition.rkt")\n(square 1)\n');
  p.write('b.rkt', '#lang racket/base\n(require "definition.rkt")\n(square 2)\n');
  await p.update();
  await p.references(p.origin);
  assert.equal(most(p), 1);
});

test('workers ending in another order give what one worker gives, to the byte', async t => {
  const p = await project(t, workers(3));
  const g = gates(p);
  for (const name of ['a.rkt', 'b.rkt', 'c.rkt']) g.write(name);
  p.write('d-bad.rkt', '#lang racket/base\n(require "absent.rkt")\n');
  p.write('e.rkt', '#lang racket/base\n(require "definition.rkt")\n(square 5)\n');
  p.write('f-bad.rkt', '#lang racket/base\n(require "absent-too.rkt")\n');
  p.settings.timeoutSeconds = 90;
  await p.update();
  const asking = p.references(p.origin);
  for (const name of ['a.rkt', 'b.rkt', 'c.rkt']) await g.entered(name);
  // Each ends only when the one after it has gone, so nothing ends in the order of the files.
  g.open('c.rkt'); await finished(p, 'c.rkt');
  g.open('b.rkt'); await finished(p, 'b.rkt');
  for (const name of ['d-bad.rkt', 'e.rkt', 'f-bad.rkt', 'uses.rkt']) await finished(p, name);
  assert.ok(finishedFiles(p) <= 1, `Only the definition can be counted before a.rkt ends: ${counted(p)}`);
  g.open('a.rkt');
  assert.equal((await asking).length, 6);
  for (const [earlier, later] of [['c.rkt', 'b.rkt'], ['b.rkt', 'a.rkt'], ['f-bad.rkt', 'a.rkt'], ['uses.rkt', 'a.rkt']])
    assert.ok(finishedAt(p, earlier) < finishedAt(p, later), `${earlier} must end before ${later}`);
  assert.deepEqual(counted(p).map(message => Number(message.split('/')[0])), [1, 2, 3, 4, 4, 5, 5, 6]);
  assert.deepEqual({ ...p.notifications.at(-1) }, { state: 'partial', indexed: 6, total: 8, failures: 2 });
  const parallel = await answers(p);
  assert.match(p.diagnostics(), /incomplete: \S*d-bad\.rkt[\s\S]*incomplete: \S*f-bad\.rkt/);
  const serial = await project(t, workers(1), p);
  await serial.references(serial.origin);
  assert.equal(parallel, await answers(serial));
  // Whatever order they ended in, each result stands for the next pass.
  const before = started(p);
  p.write('e.rkt', '#lang racket/base\n(require "definition.rkt")\n(square 6)\n');
  await p.update();
  await p.references(p.origin);
  assert.equal(started(p) - before, 4, 'The edited file, the two that failed and the request');
});

test('the reason a rename gives is the first file\'s in the pass, whichever worker stopped first', async t => {
  const env = { RACKETEER_INDEX_WORKER_MEGABYTES: '64' };
  const p = await project(t, { ...workers(3), ...env });
  const g = gates(p);
  const keepAllocating = '(let keep ([kept (quote ())]) (keep (cons (make-vector 100000 0) kept)))';
  g.write('a-greedy.rkt', keepAllocating);
  p.write('b-ends.rkt', compileTime(endProcess(3), 'ffi/unsafe'));
  p.write('c.rkt', '#lang racket/base\n(require "definition.rkt")\n(square 5)\n');
  p.settings.timeoutSeconds = 90;
  await p.update();
  const asking = p.references(p.origin);
  await g.entered('a-greedy.rkt');
  await until(() => /b-ends\.rkt: analysis worker exited with status 3/.test(p.diagnostics()), p.diagnostics);
  assert.doesNotMatch(p.diagnostics(), /memory limit/);
  g.open('a-greedy.rkt');
  assert.equal((await asking).length, 3, 'The other workers carry on');
  assert.deepEqual({ ...p.notifications.at(-1) }, { state: 'partial', indexed: 3, total: 5, failures: 2 });
  const parallel = await answers(p);
  assert.match(parallel, /Workspace analysis is incomplete, so Rename cannot run: analysis of \S*a-greedy\.rkt went over the 64 MB memory limit for one worker\./);
  assert.match(parallel, /a-greedy\.rkt[^\n]*went over[\s\S]*b-ends\.rkt[^\n]*exited with status 3/);
  const serial = await project(t, { ...workers(1), ...env }, p);
  await serial.references(serial.origin);
  assert.equal(parallel, await answers(serial));
});

// A comment of this size is quick to analyse, and two of them pass the limit of 16 MiB of source.
const largeComment = `;${'x'.repeat(8.5 * 1024 * 1024)}\n`;

test('a pass stopped at a limit gives what one worker gives and keeps nothing found beyond it', async t => {
  const p = await project(t, workers(3));
  const g = gates(p);
  p.settings.timeoutSeconds = 90;
  p.settings.maxFileBytes = 10 * 1024 * 1024;
  const log = path.join(addon, `${path.basename(p.directory)}-beyond.log`);
  const beyond = `#lang racket/base
(require (for-syntax racket/base) "definition.rkt")
(begin-for-syntax
  (call-with-output-file ${quoted(log)} #:exists 'append (lambda (out) (display "expanded\\n" out))))
(square 7)
`;
  const expansions = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  p.write('big-1.rkt', `#lang racket/base\n${largeComment}`);
  // The second passes the limit, which is decided when the pass reaches it.
  g.write('big-2.rkt', '', largeComment);
  const pidFile = path.join(addon, `${path.basename(p.directory)}-held.pid`);
  p.write('held.rkt', compileTime(`${writePid(pidFile)}\n(sync never-evt)`, 'ffi/unsafe'));
  p.write('later.rkt', beyond);
  await p.update();
  const asking = p.references(p.origin);
  await g.entered('big-2.rkt');
  await finished(p, 'later.rkt');
  await finished(p, 'uses.rkt');
  const pid = await pidFrom(pidFile, p.diagnostics);
  assert.ok(running(pid));
  assert.equal(expansions(), 1, 'The worker ran ahead of the pass');
  g.open('big-2.rkt');
  await asking;
  await until(() => !running(pid), () => `Worker ${pid} is still running after the pass stopped`);
  assert.deepEqual({ ...p.notifications.at(-1) }, { state: 'partial', indexed: 2, total: 6, failures: 1 });
  const parallel = await answers(p);
  const serial = await project(t, workers(1), p);
  await serial.references(serial.origin);
  assert.equal(parallel, await answers(serial));
  assert.equal(expansions(), 1, 'One worker never reaches that file');
  // The next pass finds what one worker would have left, so it analyses that file.
  p.write('big-2.rkt', '#lang racket/base\n');
  p.write('held.rkt', '#lang racket/base\n');
  await p.update();
  const after = await p.references(p.origin);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
  assert.ok(after.some(location => location.uri === uri(p.filename('later.rkt'))));
  assert.equal(expansions(), 2, 'What ran ahead of the pass is not kept');
});

// As many workers as may run, each in a blocking C call, having said who it is.
async function blocked(t, count, body = blockForever) {
  const p = await project(t, workers(count));
  const files = Array.from({ length: count }, (_, i) => `blocked-${i}.rkt`);
  const pidFile = name => path.join(addon, `${path.basename(p.directory)}-${name}.pid`);
  for (const name of files) p.write(name, compileTime(`${writePid(pidFile(name))}\n${body}`, 'ffi/unsafe'));
  p.write('waiting.rkt', '#lang racket/base\n(require "definition.rkt")\n(square 9)\n');
  p.settings.timeoutSeconds = 90;
  await p.update();
  const pids = () => Promise.all(files.map(name => pidFrom(pidFile(name), () => `No process id for ${name}\n${p.diagnostics()}`)));
  return { p, files, pids };
}
const allStop = (p, pids, describe) => until(() => !pids.some(running), 20,
  () => `Of ${pids}, these are still running ${describe}: ${pids.filter(running)}\n${p.diagnostics()}`);

test('cancelling the only request stops every worker of its pass at once', async t => {
  const { p, files, pids } = await blocked(t, 3);
  const cancel = new rpc.CancellationTokenSource();
  const asking = p.references(p.origin, undefined, false, cancel.token);
  const all = await pids();
  assert.equal(new Set(all).size, 3, 'Each runs in a process of its own');
  assert.ok(!all.includes(p.child.pid));
  const before = started(p);
  cancel.cancel();
  await assert.rejects(asking, error => error.code === -32800);
  cancel.dispose();
  await allStop(p, all, 'after the request was cancelled');
  await until(() => p.notifications.at(-1).state === 'outdated', p.diagnostics);
  await delay(2000);
  assert.equal(started(p), before, 'Nobody is asking, so no more files are analysed');
  for (const name of files) p.write(name, '#lang racket/base\n');
  await p.update();
  assert.equal((await p.references(p.origin)).length, 3);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
});

test('a change replacing a pass stops every worker of it', async t => {
  const { p, files, pids } = await blocked(t, 3);
  const asking = p.references(p.origin);
  const all = await pids();
  for (const name of files) p.write(name, '#lang racket/base\n');
  await p.update();
  await allStop(p, all, 'after a change replaced their pass');
  assert.equal((await asking).length, 3);
  assert.equal(p.notifications.at(-1).state, 'ready', p.diagnostics());
});

test('shutdown stops every worker', async t => {
  const { p, pids } = await blocked(t, 3);
  const asking = attempt(p.references(p.origin));
  const all = await pids();
  await p.request('shutdown');
  await allStop(p, all, 'after shutdown');
  assert.equal((await asking).code, -32803);
});

test('every worker ends when the server is killed', async t => {
  const { p, pids } = await blocked(t, 3, '(sync never-evt)');
  void attempt(p.references(p.origin));
  const all = await pids();
  p.child.kill('SIGKILL');
  await allStop(p, all, 'after their server was killed');
});
