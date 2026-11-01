// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { targetFor, saveDocument } = require('./execution');
const { selectTests } = require('./test-selection');
const { TestCoverage, loadDetailedCoverage } = require('./test-coverage');
const { runPackageTask } = require('./packages');

function registerTesting(context, sessions) {
  const controller = vscode.tests.createTestController('racketdap.tests', 'Racket');
  const fileTag = new vscode.TestTag('racket-file');
  const files = new Map();
  const activeRuns = new Set();
  const discoveries = new Map(), cases = new WeakMap();
  const discoveryPath = context.asAbsolutePath('runtime/racketdap/test-discovery.rkt');
  let disposed = false, refreshPending = Promise.resolve();

  function itemFor(uri) {
    const id = uri.toString();
    if (files.has(id)) return files.get(id);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    let items = controller.items;
    if (folder) {
      const folderId = folder.uri.toString();
      let parent = items.get(folderId);
      if (!parent) {
        parent = controller.createTestItem(folderId, folder.name);
        items.add(parent);
      }
      items = parent.children;
    }
    const label = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : path.basename(uri.fsPath);
    const item = controller.createTestItem(id, label, uri);
    item.tags = [fileTag];
    item.description = 'test submodule or module body';
    item.canResolveChildren = true;
    items.add(item);
    files.set(id, item);
    return item;
  }

  async function resolveCases(item) {
    if (!vscode.workspace.isTrusted || !item.uri || cases.has(item) || disposed) return;
    const document = await vscode.workspace.openTextDocument(item.uri);
    const version = document.version, text = document.getText();
    const sourceHash = createHash('sha1').update(text).digest('hex');
    const previous = discoveries.get(item.id);
    if (previous?.sourceHash === sourceHash) return previous.done;
    previous?.child?.kill();
    const target = targetFor(item.uri);
    const pending = { sourceHash };
    pending.done = new Promise(resolve => {
      pending.child = execFile(target.racketExecutable, [discoveryPath],
        { cwd: target.cwd, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (discoveries.get(item.id) !== pending || disposed) return resolve();
          item.busy = false;
          if (document.version !== version) { discoveries.delete(item.id); return resolve(); }
          try {
            if (error) throw error;
            item.children.replace(JSON.parse(stdout).map(test => {
              const child = controller.createTestItem(`${item.id}#${test.id}`, test.name, item.uri);
              child.range = new vscode.Range(test.line, test.column, test.endLine, test.endColumn);
              cases.set(child, { file: item, id: test.id, sourceHash });
              return child;
            }));
            item.error = undefined;
          } catch (failure) {
            item.children.replace([]);
            item.error = `Cannot discover Racket tests: ${failure.message}`;
            discoveries.delete(item.id);
          }
          resolve();
        });
      pending.child.stdin.on('error', () => {}); // An early exit is reported by execFile.
      pending.child.stdin.end(text);
    });
    item.busy = true;
    discoveries.set(item.id, pending);
    return pending.done;
  }

  async function discover() {
    const uris = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const settings = vscode.workspace.getConfiguration('racketdap', folder.uri);
      uris.push(...await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, settings.get('testing.include', '**/*.rkt')),
        new vscode.RelativePattern(folder, settings.get('testing.exclude', '{**/compiled/**,**/node_modules/**,**/vendor/**,**/.git/**,**/.test-output/**,**/info.rkt}'))));
    }
    if (disposed) return;
    const found = new Set(uris.map(uri => uri.toString()));
    for (const [id, item] of files) {
      if (!found.has(id)) {
        (item.parent?.children || controller.items).delete(id);
        files.delete(id);
        discoveries.get(id)?.child?.kill();
        discoveries.delete(id);
      }
    }
    for (const uri of uris.sort((a, b) => a.toString().localeCompare(b.toString()))) itemFor(uri);
    const opened = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));
    for (const [id, item] of files) {
      if (discoveries.has(id) || opened.has(id)) await resolveCases(item);
    }
    controller.items.forEach(item => { if (!item.uri && item.children.size === 0) controller.items.delete(item.id); });
  }
  function refresh() {
    refreshPending = refreshPending.catch(() => {}).then(discover);
    return refreshPending;
  }
  controller.resolveHandler = item => item ? resolveCases(item) : refresh();
  controller.refreshHandler = refresh;

  function messageFor(result) {
    const message = new vscode.TestMessage(result.message);
    const loc = result.location;
    if (loc) message.location = new vscode.Location(vscode.Uri.file(loc.path),
      new vscode.Position(Math.max(0, loc.line - 1), Math.max(0, loc.column - 1)));
    return message;
  }

  async function execute(request, token, debug, coverage = false) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running tests.');
    if (!request.include) await refresh();
    const selected = selectTests(controller.items, request);
    const groups = new Map();
    for (const item of selected) {
      const file = cases.get(item)?.file || item;
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file).push(item);
    }
    const run = controller.createTestRun(request, coverage ? 'Racket test coverage' : debug ? 'Debug Racket tests' : 'Run Racket tests');
    const coverageResult = coverage ? new TestCoverage() : undefined;
    const cancellation = new vscode.CancellationTokenSource();
    const cancelProfile = token?.onCancellationRequested(() => cancellation.cancel());
    if (token?.isCancellationRequested) cancellation.cancel();
    const cancelRun = run.token.onCancellationRequested(() => cancellation.cancel());
    activeRuns.add(cancellation);
    const totals = { passed: 0, failed: 0, errored: 0, skipped: 0 };
    selected.forEach(item => run.enqueued(item));
    try {
      for (const [item, requested] of groups) {
        const wholeFile = requested[0] === item;
        if (cancellation.token.isCancellationRequested) { requested.forEach(test => run.skipped(test)); totals.skipped++; continue; }
        if (wholeFile) run.started(item);
        const started = Date.now();
        const failures = [];
        let summary;
        const coverageFiles = [];
        let activeCase;
        let children = new Set(wholeFile ? [] : requested);
        let runError;
        const caseFailures = new Map();
        const completed = new Set();
        try {
          const target = await saveDocument(await vscode.workspace.openTextDocument(item.uri));
          const testSelection = wholeFile ? undefined : {
            sourceHash: cases.get(requested[0]).sourceHash,
            ids: [...new Set(requested.map(child => cases.get(child).id))],
            cases: requested.filter(child => cases.get(child).path).map(child => {
              const { id, path } = cases.get(child);
              return { id, path };
            })
          };
          if (testSelection && requested.some(child => cases.get(child).sourceHash !== testSelection.sourceHash)) {
            throw new Error('Test selection is out of date. Refresh the tests and try again.');
          }
          if (!testSelection) await resolveCases(item);
          children = new Set(testSelection ? requested : [...item.children].map(([, child]) => child));
          const sourceHash = testSelection?.sourceHash || discoveries.get(item.id)?.sourceHash;
          const key = (id, path = []) => JSON.stringify([id, path]);
          const byId = new Map();
          function remember(parent) {
            parent.children.forEach(child => {
              const metadata = cases.get(child);
              byId.set(key(metadata.id, metadata.path), child);
              remember(child);
            });
          }
          remember(item);
          children.forEach(child => run.enqueued(child));
          const sourceRoots = vscode.workspace.getConfiguration('racketdap', item.uri)
            .get('testing.sourceRoots', ['.']).map(root => path.resolve(target.cwd, root));
          const record = await sessions.start(target, {
            name: `Racket tests: ${item.label}`, testMode: true, stopOnEntry: false, sourceRoots,
            ...(coverage ? { coverage: true } : {}),
            ...(testSelection ? { testSelection } : {})
          }, { noDebug: !debug, token: cancellation.token,
            onEvent(event) {
              if (event.event === 'output') run.appendOutput(event.body.output.replace(/\r?\n/g, '\r\n'), undefined, item);
              if (coverage && event.event === 'racketdap/coverage') coverageFiles.push(event.body);
              if (event.event === 'racketdap/test') {
                if (event.body.kind === 'failure') {
                  failures.push(event.body);
                  if (activeCase) {
                    if (!caseFailures.has(activeCase)) caseFailures.set(activeCase, []);
                    caseFailures.get(activeCase).push(messageFor(event.body));
                  }
                }
                if (event.body.kind === 'case') {
                  const { id, path: testPath, status } = event.body;
                  const parent = byId.get(key(id));
                  let child = byId.get(key(id, testPath));
                  if (testPath && parent) {
                    if (!child) {
                      const label = testPath.slice(testPath.length > 1 ? 1 : 0)
                        .map(part => part[1] || 'Unnamed test').join(' / ');
                      child = controller.createTestItem(`${parent.id}/${JSON.stringify(testPath)}`, label, item.uri);
                      child.description = 'discovered during execution';
                      cases.set(child, { file: item, id, path: testPath, sourceHash });
                      byId.set(key(id, testPath), child);
                    }
                    parent.children.add(child);
                  }
                  if (child) children.add(child);
                  if (child && status === 'started') {
                    if (!testPath) child.children.replace([]);
                    activeCase = child; run.started(child);
                  }
                  else if (child) {
                    if (status === 'passed') run.passed(child);
                    else if (status === 'skipped') run.skipped(child);
                    else {
                      const messages = caseFailures.get(child) || new vscode.TestMessage('Test failed; see test output.');
                      if (status === 'errored') run.errored(child, messages);
                      else run.failed(child, messages);
                    }
                    completed.add(child); activeCase = testPath ? parent : undefined;
                  }
                }
                if (event.body.kind === 'summary') summary = event.body;
              }
            }
          });
          const result = record && await record.done;
          if (cancellation.token.isCancellationRequested) { if (wholeFile) run.skipped(item); totals.skipped++; continue; }
          const duration = Date.now() - started;
          if (!summary) throw new Error(`Test process ended before reporting results (exit ${result?.exitCode ?? 'unknown'}).`);
          if (summary.status !== 'errored' && (result.exitCode === 0 || summary.status === 'failed')) {
            coverageFiles.forEach(file => coverageResult?.add(file));
          }
          const messages = failures.map(messageFor);
          if (summary.status === 'errored' || (result.exitCode !== 0 && summary.status === 'passed')) {
            run.errored(item, messages.length ? messages : new vscode.TestMessage('Test execution failed; see test output.'), duration);
            totals.errored++;
          } else if (summary.status === 'failed') {
            run.failed(item, messages.length ? messages : new vscode.TestMessage(`${summary.failed} of ${summary.total} checks failed; see test output.`), duration);
            totals.failed++;
          } else {
            if (wholeFile) run.passed(item, duration); totals.passed++;
          }
          run.appendOutput(`${summary.total} checks, ${summary.failed} failures.\r\n`, undefined, item);
        } catch (error) {
          runError = error;
          if (cancellation.token.isCancellationRequested) { if (wholeFile) run.skipped(item); totals.skipped++; }
          else { run.errored(item, new vscode.TestMessage(error.message), Date.now() - started); totals.errored++; }
        } finally {
          for (const child of children) {
            if (!completed.has(child)) {
              if (cancellation.token.isCancellationRequested) run.skipped(child);
              else run.errored(child, new vscode.TestMessage(runError?.message || failures[0]?.message || 'The test did not finish; see test output.'));
            }
          }
        }
      }
      await coverageResult?.publish(run, cancellation.token);
      return totals;
    } finally {
      run.end(); cancelRun.dispose(); cancelProfile?.dispose(); activeRuns.delete(cancellation); cancellation.dispose();
    }
  }
  const runProfile = controller.createRunProfile('Run', vscode.TestRunProfileKind.Run,
    (request, token) => execute(request, token, false), true);
  const debugProfile = controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug,
    (request, token) => execute(request, token, true), true);
  const coverageProfile = controller.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage,
    (request, token) => execute(request, token, false, true), true);
  coverageProfile.loadDetailedCoverage = loadDetailedCoverage;
  const packageProfile = controller.createRunProfile('Run with package policies (raco test)', vscode.TestRunProfileKind.Run,
    async (request, token) => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running tests.');
      if (!request.include) await refresh();
      const selected = selectTests(controller.items, request);
      const run = controller.createTestRun(request, 'Racket package tests');
      const cancellation = new vscode.CancellationTokenSource();
      const cancelProfile = token.onCancellationRequested(() => cancellation.cancel());
      const cancelRun = run.token.onCancellationRequested(() => cancellation.cancel());
      if (token.isCancellationRequested) cancellation.cancel();
      activeRuns.add(cancellation);
      try {
        for (const item of selected) {
          if (cancellation.token.isCancellationRequested) { run.skipped(item); continue; }
          if (cases.has(item)) {
            run.errored(item, new vscode.TestMessage('raco test runs files. Select a file or workspace folder for package policies.'));
            continue;
          }
          run.started(item);
          try {
            const target = await saveDocument(await vscode.workspace.openTextDocument(item.uri));
            run.appendOutput('Running raco test with package policies. Output is in the dedicated task terminal.\r\n', undefined, item);
            const result = await runPackageTask({ folder: vscode.workspace.getWorkspaceFolder(item.uri),
              cwd: target.cwd, executable: target.racketExecutable }, `Test ${item.label}`,
              ['test', '--process', '--modules', '--timeout', '+inf.0', '--', item.uri.fsPath], cancellation.token);
            if (cancellation.token.isCancellationRequested) run.skipped(item);
            else if (result.exitCode === 0) run.passed(item);
            else if (result.exitCode === undefined) run.errored(item, new vscode.TestMessage('raco test did not finish; see its task terminal.'));
            else run.failed(item, new vscode.TestMessage('raco test failed; see its task terminal.'));
          } catch (error) {
            if (cancellation.token.isCancellationRequested) run.skipped(item);
            else run.errored(item, new vscode.TestMessage(error.message));
          }
        }
      } finally {
        run.end(); cancelRun.dispose(); cancelProfile.dispose(); activeRuns.delete(cancellation); cancellation.dispose();
      }
    });
  packageProfile.tag = fileTag;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{rkt,rktl,ss,scm,scrbl}');
  let refreshTimer;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh().catch(error => { void vscode.window.showErrorMessage(`Racket test discovery: ${error.message}`); }); }, 200);
  }
  context.subscriptions.push(controller, watcher,
    watcher.onDidCreate(scheduleRefresh), watcher.onDidDelete(scheduleRefresh),
    watcher.onDidChange(() => { controller.invalidateTestResults(); scheduleRefresh(); }),
    vscode.workspace.onDidOpenTextDocument(document => {
      const item = files.get(document.uri.toString());
      if (item) void resolveCases(item).catch(() => {});
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'racket' && event.document.uri.scheme === 'file' && event.contentChanges.length) {
        controller.invalidateTestResults();
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('racketdap.testing')) scheduleRefresh(); }),
    { dispose() {
      disposed = true; clearTimeout(refreshTimer);
      for (const pending of discoveries.values()) pending.child?.kill();
      for (const run of activeRuns) run.cancel();
    } });
  return {
    async runFile(uri, debug = false) {
      const item = itemFor(targetFor(uri).uri);
      return execute(new vscode.TestRunRequest([item], undefined, debug ? debugProfile : runProfile), undefined, debug);
    }
  };
}

module.exports = { registerTesting };
