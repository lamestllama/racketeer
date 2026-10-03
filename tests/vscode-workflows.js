'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function (workspace) {
  const directory = path.join(workspace.uri.fsPath, 'workflows');
  fs.mkdirSync(directory, { recursive: true });
  const messages = [], sessions = [], owned = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.push(session);
      return { onDidSendMessage(message) { messages.push({ session, ...message }); } };
    }
  });
  async function until(check, description) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${description}. ${JSON.stringify(messages.slice(-10))}`);
  }
  async function event(session, name, predicate = () => true) {
    return until(() => {
      const index = messages.findIndex(m => (!session || m.session.id === session.id) && m.event === name && predicate(m));
      if (index >= 0) return messages.splice(index, 1)[0];
    }, name);
  }
  async function open(name, text) {
    const file = path.join(directory, name);
    if (text !== undefined) fs.writeFileSync(file, text);
    const document = await vscode.workspace.openTextDocument(file);
    return vscode.window.showTextDocument(document);
  }
  const settings = vscode.workspace.getConfiguration('racketdap');
  const previousInclude = settings.inspect('testing.include').workspaceValue;
  try {
    const passing = await open('pass.rkt', '#lang racket/base\n(module+ test (require rackunit) (check-equal? 2 2))\n');
    const failing = await open('fail.rkt', '#lang racket/base\n(module+ test (require rackunit)\n  (check-equal? 1 2 "intentional failure"))\n');
    await settings.update('testing.include', 'workflows/{pass,fail}.rkt', vscode.ConfigurationTarget.Workspace);
    // Drive the actual Testing view's commands, including discovery and both
    // run profiles. Only these two fixtures are in its configured inventory.
    await vscode.commands.executeCommand('testing.refreshTests');
    const before = sessions.length;
    await vscode.commands.executeCommand('testing.runAll');
    await until(() => sessions.length === before + 2, 'Test Explorer starts both modules');
    for (const session of sessions.slice(before)) {
      assert.equal(session.configuration.noDebug, true);
      const summary = await event(session, 'racketdap/test', m => m.body.kind === 'summary');
      assert.equal(summary.body.status, session.configuration.program.endsWith('pass.rkt') ? 'passed' : 'failed');
      await event(session, 'terminated');
    }
    const failure = messages.find(m => m.event === 'racketdap/test' && m.body.kind === 'failure');
    assert.equal(failure.body.location.path, failing.document.uri.fsPath);
    assert.equal(failure.body.location.line, 3);
    await vscode.window.showTextDocument(failing.document);
    assert.deepEqual(await vscode.commands.executeCommand('racketdap.testFile'),
      { passed: 0, failed: 1, errored: 0, skipped: 0 });
    await open('early-exit.rkt', '#lang racket/base\n(module+ test (exit 0))\n');
    assert.deepEqual(await vscode.commands.executeCommand('racketdap.testFile'),
      { passed: 0, failed: 0, errored: 1, skipped: 0 }, 'An early exit must not silently pass');

    const teaching = await open('teaching.rkt', '#lang htdp/bsl\n' +
      '(define (price count) (+ 7 count))\n(check-expect (price 2) 9)\n(check-expect (price 4) 10)\n');
    const teachingStart = sessions.length;
    assert.deepEqual(await vscode.commands.executeCommand('racketdap.testFile'),
      { passed: 0, failed: 1, errored: 0, skipped: 0 });
    const teachingSession = sessions[teachingStart];
    assert.deepEqual((await event(teachingSession, 'racketdap/test', m => m.body.kind === 'summary')).body,
      { kind: 'summary', status: 'failed', total: 2, failed: 1 });
    const teachingFailure = (await event(teachingSession, 'racketdap/test', m => m.body.kind === 'failure')).body;
    assert.deepEqual(teachingFailure.location, { path: teaching.document.uri.fsPath, line: 4, column: 1 });

    const literals = await open('literals.rkt', '#lang racket/base\n(require rackunit)\n' +
      '(define (choose flag) (if flag \'left \'right))\n(check-equal? (choose #t) \'left)\n');
    await settings.update('testing.include', 'workflows/literals.rkt', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('testing.refreshTests');
    const coverageStart = sessions.length;
    await vscode.commands.executeCommand('testing.coverageAll');
    const literalReport = await event(sessions[coverageStart], 'racketdap/coverage',
      m => m.body.path === literals.document.uri.fsPath);
    const branchColumn = literals.document.lineAt(2).text.indexOf("'right");
    assert.ok(literalReport.body.statements.some(s => s.line === 2 && s.column === branchColumn &&
      s.endLine === 2 && s.endColumn === branchColumn + 6 && s.executed === false));

    for (const suite of [false, true]) {
      const selected = expected => suite
        ? `(run-tests (test-suite "same" (test-case "inner" (check-equal? (twice 7) ${expected}))))`
        : `(test-case "same" (check-equal? (twice 7) ${expected}))`;
      let individual = await open(suite ? 'suites.rkt' : 'cases.rkt', '#lang racket/base\n(require rackunit rackunit/text-ui)\n' +
        '(define (twice x)\n  (* x 2))\n(module+ test\n' +
        '  (test-case "same" (error "unselected test ran"))\n' +
        '  ' + selected(14) + ')\n');
      await settings.update('testing.include', 'workflows/{pass,fail,cases,suites}.rkt', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('testing.refreshTests');
      for (const command of ['testing.runAtCursor', 'testing.debugAtCursor', 'testing.coverageAtCursor']) {
        individual = await vscode.window.showTextDocument(individual.document);
        individual.selection = new vscode.Selection(6, 5, 6, 5);
        const start = sessions.length;
        const testBreakpoint = new vscode.SourceBreakpoint(new vscode.Location(individual.document.uri, new vscode.Position(3, 0)));
        if (command === 'testing.debugAtCursor') vscode.debug.addBreakpoints([testBreakpoint]);
        try {
          const invoked = vscode.commands.executeCommand(command);
          invoked.then(undefined, () => {});
          await until(() => sessions.length > start, `${command} starts the selected case`);
          const session = sessions[start];
          assert.deepEqual(session.configuration.testSelection.ids,
            [individual.document.getText().indexOf(selected(14)) + 1]);
          assert.equal(!!session.configuration.noDebug, command !== 'testing.debugAtCursor');
          assert.equal(!!session.configuration.coverage, command === 'testing.coverageAtCursor');
          if (command === 'testing.debugAtCursor') {
            const stopped = await event(session, 'stopped');
            const stack = await session.customRequest('stackTrace', { threadId: stopped.body.threadId });
            assert.equal(stack.stackFrames[0].line, 4);
            assert.equal((await session.customRequest('evaluate', { frameId: stack.stackFrames[0].id, expression: 'x' })).result, '7');
            vscode.debug.removeBreakpoints([testBreakpoint]);
            await session.customRequest('continue', { threadId: stopped.body.threadId });
          }
          const summary = await event(session, 'racketdap/test', message => message.body.kind === 'summary');
          assert.deepEqual(summary.body, { kind: 'summary', status: 'passed', failed: 0, total: 1 });
          await event(session, 'terminated');
          await invoked;
          if (command === 'testing.coverageAtCursor') {
            const coverage = await event(session, 'racketdap/coverage', message => message.body.path === individual.document.uri.fsPath);
            assert.ok(coverage.body.statements.some(statement => statement.line === 3 && statement.executed));
          }
        } finally { vscode.debug.removeBreakpoints([testBreakpoint]); }
      }
      individual = await vscode.window.showTextDocument(individual.document);
      await individual.edit(edit => edit.replace(individual.document.lineAt(6).range,
        '  ' + selected(15) + ')'));
      assert.equal(individual.document.isDirty, true);
      await vscode.commands.executeCommand('testing.refreshTests');
      individual.selection = new vscode.Selection(6, 5, 6, 5);
      const editedStart = sessions.length;
      await vscode.commands.executeCommand('testing.runAtCursor');
      await until(() => sessions.length > editedStart, 'run the edited case');
      const editedSession = sessions[editedStart];
      const editedSummary = await event(editedSession, 'racketdap/test', message => message.body.kind === 'summary');
      assert.deepEqual(editedSummary.body, { kind: 'summary', status: 'failed', failed: 1, total: 1 });
      assert.equal(individual.document.isDirty, false);
      if (!suite) {
        const caseFailure = await event(editedSession, 'racketdap/test', message => message.body.kind === 'failure');
        assert.equal(caseFailure.body.location.line, 7);
      }
      await event(editedSession, 'terminated');
      if (suite) {
        const output = messages.filter(m => m.session.id === editedSession.id && m.event === 'output')
          .map(m => m.body.output).join('');
        assert.match(output, /FAILURE/);
        assert.match(output, /suites[.]rkt:7:/);
      }
    }

    const helper = await open('helper.rkt', '#lang racket/base\n(provide twice)\n(define (twice x)\n  (* x 2))\n');
    const moduleText = '#lang racket/base\n(require "helper.rkt")\n(define private 6)\n(module+ main (error "main must not run"))\n(module+ test (require rackunit) (check-equal? (twice private) 12))\n; (twice private)\n(define (local-twice value)\n  (* value 2))\n; (local-twice private)\n; (define selected-value 40) ; a trailing comment\n; (+ selected-value 2)\n';
    const moduleEditor = await open('module.rkt', moduleText);
    const bp = new vscode.SourceBreakpoint(new vscode.Location(helper.document.uri, new vscode.Position(3, 0)));
    vscode.debug.addBreakpoints([bp]);
    try {
      const result = vscode.commands.executeCommand('racketdap.debugTestFile');
      const stopped = await event(undefined, 'stopped');
      const debugSession = stopped.session;
      assert.equal(debugSession.configuration.testMode, true);
      assert.ok(!debugSession.configuration.noDebug);
      const stack = await debugSession.customRequest('stackTrace', { threadId: stopped.body.threadId });
      assert.equal(stack.stackFrames[0].source.path, helper.document.uri.fsPath);
      assert.equal((await debugSession.customRequest('evaluate', { frameId: stack.stackFrames[0].id, expression: 'x' })).result, '6');
      await debugSession.customRequest('continue', { threadId: stopped.body.threadId });
      assert.deepEqual(await result, { passed: 1, failed: 0, errored: 0, skipped: 0 });

      await vscode.window.showTextDocument(moduleEditor.document);
      const first = await vscode.commands.executeCommand('racketdap.startDebugRepl');
      owned.push(first);
      assert.ok(await first.ready);
      assert.equal(first.session.configuration.interactive, true);
      assert.deepEqual(first.session.configuration.submodule, []);
      assert.equal(await vscode.commands.executeCommand('racketdap.startDebugRepl'), first, 'Reuse this module’s REPL');

      await open('other.rkt', '#lang racket/base\n' +
        '(module configure-runtime racket/base (print-as-expression #f))\n(define private 100)\n');
      const other = await vscode.commands.executeCommand('racketdap.startDebugRepl');
      owned.push(other);
      assert.ok(await other.ready);
      assert.equal((await other.session.customRequest('evaluate', { context: 'repl', expression: '(print-as-expression)' })).result, '#f');
      assert.equal((await first.session.customRequest('evaluate', { context: 'repl', expression: '(print-as-expression)' })).result, '#t');
      const editor = await vscode.window.showTextDocument(moduleEditor.document);
      editor.selection = new vscode.Selection(5, 2, 5, moduleEditor.document.lineAt(5).text.length);
      const evaluation = vscode.commands.executeCommand('racketdap.sendSelectionToDebugRepl');
      const stop = await event(first.session, 'stopped');
      const replStack = await first.session.customRequest('stackTrace', { threadId: stop.body.threadId });
      assert.equal(replStack.stackFrames[0].source.path, helper.document.uri.fsPath);
      assert.equal((await first.session.customRequest('evaluate', { frameId: replStack.stackFrames[0].id, expression: 'x' })).result, '6');
      await first.session.customRequest('continue', { threadId: stop.body.threadId });
      assert.equal((await evaluation).result, '12');
      await event(first.session, 'output', m => m.body.category === 'console' && m.body.output === '12\n');
      assert.equal((await other.session.customRequest('evaluate', { context: 'repl', expression: 'private' })).result, '100');

      const batchEditor = await vscode.window.showTextDocument(moduleEditor.document);
      batchEditor.selections = [new vscode.Selection(0, 0, 0, 0),
        new vscode.Selection(10, moduleEditor.document.lineAt(10).text.length, 10, 2),
        new vscode.Selection(9, 2, 9, moduleEditor.document.lineAt(9).text.length)];
      assert.equal((await vscode.commands.executeCommand('racketdap.sendSelectionToDebugRepl')).result, '42');
      await event(first.session, 'output', m => m.body.category === 'console' && m.body.output === '42\n');

      const localBreakpoint = new vscode.SourceBreakpoint(new vscode.Location(moduleEditor.document.uri, new vscode.Position(7, 0)));
      vscode.debug.addBreakpoints([localBreakpoint]);
      try {
        await until(() => messages.some(message => message.session.id === first.session.id &&
          message.type === 'response' && message.command === 'setBreakpoints' && message.success &&
          message.body.breakpoints.some(breakpoint => breakpoint.verified && breakpoint.line === 8)),
        'local inspection breakpoint is installed');
        const sourceEditor = await vscode.window.showTextDocument(moduleEditor.document);
        sourceEditor.selection = new vscode.Selection(8, 2, 8, moduleEditor.document.lineAt(8).text.length);
        const pendingCall = vscode.commands.executeCommand('racketdap.sendSelectionToDebugRepl');
        const localStop = await event(first.session, 'stopped');
        await until(() => {
          const selected = vscode.debug.activeStackItem;
          // A stopped event precedes the editor's stack refresh. Its previous
          // selection can still belong to this session but already be expired.
          return selected?.session.id === first.session.id && messages.some(message =>
            message.session.id === first.session.id && message.type === 'response' &&
            message.command === 'stackTrace' && message.success && message.seq > localStop.seq &&
            message.body.stackFrames.some(frame => frame.id === selected.frameId));
        }, 'a frame from the current stop is selected');
        const inspectionEditor = await vscode.window.showTextDocument(moduleEditor.document);
        inspectionEditor.selection = new vscode.Selection(7, 5, 7, 10);
        const inspected = await vscode.commands.executeCommand('racketdap.sendSelectionToDebugRepl');
        assert.ok(inspected, `Paused selection returned no response (session phase: ${first.phase}; ` +
          `selected session: ${vscode.debug.activeStackItem?.session.id}; ` +
          `selected frame: ${vscode.debug.activeStackItem?.frameId})`);
        assert.equal(inspected.result, '6',
          'Selection command evaluates a local while its outer selection call is paused');
        await first.session.customRequest('continue', { threadId: localStop.body.threadId });
        assert.equal((await pendingCall).result, '12');
      } finally { vscode.debug.removeBreakpoints([localBreakpoint]); }

      await vscode.window.showTextDocument(moduleEditor.document);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(moduleEditor.document.uri, new vscode.Range(2, 0, 2, moduleEditor.document.lineAt(2).text.length), '(define private 9)');
      await vscode.workspace.applyEdit(edit);
      const restarted = await vscode.commands.executeCommand('racketdap.restartDebugRepl');
      owned.push(restarted);
      assert.notEqual(restarted.session.id, first.session.id);
      assert.ok(await restarted.ready);
      assert.equal(first.ended, true);
      assert.equal((await restarted.session.customRequest('evaluate', { context: 'repl', expression: 'private' })).result, '9');
      assert.equal((await other.session.customRequest('evaluate', { context: 'repl', expression: 'private' })).result, '100');
    } finally { vscode.debug.removeBreakpoints([bp]); }

    await open('blocked.rkt', '#lang racket/base\n(module+ test (displayln "blocked test") (flush-output) (sync never-evt))\n');
    const blocked = vscode.commands.executeCommand('racketdap.testFile');
    await event(undefined, 'output', m => m.body.output.includes('blocked test'));
    await vscode.commands.executeCommand('testing.cancelRun');
    assert.deepEqual(await blocked, { passed: 0, failed: 0, errored: 0, skipped: 1 });
    const surviving = owned.at(-1);
    assert.equal((await surviving.session.customRequest('evaluate', { context: 'repl', expression: '(+ 1 2)' })).result, '3');

    return ['Test Explorer discovery and Run All', 'individual Run and Debug Test at Cursor', 'native Test Coverage at Cursor',
      'inline named suites use native Run, Debug and Coverage with RackUnit failure output',
      'teaching-language check counts and failure locations', 'coverage marks an untaken literal branch',
      'failed checks and source locations', 'early test exit is an error',
      'Debug Test command enters a required source file', 'module-specific Debug REPL reuse',
      'Debug REPL applies language runtime configuration separately for each session',
      'selection evaluation hits breakpoints in the owning REPL', 'Debug REPL restart loads saved edits',
      'evaluate multiple selections in the owning Debug REPL in source order',
      'selection command inspects a paused outer selection evaluation',
      'Test Explorer cancellation preserves other sessions'];
  } finally {
    await settings.update('testing.include', previousInclude, vscode.ConfigurationTarget.Workspace);
    for (const record of owned) if (!record.ended) { await record.stop(); await record.done; }
    tracker.dispose();
  }
};
