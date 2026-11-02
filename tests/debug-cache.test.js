// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('./support/node-test.js');
const { session, normalized, normalizedByFile } = require('./support/dap-trace.js');

const files = {
  'deep.rkt': `#lang racket/base
(provide deep-value)
(define-syntax-rule (deep-value) 'deep-one)
`,
  'macros.rkt': `#lang racket/base
(require "deep.rkt" racket/include (for-syntax racket/base "compile-only.rkt"))
(provide (struct-out point) twice from-macro from-include helper)
(struct point (x y) #:transparent)
(define-syntax-rule (twice e) (let ([v e]) (list v v)))
(define-syntax-rule (from-macro) (deep-value))
(define-syntax-rule (from-include) (include "included.txt"))
(define (helper n)
  (define doubled (* n 2))
  (add1 doubled))
`,
  'included.txt': `"included-one"
`,
  'compile-only.rkt': `#lang racket/base
(provide compile-time-value)
(define (compile-time-value) 'from-compile-time)
`,
  'test-only.rkt': `#lang racket/base
(provide test-value)
(define (test-value)
  'only-in-a-test)
`,
  'main.rkt': `#lang racket/base
(require "macros.rkt" racket/list)
(define total 0)
(define (accumulate! n)
  (set! total (+ total n))
  total)
(define (work a)
  (define b (helper a))
  (define p (point a b))
  (define all (twice (accumulate! b)))
  (list p all (first all) (from-macro) (from-include)))
(define result (work 3))
(displayln result)
(define (fail n)
  (let ([message (format "failed at ~a" n)])
    (raise-user-error message)))
(module+ main
  (displayln (list 'main total))
  (fail total))
(module+ test
  (require "test-only.rkt")
  (test-value))
`
};
const racket = (expression, cwd) => require('node:child_process').execFileSync('racket', ['-e', expression], { cwd, encoding: 'utf8' });
const lineIn = (file, text) => fs.readFileSync(file, 'utf8').split('\n').findIndex(l => l.includes(text)) + 1;
function project(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'project');
  fs.mkdirSync(source);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(source, name), text);
  return { source, cwd: source, cache: path.join(directory, 'cache'), main: path.join(source, 'main.rkt') };
}
// Module names keep the spelling of the program's path, and the worker's directory is
// the system's own, which is the real path. The two differ whenever a session's folder
// is not the program's, or is reached through a link: macOS's temporary folder always is.
const arrangements = [
  ['with the working directory elsewhere', p => {
    const cwd = path.join(path.dirname(p.source), 'elsewhere');
    fs.mkdirSync(cwd);
    return { ...p, cwd };
  }],
  ['through a link to its folder', p => {
    const source = path.join(path.dirname(p.source), 'link');
    fs.symlinkSync(p.source, source, 'junction');
    return { ...p, source, cwd: source, main: path.join(source, 'main.rkt') };
  }]
];
// The scenario every comparison runs: breakpoints, stepping, variables, assignment,
// evaluation with a macro, an exception stop, its location and captured source.
async function scenario({ client, ok }) {
  const stop = async () => {
    const stopped = await client.event('stopped');
    const threadId = stopped.body.threadId;
    const { stackFrames } = await ok(client.request('stackTrace', { threadId }));
    const { scopes } = await ok(client.request('scopes', { frameId: stackFrames[0].id }));
    for (const scope of scopes) await ok(client.request('variables', { variablesReference: scope.variablesReference }));
    return { threadId, frameId: stackFrames[0].id, scopes };
  };
  let at = await stop();
  await ok(client.request('evaluate', { expression: '(list a total (from-macro))', frameId: at.frameId, context: 'watch' }));
  const locals = at.scopes[0].variablesReference;
  await ok(client.request('setVariable', { variablesReference: locals, name: 'a', value: '4' }));
  await ok(client.request('stepIn', { threadId: at.threadId }));
  at = await stop();
  await ok(client.request('next', { threadId: at.threadId }));
  at = await stop();
  await ok(client.request('stepOut', { threadId: at.threadId }));
  at = await stop();
  await ok(client.request('continue', { threadId: at.threadId }));
  at = await stop();
  // Refused from a submodule, and the refusal is part of the comparison.
  await client.request('evaluate', { expression: '(set! total 100)', frameId: at.frameId, context: 'repl' });
  await client.request('evaluate', { expression: '(helper total)', frameId: at.frameId, context: 'repl' });
  await ok(client.request('continue', { threadId: at.threadId }));
  at = await stop();
  await ok(client.request('exceptionInfo', { threadId: at.threadId }));
  const { sources } = await ok(client.request('loadedSources', {}));
  sources.sort((a, b) => a.path.localeCompare(b.path));
  for (const source of sources) await ok(client.request('source', { source, sourceReference: source.sourceReference }));
  await ok(client.request('continue', { threadId: at.threadId }));
}
function breakpointsOf(p) {
  const named = (name, ...texts) => {
    const file = path.join(p.source, name);
    return { [file]: texts.map(text => lineIn(file, text)) };
  };
  return {
    ...named('main.rkt', '(define b (helper a))', "(displayln (list 'main total))"),
    ...named('macros.rkt', '(add1 doubled)'),
    ...named('test-only.rkt', "'only-in-a-test"),
    ...named('compile-only.rkt', "'from-compile-time")
  };
}
const edit = (p, name, from, to, { keepDate = false } = {}) => {
  const file = path.join(p.source, name);
  const before = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${name} holds ${from}`);
  fs.writeFileSync(file, text.replace(from, to));
  if (keepDate) fs.utimesSync(file, before.atime, before.mtime);
};
const walk = directory => !fs.existsSync(directory) ? [] : fs.readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const entries = (p, extension) => walk(p.cache).filter(file => file.endsWith(extension));
const entry = (p, name, extension = '.zo') => {
  const found = entries(p, extension).filter(file => path.basename(file) === name.replace('.rkt', '_rkt') + extension);
  assert.strictEqual(found.length, 1, `one entry for ${name}`);
  return found[0];
};
// With no folder named a session still caches, in Racket's addon directory. What a
// cached run is compared with must have the cache off.
const uncachedOptions = options => ({ ...options, debugCache: false });
const run = (p, cached) => session(
  cached ? { program: p.main, cwd: p.cwd, debugCacheDirectory: p.cache } : uncachedOptions({ program: p.main, cwd: p.cwd }),
  breakpointsOf(p), scenario);
function assertSameTrace(actual, expected, label, view = normalized) {
  const a = view(actual.messages);
  const e = view(expected.messages);
  for (let i = 0; i < Math.max(a.length, e.length); i++) assert.strictEqual(a[i], e[i], `${label}: message ${i}`);
}

test('a cached run sends the same messages as an uncached one, on the build and on the reuse', { timeout: 300000 }, async t => {
  const p = project(t);
  const uncached = await run(p, false);
  const stopped = uncached.messages.filter(m => m.event === 'stopped').length;
  assert.ok(stopped >= 6, `the scenario stopped ${stopped} times`);
  const built = await run(p, true);
  assertSameTrace(built, uncached, 'build');
  assert.strictEqual(entries(p, '.zo').filter(file => file.includes(`${path.sep}debug${path.sep}`)).length, 5);
  // Writing an entry gives it a new date and inode; reusing one does neither.
  const written = () => entries(p, '.zo').map(file => {
    const { ino, mtimeMs } = fs.statSync(file);
    return `${file} ${ino} ${mtimeMs}`;
  }).sort();
  const afterBuild = written();
  const reused = await run(p, true);
  assertSameTrace(reused, uncached, 'reuse');
  const again = await run(p, true);
  assertSameTrace(again, uncached, 'second reuse');
  assert.deepStrictEqual(written(), afterBuild, 'reuse wrote no entry');
  assert.deepStrictEqual(fs.readdirSync(p.source).sort(), Object.keys(files).sort());
});

for (const [where, arrange] of arrangements) {
  test(`a project ${where} sends the same messages cached as uncached`, { timeout: 300000 }, async t => {
    const p = arrange(project(t));
    const uncached = await run(p, false);
    assert.ok(!JSON.stringify(uncached.messages).includes('mismatch'));
    assertSameTrace(await run(p, true), uncached, 'build');
    assertSameTrace(await run(p, true), uncached, 'reuse');
  });
  // Nothing of the parent runs, so nothing of the parent can register its own definitions.
  test(`a submodule of a parent with nothing to run evaluates its macros and imports ${where}`, { timeout: 300000 }, async t => {
    const p = arrange(project(t));
    fs.writeFileSync(path.join(p.source, 'only-syntax.rkt'), `#lang racket/base
(require "macros.rkt")
(define-syntax-rule (mine) 'my-macro)
(module+ main
  (displayln "in main"))
`);
    const program = path.join(p.source, 'only-syntax.rkt');
    const evaluated = async ({ client, ok }) => {
      const stopped = await client.event('stopped');
      const threadId = stopped.body.threadId;
      const { stackFrames } = await ok(client.request('stackTrace', { threadId }));
      const results = [];
      for (const expression of ['(mine)', '(helper 1)']) {
        results.push((await ok(client.request('evaluate', { expression, frameId: stackFrames[0].id, context: 'repl' }))).result);
      }
      assert.deepStrictEqual(results, ['my-macro', '3']);
      await ok(client.request('continue', { threadId }));
    };
    const options = { program, cwd: p.cwd };
    const cached = { ...options, debugCacheDirectory: p.cache };
    const uncached = await session(uncachedOptions(options), { [program]: [5] }, evaluated);
    assertSameTrace(await session(cached, { [program]: [5] }, evaluated), uncached, 'build');
    assertSameTrace(await session(cached, { [program]: [5] }, evaluated), uncached, 'reuse');
  });
}

// One edit, then the cached session must equal an uncached session of the edited
// sources, and the macro's new expansion must be what the program computed.
async function checkEdit(t, change, shows) {
  const p = project(t);
  await run(p, true);
  await run(p, true);
  change(p);
  const uncached = await run(p, false);
  const output = JSON.parse(normalized(uncached.messages)[0]).stdout;
  assert.ok(output.includes(shows), `the edited program printed ${output}`);
  assertSameTrace(await run(p, true), uncached, 'after the edit', normalizedByFile);
  assertSameTrace(await run(p, true), uncached, 'reuse after the edit');
}
test('editing a macro in another file rebuilds its users', { timeout: 300000 }, t => checkEdit(t,
  p => edit(p, 'macros.rkt', '(define-syntax-rule (from-macro) (deep-value))',
    "(define-syntax-rule (from-macro) (list 'changed (deep-value)))"), '(changed deep-one)'));
test("editing a dependency's dependency rebuilds its users", { timeout: 300000 }, t => checkEdit(t,
  p => edit(p, 'deep.rkt', "'deep-one", "'deep-two"), 'deep-two'));
test('an edit that keeps the file date is still seen', { timeout: 300000 }, t => checkEdit(t,
  p => edit(p, 'deep.rkt', "'deep-one", "'deep-tri", { keepDate: true }), 'deep-tri'));
test('editing a file a macro includes rebuilds, whatever its date', { timeout: 300000 }, t => checkEdit(t,
  p => edit(p, 'included.txt', 'included-one', 'included-two', { keepDate: true }), 'included-two'));
test('an edit that moves lines keeps breakpoints and stops where the source says', { timeout: 300000 }, t => checkEdit(t,
  p => edit(p, 'main.rkt', '(define total 0)', ';; a new first line\n\n(define total 0)'), 'main'));

test('entries from another Racket version are rebuilt, not read', { timeout: 300000 }, async t => {
  const p = project(t);
  const uncached = await run(p, false);
  await run(p, true);
  const dep = entry(p, 'main.rkt', '.dep');
  fs.writeFileSync(dep, fs.readFileSync(dep, 'latin1').replace(/^\("[^"]*"/, '("8.0"'), 'latin1');
  assertSameTrace(await run(p, true), uncached, 'after the version changed', normalizedByFile);
  assert.ok(!fs.readFileSync(dep, 'latin1').startsWith('("8.0"'));
});

test('two sessions at once on an empty cache both run correctly and leave it usable', { timeout: 300000 }, async t => {
  const p = project(t);
  const uncached = await run(p, false);
  const [first, second] = await Promise.all([run(p, true), run(p, true)]);
  assertSameTrace(first, uncached, 'first session', normalizedByFile);
  assertSameTrace(second, uncached, 'second session', normalizedByFile);
  assertSameTrace(await run(p, true), uncached, 'after both', normalizedByFile);
  assertSameTrace(await run(p, true), uncached, 'settled');
});

for (const [name, damage] of [
  ['a flipped byte', file => { const b = fs.readFileSync(file); b[b.length >> 1] ^= 0xff; fs.writeFileSync(file, b); }],
  ['a truncated file', file => { const b = fs.readFileSync(file); fs.writeFileSync(file, b.subarray(0, b.length >> 1)); }],
  ['an empty file', file => fs.writeFileSync(file, '')],
  ['a file that cannot be read', file => fs.chmodSync(file, 0)]
]) {
  test(`${name} in the cache runs the program from source, then rebuilds`, { timeout: 300000 }, async t => {
    const p = project(t);
    const uncached = await run(p, false);
    await run(p, true);
    const stored = entry(p, 'macros.rkt');
    damage(stored);
    assertSameTrace(await run(p, true), uncached, 'with the damaged entry', normalizedByFile);
    if (fs.existsSync(stored)) fs.chmodSync(stored, 0o644);
    assertSameTrace(await run(p, true), uncached, 'rebuilding', normalizedByFile);
    assertSameTrace(await run(p, true), uncached, 'after rebuilding');
    assert.ok(fs.existsSync(entry(p, 'macros.rkt')));
  });
}
test('an entry reads as damaged wherever a byte of its code changes', { timeout: 300000 }, async t => {
  const p = project(t);
  await run(p, true);
  const stored = entry(p, 'macros.rkt');
  const macros = path.join(p.source, 'macros.rkt');
  const root = path.join(p.cache, fs.readdirSync(p.cache)[0]);
  const intact = () => racket(`(require (file ${JSON.stringify(debugCacheModule)}))
    (display (with-handlers ([exn:fail? (lambda (_) #f)])
      (and (read-entry-bytes ${JSON.stringify(root)} (string->path "compiled/debug") (string->path ${JSON.stringify(macros)})) #t)))`);
  assert.strictEqual(intact(), '#t');
  const original = fs.readFileSync(stored);
  // Past the directory of submodule names at its start, whose entries carry no hash.
  for (const position of [0.1, 0.3, 0.5, 0.7, 0.9, 0.999]) {
    const changed = Buffer.from(original);
    changed[Math.floor(changed.length * position)] ^= 1;
    fs.writeFileSync(stored, changed);
    assert.strictEqual(intact(), '#f', `at ${position}`);
  }
});
test('a damaged dependency record rebuilds', { timeout: 300000 }, async t => {
  const p = project(t);
  const uncached = await run(p, false);
  await run(p, true);
  fs.writeFileSync(entry(p, 'macros.rkt', '.dep'), 'not ( a record');
  assertSameTrace(await run(p, true), uncached, 'with the damaged record', normalizedByFile);
});
test('a file saved while it compiles is not taken for what was compiled', { timeout: 300000 }, async t => {
  const p = project(t);
  const deep = path.join(p.source, 'deep.rkt');
  const saved = files['deep.rkt'].replace("'deep-one", "'deep-saved-later");
  // Expansion of the file saves a new version over it, as an editor can.
  fs.writeFileSync(deep, files['deep.rkt'] + `
(require (for-syntax racket/base racket/file))
(begin-for-syntax (display-to-file ${JSON.stringify(saved)} ${JSON.stringify(deep)} #:exists 'truncate))
`);
  await run(p, true);
  assert.strictEqual(fs.readFileSync(deep, 'utf8'), saved);
  const uncached = await run(p, false);
  assert.ok(JSON.parse(normalized(uncached.messages)[0]).stdout.includes('deep-saved-later'));
  assertSameTrace(await run(p, true), uncached, 'after the save', normalizedByFile);
  assertSameTrace(await run(p, true), uncached, 'settled');
});

test('coverage code has its own entries, apart from debugging code', { timeout: 300000 }, async t => {
  const p = project(t);
  await run(p, true);
  const script = `(require (file ${JSON.stringify(path.resolve(__dirname, '../racketdap/worker/load.rkt'))})
                           (file ${JSON.stringify(path.resolve(__dirname, '../racketdap/instrumentation/runtime.rkt'))}))
    (define visits 0)
    (run-module ${JSON.stringify(path.join(p.source, 'macros.rkt'))}
      #:coverage? #t #:on-event (lambda (descriptor) (set! visits (add1 visits)))
      #:source-roots (list ${JSON.stringify(p.source)})
      #:cache-directory ${JSON.stringify(p.cache)})
    (display visits)`;
  const built = racket(script);
  assert.ok(Number(built) > 0, `built coverage counted ${built}`);
  assert.strictEqual(racket(script), built);
  assert.ok(entries(p, '.zo').some(file => file.includes(`${path.sep}coverage${path.sep}`)));
  assert.ok(entries(p, '.zo').some(file => file.includes(`${path.sep}debug${path.sep}`)));
});

test('a cache location that cannot be used runs the program from source', async t => {
  const p = project(t);
  const uncached = await run(p, false);
  fs.writeFileSync(p.cache, 'a file, not a folder');
  assertSameTrace(await run(p, true), uncached, 'with no usable cache');
});

test('a syntax error reads the same with and without the cache, on every run', { timeout: 300000 }, async t => {
  const p = project(t);
  edit(p, 'macros.rkt', '(define doubled (* n 2))', '(define doubled (* n 2) extra)');
  const uncached = await session(uncachedOptions({ program: p.main, cwd: p.source }), {});
  const cachedOptions = { program: p.main, cwd: p.source, debugCacheDirectory: p.cache };
  // The loader's own frames in the context lines differ, as they do between loaders.
  const withoutContext = messages => normalizedByFile(messages).map(line =>
    line.replace(/context\.\.\.:.*?(\\n"|")/, 'context'));
  assertSameTrace(await session(cachedOptions, {}), uncached, 'first', withoutContext);
  assertSameTrace(await session(cachedOptions, {}), uncached, 'second', withoutContext);
  edit(p, 'macros.rkt', '(define doubled (* n 2) extra)', '(define doubled (* n 2))');
  const fixed = await run(p, false);
  assertSameTrace(await run(p, true), fixed, 'after the fix', normalizedByFile);
});

test('code a compiled file cannot hold still runs, from source', { timeout: 300000 }, async t => {
  const p = project(t);
  fs.writeFileSync(path.join(p.source, 'macros.rkt'), files['macros.rkt'].replace('(provide', `(provide embedded
)(define-syntax (embedded stx) (datum->syntax #'here (list 'quote (lambda () 'a-closure))))
(provide`).replace('racket/include', 'racket/include'));
  edit(p, 'main.rkt', '(define total 0)', '(define total 0)\n(displayln (procedure? (embedded)))');
  const uncached = await session(uncachedOptions({ program: p.main, cwd: p.source }), {});
  assert.ok(JSON.parse(normalized(uncached.messages)[0]).stdout.includes('#t'));
  const cachedOptions = { program: p.main, cwd: p.source, debugCacheDirectory: p.cache };
  assertSameTrace(await session(cachedOptions, {}), uncached, 'first');
  assertSameTrace(await session(cachedOptions, {}), uncached, 'second');
});

test('test runs and coverage use the source, not the cache', { timeout: 300000 }, async t => {
  const p = project(t);
  const cachedOptions = { program: p.main, cwd: p.source, debugCacheDirectory: p.cache };
  await session({ ...cachedOptions, testMode: true, noDebug: true, coverage: true }, {});
  await session({ ...cachedOptions, testMode: true }, {});
  assert.deepStrictEqual(entries(p, '.zo'), []);
});

test('running without debugging uses no cache', async t => {
  const p = project(t);
  await session({ program: p.main, cwd: p.source, noDebug: true, debugCacheDirectory: p.cache }, {});
  assert.deepStrictEqual(entries(p, '.zo'), []);
});

test('with the cache off nothing is written, beside the sources or anywhere else', async t => {
  const p = project(t);
  await run(p, false);
  assert.deepStrictEqual(walk(path.dirname(p.source)).map(file => path.basename(file)).sort(), Object.keys(files).sort());
});

test('stopping on entry stops at the same place', { timeout: 300000 }, async t => {
  const p = project(t);
  const stops = async ({ client, ok }) => {
    for (;;) {
      const stopped = await client.event('stopped');
      await ok(client.request('continue', { threadId: stopped.body.threadId }));
      if (stopped.body.reason === 'exception') return;
    }
  };
  const options = { program: p.main, cwd: p.source, stopOnEntry: true };
  const uncached = await session(uncachedOptions(options), {}, stops);
  const cached = { ...options, debugCacheDirectory: p.cache };
  assertSameTrace(await session(cached, {}, stops), uncached, 'build');
  assertSameTrace(await session(cached, {}, stops), uncached, 'reuse');
});

test('an explicit submodule runs from the cache as it does from source', { timeout: 300000 }, async t => {
  const p = project(t);
  const options = { program: p.main, cwd: p.source, submodule: ['test'] };
  const uncached = await session(uncachedOptions(options), {});
  const cached = { ...options, debugCacheDirectory: p.cache };
  assertSameTrace(await session(cached, {}), uncached, 'build');
  assertSameTrace(await session(cached, {}), uncached, 'reuse');
});

const debugCacheModule = path.resolve(__dirname, '../racketdap/worker/debug-cache.rkt');

test('the key changes with the instrumenter, its location and the library paths', { timeout: 300000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug cache key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = (module, setup = '') => racket(`(require (file ${JSON.stringify(module)})) ${setup}
    (let-values ([(base name dir?) (split-path (cache-root "/x"))]) (display name))`);
  const copyRoot = path.join(directory, 'copy');
  fs.cpSync(path.resolve(__dirname, '../racketdap'), path.join(copyRoot, 'racketdap'),
    { recursive: true, filter: source => path.basename(source) !== 'compiled' });
  const copied = path.join(copyRoot, 'racketdap/worker/debug-cache.rkt');
  const here = key(debugCacheModule);
  assert.strictEqual(key(debugCacheModule), here);
  const elsewhere = key(copied);
  assert.notStrictEqual(elsewhere, here);
  const paths = key(debugCacheModule, `(current-library-collection-paths (cons "/elsewhere" (current-library-collection-paths)))`);
  assert.notStrictEqual(paths, here);
  fs.appendFileSync(path.join(copyRoot, 'racketdap/instrumentation/runtime.rkt'), ';; changed\n');
  assert.notStrictEqual(key(copied), elsewhere);
});

test('over its limit the cache drops the least recently used entries first', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug cache evict-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const put = (name, age) => {
    fs.writeFileSync(path.join(directory, `${name}.zo`), Buffer.alloc(1000));
    fs.writeFileSync(path.join(directory, `${name}.dep`), Buffer.alloc(100));
    const date = new Date(Date.now() - age * 1000);
    fs.utimesSync(path.join(directory, `${name}.dep`), date, date);
  };
  put('oldest', 300); put('middle', 200); put('newest', 100);
  fs.writeFileSync(path.join(directory, 'interrupted.zo123'), 'x');
  fs.utimesSync(path.join(directory, 'interrupted.zo123'), new Date(0), new Date(0));
  racket(`(require (file ${JSON.stringify(debugCacheModule)})) (evict-cache! ${JSON.stringify(directory)} 2500)`);
  assert.deepStrictEqual(fs.readdirSync(directory).sort(), ['middle.dep', 'middle.zo', 'newest.dep', 'newest.zo']);
});

test('choosing to debug a library rebuilds the code compiled against it', { timeout: 300000 }, async t => {
  const p = project(t);
  const library = path.join(path.dirname(p.source), 'library');
  fs.mkdirSync(library);
  const small = path.join(library, 'small.rkt');
  fs.writeFileSync(small, '#lang racket/base\n(provide small)\n(define (small n)\n  (+ n 1))\n');
  const main = path.join(p.source, 'uses-library.rkt');
  fs.writeFileSync(main, `#lang racket/base\n(require (file ${JSON.stringify(small)}))\n(displayln (small 1))\n`);
  const options = { program: main, cwd: p.source, sourceRoots: [p.source] };
  const cached = { ...options, debugCacheDirectory: p.cache };
  // Unselected: no breakpoint and outside the source roots.
  const plain = await session(uncachedOptions(options), {});
  assertSameTrace(await session(cached, {}), plain, 'library not selected');
  assertSameTrace(await session(cached, {}), plain, 'library not selected, reused');
  assert.ok(entries(p, '.zo').some(file => file.includes(`${path.sep}plain${path.sep}small_rkt.zo`)));
  // A breakpoint selects it, and a stop proves the caller reaches instrumented code.
  const stops = async ({ client, ok }) => {
    const stopped = await client.event('stopped');
    await ok(client.request('continue', { threadId: stopped.body.threadId }));
  };
  const selected = await session(uncachedOptions(options), { [small]: [4] }, stops);
  assertSameTrace(await session(cached, { [small]: [4] }, stops), selected, 'library selected');
  assertSameTrace(await session(cached, { [small]: [4] }, stops), selected, 'library selected, reused');
  assertSameTrace(await session(cached, {}), plain, 'library not selected again');
});

for (const [name, language, setup] of [
  ['a language defined in the project', 'module main "my-language.rkt"',
    p => fs.writeFileSync(path.join(p.source, 'my-language.rkt'),
      '#lang racket/base\n(provide (all-from-out racket/base) marker)\n(define (marker) (quote marker-one))\n')],
  ['typed/racket/base', 'module main typed/racket/base', () => {}],
  ['racket/kernel-like s-exp', 'module main (quote #%kernel)', () => {}]
]) {
  test(`a module in ${name} caches and stops where it does uncached`, { timeout: 300000 }, async t => {
    const p = project(t);
    setup(p);
    const uses = name.startsWith('a language') ? '(marker)' : "'no-marker";
    const main = path.join(p.source, 'in-language.rkt');
    const body = language.includes('#%kernel')
      ? `(define-values (f) (lambda (x)\n  (#%app list x)))\n(display (f ${uses}))\n`
      : `(define (f x)\n  (list x))\n(displayln (f ${uses}))\n`;
    fs.writeFileSync(main, `(${language}\n${body})\n`);
    const stops = async ({ client, ok }) => {
      const stopped = await client.event('stopped');
      const threadId = stopped.body.threadId;
      const { stackFrames } = await ok(client.request('stackTrace', { threadId }));
      await ok(client.request('scopes', { frameId: stackFrames[0].id }));
      await ok(client.request('evaluate', { expression: '(+ 1 2)', frameId: stackFrames[0].id, context: 'repl' }));
      await ok(client.request('continue', { threadId }));
    };
    const options = { program: main, cwd: p.source };
    const uncached = await session(uncachedOptions(options), { [main]: [3] }, stops);
    const cached = { ...options, debugCacheDirectory: p.cache };
    assertSameTrace(await session(cached, { [main]: [3] }, stops), uncached, 'build');
    assertSameTrace(await session(cached, { [main]: [3] }, stops), uncached, 'reuse');
    if (name.startsWith('a language')) {
      edit(p, 'my-language.rkt', 'marker-one', 'marker-two');
      const edited = await session(uncachedOptions(options), { [main]: [3] }, stops);
      assert.ok(JSON.parse(normalized(edited.messages)[0]).stdout.includes('marker-two'));
      assertSameTrace(await session(cached, { [main]: [3] }, stops), edited, 'language edited');
    }
  });
}

for (const [where, arrange] of arrangements) {
  test(`a module in a language defined in the project runs from the cache ${where}`, { timeout: 300000 }, async t => {
    const p = arrange(project(t));
    fs.writeFileSync(path.join(p.source, 'my-language.rkt'),
      '#lang racket/base\n(provide (all-from-out racket/base) marker)\n(define (marker) (quote marker-one))\n');
    const main = path.join(p.source, 'in-language.rkt');
    fs.writeFileSync(main, '(module main "my-language.rkt"\n(define (f x)\n  (list x))\n(displayln (f (marker)))\n)\n');
    const stops = async ({ client, ok }) => {
      const stopped = await client.event('stopped');
      const threadId = stopped.body.threadId;
      const { stackFrames } = await ok(client.request('stackTrace', { threadId }));
      const { result } = await ok(client.request('evaluate', { expression: '(marker)', frameId: stackFrames[0].id, context: 'repl' }));
      assert.strictEqual(result, 'marker-one');
      await ok(client.request('continue', { threadId }));
    };
    const options = { program: main, cwd: p.cwd };
    const cached = { ...options, debugCacheDirectory: p.cache };
    const uncached = await session(uncachedOptions(options), { [main]: [3] }, stops);
    assertSameTrace(await session(cached, { [main]: [3] }, stops), uncached, 'build');
    assertSameTrace(await session(cached, { [main]: [3] }, stops), uncached, 'reuse');
  });
}

test('compile-time effects run when building, once, and not when reusing', { timeout: 300000 }, async t => {
  const p = project(t);
  edit(p, 'macros.rkt', '(struct point', '(begin-for-syntax (displayln "at compile time"))\n(struct point');
  const options = { program: p.main, cwd: p.source };
  const stdout = result => JSON.parse(normalized(result.messages)[0]).stdout || '';
  const cached = { ...options, debugCacheDirectory: p.cache };
  const count = text => text.split('at compile time').length - 1;
  const uncached = await session(uncachedOptions(options), {});
  const built = await session(cached, {});
  const reused = await session(cached, {});
  assert.ok(count(stdout(uncached)) >= 1);
  assert.strictEqual(count(stdout(built)), count(stdout(uncached)));
  assert.strictEqual(count(stdout(reused)), 0);
});
