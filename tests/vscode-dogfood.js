// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Exercise the installed extension's real commands against an isolated copy
// of our own suites. No controller internals or replacement test runner.
exports.run = async function () {
  const extension = vscode.extensions.getExtension('lamestllama.racketeer');
  assert.ok(extension, 'Packaged extension is installed');
  await extension.activate();
  const workspace = vscode.workspace.workspaceFolders[0];
  const testUri = vscode.Uri.file(path.join(workspace.uri.fsPath, 'tests/protocol-inspection.rkt'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(testUri), { preview: false });
  await extension.exports.languageServerReady();
  const expected = new Map([
    ['experiments/lexical-eval.rkt', 10],
    ['tests/attach.rkt', 28],
    ['tests/headless.rkt', 22],
    ['tests/instrumentation-lifetime.rkt', 10],
    ['tests/loader-isolation.rkt', 14],
    ['tests/macro-stepper.rkt', 10],
    ['tests/packages.rkt', 3],
    ['tests/parity-languages.rkt', 13],
    ['tests/predicted-bindings.rkt', 7],
    ['tests/protocol-inspection.rkt', 25],
    ['tests/source-positions.rkt', 4],
    ['tests/stepping.rkt', 12],
    ['tests/source-loading.rkt', 10],
    ['tests/thread-pause.rkt', 6],
    ['tests/wxme-source.rkt', 9]
  ]);
  const sessions = [], messages = [], checks = [];
  const active = new Set();
  const onEnded = vscode.debug.onDidTerminateDebugSession(session => active.delete(session));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.push(session);
      active.add(session);
      return { onDidSendMessage(message) { messages.push({ session, ...message }); } };
    }
  });
  async function until(check, description) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${description}. ${JSON.stringify(messages.slice(-10))}`);
  }
  function event(session, name, predicate = () => true) {
    return until(() => messages.find(message => message.session.id === session.id &&
      message.event === name && predicate(message)), name);
  }
  const relative = session => path.relative(workspace.uri.fsPath, session.configuration.program).split(path.sep).join('/');
  let breakpoint;
  async function removeBreakpoint(session) {
    const start = messages.length;
    vscode.debug.removeBreakpoints([breakpoint]);
    breakpoint = undefined;
    // Removing an editor breakpoint schedules a DAP request asynchronously.
    // Finish that request before allowing the target to exit or stopping it.
    await until(() => messages.slice(start).some(message => message.session.id === session.id &&
      message.type === 'response' && message.command === 'setBreakpoints' && message.success &&
      message.body.breakpoints.length === 0), 'adapter acknowledges breakpoint removal');
  }
  try {
    await vscode.commands.executeCommand('workbench.view.testing.focus');
    await vscode.commands.executeCommand('testing.refreshTests');
    const settings = vscode.workspace.getConfiguration('racketdap', workspace.uri);
    const discovered = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspace, settings.get('testing.include')),
      new vscode.RelativePattern(workspace, settings.get('testing.exclude')));
    assert.deepEqual(discovered.map(uri => path.relative(workspace.uri.fsPath, uri.fsPath).split(path.sep).join('/')).sort(),
      [...expected.keys()].sort(), 'Workspace globs select the real suites');
    for (const [command, noDebug, coverage] of [
      ['testing.runAll', true, false], ['testing.debugAll', false, false], ['testing.coverageAll', true, true]
    ]) {
      console.log(`${command}: repository suites through Test Explorer`);
      const started = Date.now(), start = sessions.length;
      await vscode.commands.executeCommand(command);
      await until(() => sessions.length >= start + expected.size, 'Test Explorer runs every real suite');
      const profileSessions = sessions.slice(start);
      for (const session of profileSessions) {
        const file = relative(session);
        assert.ok(expected.has(file), `Only suites should run, not fixtures or helpers: ${file}`);
        assert.equal(!!session.configuration.noDebug, noDebug);
        assert.equal(!!session.configuration.coverage, coverage);
        assert.equal(session.configuration.testMode, true);
        assert.deepEqual(session.configuration.sourceRoots,
          ['tests', 'experiments'].map(directory => path.join(workspace.uri.fsPath, directory)));
        const summary = await event(session, 'racketdap/test', m => m.body.kind === 'summary');
        assert.deepEqual(summary.body, { kind: 'summary', status: 'passed', failed: 0, total: expected.get(file) }, file);
        await event(session, 'terminated');
        assert.equal((await event(session, 'exited')).body.exitCode, 0);
        if (command === 'testing.runAll') checks.push({ file, total: summary.body.total });
        if (coverage) {
          const report = await event(session, 'racketdap/coverage', m => m.body.path === session.configuration.program);
          assert.ok(report.body.statements.some(statement => statement.executed), `${file} has executed expressions`);
        }
        console.log(`${file}: ${summary.body.total} passed`);
      }
      assert.deepEqual(profileSessions.map(relative).sort(), [...expected.keys()].sort());
      console.log(`${command} passed in ${Math.round((Date.now() - started) / 1000)} s`);
    }

    // Debug the transport regression: inspect a real local, then resume the
    // same suite to completion through the extension's Debug Test action.
    const document = await vscode.workspace.openTextDocument(testUri);
    await vscode.window.showTextDocument(document, { preview: false });
    const original = document.getText();
    const position = document.positionAt(original.indexOf('(define in (open-input-bytes'));
    assert.ok(position.line > 0, 'Debug target exists');
    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(document.uri, position));
    vscode.debug.addBreakpoints([breakpoint]);
    const before = sessions.length;
    const debugging = vscode.commands.executeCommand('racketdap.debugTestFile');
    console.log('Debugging the transport regression');
    await until(() => sessions.length > before, 'Debug Test starts');
    const session = sessions[before];
    const stop = await event(session, 'stopped');
    assert.equal(stop.body.reason, 'breakpoint');
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: stop.body.threadId });
    assert.equal(stackFrames[0].source.path, document.uri.fsPath);
    assert.equal((await session.customRequest('evaluate', {
      frameId: stackFrames[0].id, expression: '(hash-ref message \'text)', context: 'watch'
    })).result, '"😀λ"');
    await removeBreakpoint(session);
    await session.customRequest('continue', { threadId: stop.body.threadId });
    assert.deepEqual(await debugging, { passed: 1, failed: 0, errored: 0, skipped: 0 });

    // A failing assertion in the disposable copy must reach Test Explorer as
    // a failure with its actual source location. Restore and rerun afterward.
    const assertion = '(check-equal? (read-message in) message)';
    const offset = original.indexOf(assertion);
    assert.ok(offset >= 0);
    const failurePosition = document.positionAt(offset);
    async function replace(text) {
      // Debugger navigation can close and reopen an editor. Resolve the live
      // document by URI before each edit instead of retaining a closed model.
      const current = await vscode.workspace.openTextDocument(testUri);
      await vscode.window.showTextDocument(current, { preview: false });
      const edit = new vscode.WorkspaceEdit();
      edit.replace(testUri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), text);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      const changed = await vscode.workspace.openTextDocument(testUri);
      assert.equal(await changed.save(), true);
      await vscode.window.showTextDocument(changed, { preview: false });
    }
    try {
      await replace(original.replace(assertion, '(check-equal? (read-message in) \'intentional-dogfood-failure)'));
      const start = sessions.length;
      assert.deepEqual(await vscode.commands.executeCommand('racketdap.testFile'),
        { passed: 0, failed: 1, errored: 0, skipped: 0 });
      const failure = await event(sessions[start], 'racketdap/test', m => m.body.kind === 'failure');
      assert.deepEqual(failure.body.location, { path: document.uri.fsPath, line: failurePosition.line + 1, column: failurePosition.character + 1 });
    } finally { await replace(original); }
    assert.deepEqual(await vscode.commands.executeCommand('racketdap.testFile'),
      { passed: 1, failed: 0, errored: 0, skipped: 0 });

    // Follow the documented REPL example through four real modules.
    const example = path.join(workspace.uri.fsPath, 'examples/multi-file');
    const main = await vscode.workspace.openTextDocument(path.join(example, 'main.rkt'));
    const leaf = await vscode.workspace.openTextDocument(path.join(example, 'domain/tax/rates.rkt'));
    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(leaf.uri,
      leaf.positionAt(leaf.getText().indexOf('(* taxable rate)'))));
    vscode.debug.addBreakpoints([breakpoint]);
    await vscode.window.showTextDocument(main);
    const repl = await vscode.commands.executeCommand('racketdap.startDebugRepl');
    assert.ok(await repl.ready);
    console.log('Debug REPL: four files through nested folders');
    for (const [expression, taxable, result] of [
      ['(quote-order)', '180', '198\n18\n180'],
      ['(quote-order 3)', '270', '297\n27\n270']
    ]) {
      const start = messages.length;
      const evaluated = repl.session.customRequest('evaluate', { context: 'repl', expression });
      const stop = await until(() => messages.slice(start).find(m => m.session.id === repl.session.id && m.event === 'stopped'),
        'breakpoint in nested module');
      const { stackFrames } = await repl.session.customRequest('stackTrace', { threadId: stop.body.threadId });
      assert.deepEqual(stackFrames.slice(0, 4).map(frame => path.relative(example, frame.source.path).split(path.sep).join('/')),
        ['domain/tax/rates.rkt', 'domain/pricing.rkt', 'app/orders.rkt', 'main.rkt']);
      assert.equal((await repl.session.customRequest('evaluate', {
        context: 'watch', frameId: stackFrames[0].id, expression: 'taxable'
      })).result, taxable);
      await repl.session.customRequest('continue', { threadId: stop.body.threadId });
      assert.equal((await evaluated).result, result);
    }
    await removeBreakpoint(repl.session);
    await repl.stop(); await repl.done;

    fs.writeFileSync(process.env.RACKETDAP_TEST_REPORT, JSON.stringify({
      passed: true, extension: extension.id, version: extension.packageJSON.version, vscode: vscode.version,
      suites: checks, total: checks.reduce((sum, suite) => sum + suite.total, 0),
      checks: ['Test Explorer Run All, Debug All and Coverage execute only repository suites', 'real test breakpoint and live local',
        'failed assertion and source location', 'restored suite passes again',
        'Debug REPL stops through four nested files and stays available for another expression']
    }, null, 2));
  } finally {
    await vscode.commands.executeCommand('testing.cancelRun');
    await Promise.all([...active].map(session => vscode.debug.stopDebugging(session)));
    if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
    tracker.dispose(); onEnded.dispose();
  }
};
