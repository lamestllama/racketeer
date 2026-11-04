// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const treeRemoval = require('./support/tree-removal');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const vscode = require('vscode');

// Use the artifact's verified source snapshot with real TestItems, TestRuns,
// tasks and the installed adapter. Capture public API calls under a separate
// controller identifier; production exposes no test-only controller access.
exports.run = async function (extension, workspace) {
  const profiles = new Map(), runs = [];
  let controller;
  const testApi = { ...vscode, tests: {
    createTestController(id, label) {
      controller = vscode.tests.createTestController(`${id}.regression`, label);
      return new Proxy(controller, {
        set(target, key, value) { return Reflect.set(target, key, value, target); },
        get(target, key) {
          if (key === 'createRunProfile') return (name, kind, handler, ...rest) => {
            const profile = target.createRunProfile(name, kind, handler, ...rest);
            profiles.set(name, { profile, handler });
            return profile;
          };
          if (key === 'createTestRun') return (...args) => {
            const run = target.createTestRun(...args), states = new Map();
            runs.push(states);
            return new Proxy(run, { get(target, key) {
              const value = Reflect.get(target, key, target);
              if (['passed', 'failed', 'errored', 'skipped'].includes(key)) return (item, ...args) => {
                states.set(item.id, { status: key, messages: args[0] });
                return value.call(target, item, ...args);
              };
              return typeof value === 'function' ? value.bind(target) : value;
            } });
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  } };
  const filename = path.join(__dirname, 'extension', 'testing.js');
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? testApi : localRequire(name)
  }, { filename });
  const context = { subscriptions: [], asAbsolutePath: relative => path.join(extension.extensionPath, relative) };
  const sessions = localRequire('./sessions').registerSessions(context);
  module.exports.registerTesting(context, sessions);
  const directory = path.join(workspace.uri.fsPath, 'test-explorer');
  fs.mkdirSync(directory, { recursive: true });
  const settings = vscode.workspace.getConfiguration('racketdap', workspace.uri);
  const previous = settings.inspect('testing.include').workspaceValue;
  const children = item => [...item.children].map(([, child]) => child);
  async function file(name, source) {
    const uri = vscode.Uri.file(path.join(directory, name));
    fs.writeFileSync(uri.fsPath, source);
    await vscode.workspace.openTextDocument(uri);
    await controller.refreshHandler();
    const item = controller.items.get(workspace.uri.toString()).children.get(uri.toString());
    assert.ok(item, name);
    await controller.resolveHandler(item);
    return item;
  }
  async function run(name, items, token, exclude) {
    const { profile, handler } = profiles.get(name);
    const cancellation = token || new vscode.CancellationTokenSource();
    try {
      await handler(new vscode.TestRunRequest(items, exclude, profile), cancellation.token);
      return runs.at(-1);
    } finally { if (!token) cancellation.dispose(); }
  }
  try {
    await settings.update('testing.include', 'test-explorer/*.rkt', vscode.ConfigurationTarget.Workspace);
    const source = '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
      '(define suite (test-suite "outer"\n' +
      ' (test-suite "inner" (test-case "same" (check-true #f)) (test-case "same" (check-true #t)))\n' +
      ' (for ([n 2]) (test-case (number->string n) (check-equal? n n)))))\n(run-tests suite)\n';
    const item = await file('bound.rkt', source);
    const root = children(item)[0];
    assert.equal(root.label, 'suite');
    assert.equal(root.children.size, 0, 'Refresh never executes the suite');
    const full = await run('Run', [item]);
    assert.equal(full.get(item.id).status, 'failed');
    let nested = children(root);
    assert.equal(nested.length, 4);
    assert.deepEqual(nested.map(child => full.get(child.id).status), ['failed', 'passed', 'passed', 'passed']);
    assert.equal(full.get(nested[0].id).messages[0].location.range.start.line, 3);
    assert.notEqual(nested[0].id, nested[1].id);
    for (const name of ['Run', 'Debug', 'Coverage']) {
      const selected = nested[1];
      const result = await run(name, [selected]);
      assert.equal(result.get(selected.id).status, 'passed', name);
      assert.equal(result.get(nested[0].id).status, 'skipped', name);
      assert.equal(result.get(root.id).status, 'passed', name);
      assert.equal(root.children.size, 4);
      nested = children(root);
    }
    const excluded = await run('Run', [item], undefined, [nested[0]]);
    assert.equal(excluded.get(nested[0].id).status, 'skipped');
    assert.ok(nested.slice(1).every(child => excluded.get(child.id).status === 'passed'));
    const savedChild = nested[1];
    fs.writeFileSync(item.uri.fsPath, source.replace('check-true #t', 'check-true #f'));
    const stale = await run('Run', [savedChild]);
    assert.equal(stale.get(savedChild.id).status, 'errored', 'Stale runtime selections are rejected');

    fs.writeFileSync(path.join(directory, 'info.rkt'), '#lang info\n' +
      '(define test-omit-paths \'("omitted.rkt"))\n' +
      '(define test-command-line-arguments \'(("policy.rkt" ("package-argument"))))\n' +
      '(define test-timeouts \'(("timeout.rkt" 1)))\n');
    const policy = await file('policy.rkt', '#lang racket/base\n(require rackunit)\n' +
      '(check-equal? (current-command-line-arguments) #("package-argument"))\n');
    const omitted = await file('omitted.rkt', '#lang racket/base\n(error "omitted file ran")\n');
    const nativeProfile = 'Run with package policies (raco test)';
    const policies = await run(nativeProfile, [policy, omitted]);
    assert.equal(policies.get(policy.id).status, 'passed');
    assert.equal(policies.get(omitted.id).status, 'passed');
    const timeout = await file('timeout.rkt', '#lang racket/base\n(sync never-evt)\n');
    const timeoutCancellation = new vscode.CancellationTokenSource();
    const watchdog = setTimeout(() => timeoutCancellation.cancel(), 15000);
    try {
      const timed = await run(nativeProfile, [timeout], timeoutCancellation);
      assert.equal(timed.get(timeout.id).status, 'failed', 'raco owns timeout handling');
    } finally { clearTimeout(watchdog); timeoutCancellation.dispose(); }
    const marker = path.join(directory, 'pid.txt');
    const blocked = await file('blocked.rkt', '#lang racket/base\n(require racket/os)\n' +
      `(call-with-output-file ${JSON.stringify(marker)} (lambda (out) (display (getpid) out)))\n(sync never-evt)\n`);
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const pending = run(nativeProfile, [blocked], cancellation);
      pending.catch(() => {});
            // Racket creates the file before it writes the number.
      const pid = await until(() => fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0, 'Native test process starts');
      cancellation.cancel();
      assert.equal((await pending).get(blocked.id).status, 'skipped');
      await until(() => exited(pid), `Native test cancellation reaps the child ${pid}`);
    } finally { cancellation.dispose(); }
    const recovered = await run(nativeProfile, [policy]);
    assert.equal(recovered.get(policy.id).status, 'passed');
    return ['nested TestItems have separate results and failure locations',
      'bound and generated suites populate results only during execution',
      'nested Run, Debug, Coverage, duplicate names and exclusions',
      'stale nested selections are rejected', 'Test Explorer raco profile honors omissions, arguments and timeouts',
      'Test Explorer native task cancellation reaps children and allows reruns'];
  } finally {
    context.subscriptions.reverse().forEach(item => item.dispose());
    await settings.update('testing.include', previous, vscode.ConfigurationTarget.Workspace);
    fs.rmSync(directory, treeRemoval);
  }
};
