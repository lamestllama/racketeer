// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { requestDependencies } = require('../vscode/dependency-process');
const { dependencyFixture } = require('./support/dependency-fixture');
const root = path.resolve(__dirname, '..'), helper = path.join(root, 'racketdap/tools/dependency-worker.rkt'), collects = path.join(root, 'vendor/collects');
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-dependencies-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const request = (file, buffers = [], options) => requestDependencies('racket', helper, collects, { version: 1, path: file, buffers, roots: [path.dirname(file)] }, options);
const moduleAt = (result, names = []) => result.modules.find(module => JSON.stringify(module.submodules) === JSON.stringify(names));
function emitter() { const callbacks = new Set(); return { event(fn) { callbacks.add(fn); return { dispose: () => callbacks.delete(fn) }; }, fire(e) { for (const fn of callbacks) fn(e); }, dispose() { callbacks.clear(); } }; }
function harness(t, analyze) {
  const root = directory(t), uri = file => ({ scheme: 'file', fsPath: file });
  const watchers = [], subscriptions = [], commands = new Map(), documents = [], events = {};
  const vscode = { EventEmitter: emitter, ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, collapsibleState = 0) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, Uri: { file: uri },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: { isTrusted: true, textDocuments: documents, workspaceFolders: [{ uri: uri(root) }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }), createFileSystemWatcher(pattern) {
        const change = emitter(), watcher = { pattern, onDidCreate: change.event, onDidChange: change.event, onDidDelete: change.event,
          fire: change.fire, dispose() { this.disposed = true; change.dispose(); } }; watchers.push(watcher); return watcher;
      } }, window: { showErrorMessage() {}, createTreeView(_id, options) { this.provider = options.treeDataProvider; return { dispose() {}, reveal: async () => {} }; } },
    commands: { registerCommand(name, run) { commands.set(name, run); return { dispose() {} }; }, executeCommand: async () => {} } };
  for (const name of ['onDidChangeTextDocument', 'onDidOpenTextDocument', 'onDidCloseTextDocument', 'onDidChangeWorkspaceFolders', 'onDidChangeConfiguration']) { events[name] = emitter(); vscode.workspace[name] = events[name].event; }
  const source = path.join(__dirname, '../vscode/dependencies.js'), local = createRequire(source), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, Buffer, AbortController, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? vscode : name === './dependency-process' ? { requestDependencies: analyze } : local(name) }, { filename: source });
  const context = { subscriptions, asAbsolutePath: value => path.join(root, value) };
  const provider = module.exports.registerDependencies(context); t.after(() => subscriptions.forEach(s => s.dispose()));
  return { provider, root, uri, watchers, commands, documents, events, vscode };
}

test('imports retain phase shifts, label imports and relative submodules without running program bodies', async t => {
  const dir = directory(t), fixture = dependencyFixture(dir), result = await request(fixture.file);
  const imports = moduleAt(result).imports;
  assert.ok(imports.some(i => i.path === path.join(dir, 'runtime.rkt') && i.phase === 0));
  assert.deepEqual(imports.filter(i => i.name === 'compile.rkt').map(i => i.phase).sort(), [1, 2]);
  assert.ok(imports.some(i => i.name === 'list.rkt' && i.phase === null));
  const tests = moduleAt(result, ['test']);
  assert.ok(tests.imports.some(i => i.path === fixture.file && i.submodules.length === 0));
  assert.ok(tests.imports.some(i => i.path === fixture.file && i.submodules.join('/') === 'inner'));
  assert.equal(fs.existsSync(path.join(dir, 'executed')), false);
  assert.equal(fs.existsSync(path.join(dir, 'compiled')), false);
  for (const [name, text] of Object.entries(fixture.files)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text);
});

test('unsaved transitive compile-time imports replace compiled intermediates and reset when the buffer closes', async t => {
  const dir = directory(t), fixture = dependencyFixture(dir);
  const compiled = spawnSync('raco', ['make', path.join(dir, 'bridge.rkt')], { encoding: 'utf8', timeout: 15000 }); assert.equal(compiled.status, 0, compiled.stderr);
  const changed = await request(fixture.file, [{ path: fixture.selector, text: fixture.replacement }]);
  assert.ok(moduleAt(changed).imports.some(i => i.name === 'new.rkt'));
  assert.ok(!moduleAt(changed).imports.some(i => i.name === 'old.rkt'));
  assert.ok(changed.files.includes(fixture.selector));
  const closed = await request(fixture.file); assert.ok(moduleAt(closed).imports.some(i => i.name === 'old.rkt'));
  assert.equal(fs.readFileSync(fixture.selector, 'utf8'), fixture.files['selector.rkt']);
});

test('dependency analysis uses no GUI application modules and malformed source reports its error', async t => {
  const dir = directory(t), fixture = dependencyFixture(dir), engine = path.join(root, 'racketdap/tools/module-dependencies.rkt');
  const expression = `(define resolve (current-module-name-resolver)) (parameterize ([current-module-name-resolver (case-lambda [(p n) (resolve p n)] [(p r s l) (when (regexp-match? #rx"drracket" (format "~s" p)) (error 'dependency "Forbidden dependency")) (resolve p r s l)])]) (define analyze (dynamic-require '(file ${JSON.stringify(engine)}) 'module-dependencies)) (void (analyze ${JSON.stringify(fixture.file)} '() '())))`;
  const result = spawnSync('racket', ['-S', collects, '-e', expression], { encoding: 'utf8', timeout: 15000 }); assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(fixture.file, '#lang racket/base\n('); await assert.rejects(request(fixture.file), /expected a.*\)/);
});

test('a source change during expansion is refused instead of publishing mixed dependency state', async t => {
  const dir = directory(t), fixture = dependencyFixture(dir), dependency = path.join(dir, 'runtime.rkt');
  fs.appendFileSync(fixture.file, `\n(require (for-syntax racket/base))\n(begin-for-syntax (call-with-output-file ${JSON.stringify(dependency)} (lambda (out) (display "#lang racket/base\\n" out)) #:exists 'truncate/replace))\n`);
  await assert.rejects(request(fixture.file), /Source changed during analysis/);
});

test('tree navigation distinguishes phase edges and submodules, stops cycles and shares file analysis', async t => {
  let calls = 0;
  const h = harness(t, async (_exe, _helper, _collects, request) => { calls++; return { files: [request.path], modules: [
    { submodules: [], imports: [{ name: 'main.rkt', path: request.path, submodules: [], phase: 1 }, { name: '#%kernel', path: null, submodules: [], phase: 0 }], children: [['test']] },
    { submodules: ['test'], imports: [{ name: 'main.rkt', path: request.path, submodules: [], phase: 0 }], children: [] }] }; });
  const file = path.join(h.root, 'main.rkt'); h.provider.refresh(file);
  const [root] = await h.provider.getChildren(), children = await h.provider.getChildren(root);
  assert.equal(h.provider.getTreeItem(children[0]).description, 'phase +1 · already in this branch');
  assert.equal(h.provider.getTreeItem(children[0]).command.arguments[0].fsPath, file);
  assert.equal(h.provider.getTreeItem(children[1]).command, undefined);
  assert.equal(h.provider.getTreeItem(children[2]).description, 'submodule');
  assert.equal((await h.provider.getChildren(children[0])).length, 0);
  assert.equal((await h.provider.getChildren(children[2]))[0].cycle, true); assert.equal(calls, 1);
  assert.strictEqual(h.provider.getParent(children[2]), root);
});

test('source changes cancel stale requests, capture fresh buffers and replace outside-workspace watchers', async t => {
  let finish, signal, captured;
  const h = harness(t, (_exe, _helper, _collects, request, options) => { signal = options.signal; captured = request; return new Promise(resolve => { finish = resolve; }); });
  const file = path.join(h.root, 'main.rkt'), outside = path.join(path.dirname(h.root), 'other/dependency.rkt');
  const doc = { uri: h.uri(file), languageId: 'racket', getText: () => '#lang racket/base\n' }; h.documents.push(doc);
  h.provider.refresh(file); const [first] = await h.provider.getChildren(), pending = h.provider.getChildren(first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captured.buffers[0].text, doc.getText());
  h.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] }); assert.equal(signal.aborted, true);
  finish({ files: [outside], modules: [] }); assert.equal((await pending).length, 0);
  assert.equal(h.watchers.length, 1); await new Promise(resolve => setTimeout(resolve, 300));
  const [second] = await h.provider.getChildren(), next = h.provider.getChildren(second);
  await new Promise(resolve => setImmediate(resolve));
  finish({ files: [file, outside], modules: [{ submodules: [], imports: [], children: [] }] }); await next;
  assert.ok(h.watchers.some(w => w.pattern.base === path.dirname(outside)));
  const watchers = [...h.watchers]; h.provider.dispose(); assert.ok(watchers.every(w => w.disposed)); assert.equal(signal.aborted, true);
});

test('untrusted workspaces and disposed trees start no analysis; failures remain visible until refresh', async t => {
  let calls = 0; const h = harness(t, async () => { calls++; throw new Error('broken module'); });
  h.vscode.workspace.isTrusted = false; await h.commands.get('racketdap.browseDependencies')(h.uri(path.join(h.root, 'main.rkt')));
  assert.equal(calls, 0); assert.equal((await h.provider.getChildren()).length, 0);
  h.vscode.workspace.isTrusted = true; h.provider.refresh(path.join(h.root, 'main.rkt'));
  const [root] = await h.provider.getChildren(), [error] = await h.provider.getChildren(root); assert.match(error.message, /broken module/);
  assert.equal(h.provider.getTreeItem(error).collapsibleState, 0);
  h.provider.dispose(); assert.equal((await h.provider.getChildren(root)).length, 0); assert.equal(calls, 1);
});

test('expanding different files serializes analysis and cancellation prevents queued work from starting', async t => {
  let finish, calls = 0;
  const h = harness(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  h.provider.refresh(path.join(h.root, 'main.rkt'));
  const parent = h.provider.root;
  const a = h.provider.node({ path: path.join(h.root, 'a.rkt'), name: 'a.rkt', submodules: [] }, parent);
  const b = h.provider.node({ path: path.join(h.root, 'b.rkt'), name: 'b.rkt', submodules: [] }, parent);
  const first = h.provider.getChildren(a), second = h.provider.getChildren(b);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  h.provider.dispose(); finish({ files: [], modules: [] });
  assert.equal((await first).length, 0); assert.equal((await second).length, 0); assert.equal(calls, 1);
});

test('cancellation and deadlines release a stalled transformer and its ordinary child process', { timeout: 25000 }, async t => {
  const dir = directory(t), file = path.join(dir, 'blocked.rkt'), receipt = path.join(dir, 'child-pid');
  fs.writeFileSync(file, `#lang racket/base\n(require (for-syntax racket/base racket/system))\n(begin-for-syntax\n (define-values (child out in err) (subprocess #f #f #f (find-executable-path "racket") "-e" "(sync never-evt)"))\n (call-with-output-file ${JSON.stringify(receipt)} (lambda (out) (write (subprocess-pid child) out)) #:exists 'truncate/replace)\n (sync never-evt))\n`);
  for (const mode of ['cancel', 'timeout']) {
    const controller = new AbortController();
    const pending = request(file, [], { signal: controller.signal, timeout: mode === 'timeout' ? 5000 : 15000 });
    t.after(async () => { controller.abort(new Error('cancelled')); await pending.catch(() => {}); });
    const failed = assert.rejects(pending, mode === 'timeout' ? /timed out/ : /cancelled/);
    const deadline = Date.now() + 8000; while (!fs.existsSync(receipt) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(receipt)); const pid = Number(fs.readFileSync(receipt, 'utf8'));
    if (mode === 'cancel') controller.abort(new Error('cancelled'));
    await failed;
    if (process.platform === 'linux') {
      const stat = `/proc/${pid}/stat`; const end = Date.now() + 3000;
      while (fs.existsSync(stat) && fs.readFileSync(stat, 'utf8').split(' ')[2] !== 'Z' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!fs.existsSync(stat) || fs.readFileSync(stat, 'utf8').split(' ')[2] === 'Z');
    }
    fs.unlinkSync(receipt);
  }
});
