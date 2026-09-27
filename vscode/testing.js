'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { targetFor, saveDocument } = require('./execution');
const { selectTests } = require('./test-selection');

function registerTesting(context, sessions) {
  const controller = vscode.tests.createTestController('racketdap.tests', 'Racket');
  const files = new Map();
  const activeRuns = new Set();
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
    item.description = 'test submodule or module body';
    items.add(item);
    files.set(id, item);
    return item;
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
      }
    }
    for (const uri of uris.sort((a, b) => a.toString().localeCompare(b.toString()))) itemFor(uri);
    controller.items.forEach(item => { if (!item.uri && item.children.size === 0) controller.items.delete(item.id); });
  }
  function refresh() {
    refreshPending = refreshPending.catch(() => {}).then(discover);
    return refreshPending;
  }
  controller.resolveHandler = item => item ? undefined : refresh();
  controller.refreshHandler = refresh;

  function messageFor(result) {
    const message = new vscode.TestMessage(result.message);
    const loc = result.location;
    if (loc) message.location = new vscode.Location(vscode.Uri.file(loc.path),
      new vscode.Position(Math.max(0, loc.line - 1), Math.max(0, loc.column - 1)));
    return message;
  }

  async function execute(request, token, debug) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running tests.');
    if (!request.include) await refresh();
    const items = selectTests(controller.items, request);
    const run = controller.createTestRun(request, debug ? 'Debug Racket tests' : 'Run Racket tests');
    const cancellation = new vscode.CancellationTokenSource();
    const cancelProfile = token?.onCancellationRequested(() => cancellation.cancel());
    if (token?.isCancellationRequested) cancellation.cancel();
    const cancelRun = run.token.onCancellationRequested(() => cancellation.cancel());
    activeRuns.add(cancellation);
    const totals = { passed: 0, failed: 0, errored: 0, skipped: 0 };
    items.forEach(item => run.enqueued(item));
    try {
      for (const item of items) {
        if (cancellation.token.isCancellationRequested) { run.skipped(item); totals.skipped++; continue; }
        run.started(item);
        const started = Date.now();
        const failures = [];
        let summary;
        try {
          const target = await saveDocument(await vscode.workspace.openTextDocument(item.uri));
          const sourceRoots = vscode.workspace.getConfiguration('racketdap', item.uri)
            .get('testing.sourceRoots', ['.']).map(root => path.resolve(target.cwd, root));
          const record = await sessions.start(target, {
            name: `Racket tests: ${item.label}`, testMode: true, stopOnEntry: false, sourceRoots
          }, { noDebug: !debug, token: cancellation.token,
            onEvent(event) {
              if (event.event === 'output') run.appendOutput(event.body.output.replace(/\r?\n/g, '\r\n'), undefined, item);
              if (event.event === 'racketdap/test') {
                if (event.body.kind === 'failure') failures.push(event.body);
                if (event.body.kind === 'summary') summary = event.body;
              }
            }
          });
          const result = record && await record.done;
          if (cancellation.token.isCancellationRequested) { run.skipped(item); totals.skipped++; continue; }
          const duration = Date.now() - started;
          if (!summary) throw new Error(`Test process ended before reporting results (exit ${result?.exitCode ?? 'unknown'}).`);
          const messages = failures.map(messageFor);
          if (summary.status === 'errored' || (result.exitCode !== 0 && summary.status === 'passed')) {
            run.errored(item, messages.length ? messages : new vscode.TestMessage('Test execution failed; see test output.'), duration);
            totals.errored++;
          } else if (summary.status === 'failed') {
            run.failed(item, messages.length ? messages : new vscode.TestMessage(`${summary.failed} of ${summary.total} checks failed; see test output.`), duration);
            totals.failed++;
          } else {
            run.passed(item, duration); totals.passed++;
          }
          run.appendOutput(`${summary.total} checks, ${summary.failed} failures.\r\n`, undefined, item);
        } catch (error) {
          if (cancellation.token.isCancellationRequested) { run.skipped(item); totals.skipped++; }
          else { run.errored(item, new vscode.TestMessage(error.message), Date.now() - started); totals.errored++; }
        }
      }
      return totals;
    } finally {
      run.end(); cancelRun.dispose(); cancelProfile?.dispose(); activeRuns.delete(cancellation); cancellation.dispose();
    }
  }
  const runProfile = controller.createRunProfile('Run', vscode.TestRunProfileKind.Run,
    (request, token) => execute(request, token, false), true);
  const debugProfile = controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug,
    (request, token) => execute(request, token, true), true);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{rkt,rktl,ss,scm,scrbl}');
  let refreshTimer;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh().catch(error => { void vscode.window.showErrorMessage(`Racket test discovery: ${error.message}`); }); }, 200);
  }
  context.subscriptions.push(controller, watcher,
    watcher.onDidCreate(scheduleRefresh), watcher.onDidDelete(scheduleRefresh),
    watcher.onDidChange(() => controller.invalidateTestResults()),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'racket' && event.document.uri.scheme === 'file' && event.contentChanges.length) {
        controller.invalidateTestResults();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('racketdap.testing')) scheduleRefresh(); }),
    { dispose() { disposed = true; clearTimeout(refreshTimer); for (const run of activeRuns) run.cancel(); } });
  return {
    async runFile(uri, debug = false) {
      const item = itemFor(targetFor(uri).uri);
      return execute(new vscode.TestRunRequest([item], undefined, debug ? debugProfile : runProfile), undefined, debug);
    }
  };
}

module.exports = { registerTesting };
