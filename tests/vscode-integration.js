// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const { semanticTokens } = require('./vscode-highlighting');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('lamestllama.racketeer');
  assert.ok(extension, 'Packaged extension is available');
  await extension.activate();
  const workspace = vscode.workspace.workspaceFolders[0];
  // The console log records each stage's duration, so a run that exceeds its
  // time limit shows where the time went.
  async function stage(name, run) {
    const started = Date.now();
    console.log(`Integration stage ${name} started`);
    const checks = await run();
    console.log(`Integration stage ${name} passed in ${Math.round((Date.now() - started) / 1000)} s`);
    return checks;
  }
  const testExplorerChecks = await stage('Test Explorer', () => require('./vscode-test-explorer').run(extension, workspace));
  const languageChecks = await stage('language', () => require('./vscode-language').run(extension, workspace));
  const macroChecks = await stage('macro stepper', () => require('./vscode-macro-stepper').run(extension, workspace));
  const rhombusChecks = process.env.RACKETDAP_TEST_RHOMBUS === '1'
    ? await stage('Rhombus', () => require('./vscode-rhombus').run(extension, workspace)) : [];
  const workflowChecks = await stage('workflows', () => require('./vscode-workflows').run(workspace));
  const packageChecks = await stage('packages', () => require('./vscode-packages').run(workspace));
  const applicationChecks = await stage('application builds', () => require('./vscode-application-builds').run(workspace));
  const applicationLogChecks = await stage('application logs', () => require('./vscode-application-logs').run(workspace));
  const imageChecks = await stage('images', () => require('./vscode-images').run(workspace));
  const plotChecks = await stage('plots', () => require('./vscode-plots').run(workspace));
  const wxmeChecks = await stage('WXME', () => require('./vscode-wxme').run(extension, workspace));
  const variableChecks = await stage('variables', () => require('./vscode-variables').run(workspace));
  const hoverChecks = await stage('hover', () => require('./vscode-hover').run(workspace));
  const debuggingStarted = Date.now();
  console.log('Integration stage debugging started');
  // The WXME stage leaves a captured source of its ended session open. Close it,
  // so this stage can show that a stop in an unchanged file opens none.
  const capturedTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input?.uri?.scheme === 'debug');
  await vscode.window.tabGroups.close(capturedTabs());
  const program = path.join(workspace.uri.fsPath, 'demo.rkt');
  const document = await vscode.workspace.openTextDocument(program);
  await vscode.window.showTextDocument(document, { preview: false });
  assert.equal(document.languageId, 'racket');
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(document.uri, new vscode.Position(3, 0)), true, '(= subtotal 100)', '1');
  vscode.debug.addBreakpoints([breakpoint]);
  const messages = [];
  const sessions = new Map();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.set(session.id, session);
      return {
        onWillReceiveMessage(message) { messages.push({ ...message, sessionId: session.id }); },
        onDidSendMessage(message) { messages.push({ ...message, sessionId: session.id }); }
      };
    }
  });
  function event(name, predicate = () => true) {
    const names = Array.isArray(name) ? name : [name];
    return until(() => {
      const index = messages.findIndex(m => m.type === 'event' && names.includes(m.event) && predicate(m));
      return index >= 0 && messages.splice(index, 1)[0];
    }, `${name} event`, () => JSON.stringify(messages));
  }
  let referenceLocations;
  const waitUntil = (predicate, description) => until(predicate, description, () => {
    const editor = vscode.window.activeTextEditor;
    const item = vscode.debug.activeStackItem;
    return JSON.stringify({
          editor: editor?.document.uri.toString(), selection: editor?.selection,
          visible: vscode.window.visibleTextEditors.map(visible => visible.document.uri.toString()),
          sourceDocument: { closed: document.isClosed, version: document.version },
          workspaceAnalysis: vscode.workspace.getConfiguration('racket-langserver', workspace.uri).get('workspaceAnalysis'),
          stackItem: item && { sessionId: item.session.id, threadId: item.threadId, frameId: item.frameId },
          breakpoints: vscode.debug.breakpoints, references: referenceLocations, messages: messages.slice(-20)
        });
  });
  async function selectedFrame(session, stop) {
    await waitUntil(() => {
      const item = vscode.debug.activeStackItem;
      return item?.session.id === session.id && messages.some(message =>
        message.sessionId === session.id && message.type === 'response' &&
        message.command === 'stackTrace' && message.seq > stop.seq &&
        message.body?.stackFrames?.some(frame => frame.id === item.frameId));
    }, 'editor selects a frame from the current stop');
  }
  try {
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Packaged Racket smoke test',
      program, stopOnEntry: false, interactive: true
    }), true);
    let stopped = await event('stopped');
    assert.equal(stopped.body.reason, 'breakpoint');
    const session = vscode.debug.activeDebugSession;
    assert.ok(session);
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: stopped.body.threadId });
    assert.equal(stackFrames[0].line, 4);
    const frameId = stackFrames[0].id;
    const stoppedUri = vscode.debug.asDebugSourceUri(stackFrames[0].source, session).toString();
    assert.equal(stoppedUri, document.uri.toString(), 'A stop in an unchanged file shows the file');
    // Whether its editor also takes focus depends on the window having focus,
    // which a macOS runner's window need not have; focus it before using it.
    const shown = await waitUntil(() => vscode.window.visibleTextEditors.find(editor =>
      editor.document.uri.toString() === stoppedUri), 'debugger opens the stopped file');
    const stoppedEditor = await vscode.window.showTextDocument(shown.document, { viewColumn: shown.viewColumn, preview: false });
    assert.equal(stoppedEditor.document.languageId, 'racket', 'The stopped file enables Racket breakpoint controls');
    const stoppedDocument = stoppedEditor.document;
    const highlightedValues = async () => (await semanticTokens(stoppedDocument))
      .some(token => token.text === 'values' && token.type === 'function');
    await until(async () => await highlightedValues(), 'The stopped file receives semantic function highlighting');
    const valuesPosition = new vscode.Position(4, 4);
    const snapshotHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', stoppedDocument.uri, valuesPosition);
    assert.ok(snapshotHover.some(item => item.contents.some(content => /values/.test(content.value || content))),
      'The stopped file receives language-server documentation');
    const callPosition = new vscode.Position(7, 31);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', stoppedDocument.uri, callPosition);
    assert.ok(definitions.some(item => (item.targetUri || item.uri).fsPath === program &&
      (item.targetSelectionRange || item.range).start.line === 2), 'The stopped file navigates to the function definition');
    await waitUntil(async () => {
      const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', stoppedDocument.uri, callPosition);
      referenceLocations = references;
      return references.some(item => item.uri.fsPath === program && item.range.start.line === 7);
    }, 'the stopped file finds function references');
    // A saved edit leaves the running text behind. The stop then names that text by
    // reference, and it has no language results, which belong to the file's new text.
    const originalText = document.getText();
    const originalEnd = document.positionAt(originalText.length);
    const changedSource = new vscode.WorkspaceEdit();
    changedSource.insert(document.uri, originalEnd, '; saved while debugging\n');
    assert.equal(await vscode.workspace.applyEdit(changedSource), true);
    await document.save();
    const staleFrame = (await session.customRequest('stackTrace', { threadId: stopped.body.threadId })).stackFrames[0];
    assert.ok(staleFrame.source.sourceReference > 0, 'A saved edit makes the stop name its running text by reference');
    const capturedDocument = await vscode.workspace.openTextDocument(vscode.debug.asDebugSourceUri(staleFrame.source, session));
    assert.equal(capturedDocument.getText(), originalText);
    // Its gutter works on the running text, and a breakpoint there ends with the session.
    const capturedEditor = await vscode.window.showTextDocument(capturedDocument, { preview: false, selection: new vscode.Range(3, 0, 3, 0) });
    assert.equal(capturedEditor.document.languageId, 'racket', 'A captured source enables Racket breakpoint controls');
    const inCaptured = () => vscode.debug.breakpoints.filter(bp => bp.location?.uri.scheme === 'debug');
    const answersBefore = messages.length;
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    await waitUntil(() => inCaptured().length === 1, 'F9 adds breakpoint in a captured source');
    await waitUntil(() => messages.slice(answersBefore).some(m => m.type === 'response' && m.command === 'setBreakpoints' &&
      m.success && m.body.breakpoints.some(bp => bp.verified && bp.line === 4)), 'adapter verifies a captured source breakpoint');
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    await waitUntil(() => inCaptured().length === 0, 'F9 removes breakpoint in a captured source');
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(capturedDocument.uri, new vscode.Position(4, 0)), true, '#f')]);
    await waitUntil(() => inCaptured().length === 1, 'a captured source breakpoint is listed');
    const restore = new vscode.WorkspaceEdit();
    restore.delete(document.uri, new vscode.Range(originalEnd, document.positionAt(document.getText().length)));
    assert.equal(await vscode.workspace.applyEdit(restore), true);
    assert.equal(document.getText(), originalText);
    await document.save();
    const atReturn = bp => bp instanceof vscode.SourceBreakpoint &&
      bp.location.uri.toString() === stoppedUri && bp.location.range.start.line === 4;
    const answersBeforeF9 = messages.length;
    await vscode.window.showTextDocument(stoppedDocument, { selection: new vscode.Range(4, 0, 4, 0) });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    await waitUntil(() => vscode.debug.breakpoints.some(atReturn), 'F9 adds breakpoint in the stopped file');
    await waitUntil(() => messages.slice(answersBeforeF9).some(m => m.type === 'response' && m.command === 'setBreakpoints' &&
      m.success && m.body.breakpoints.some(bp => bp.verified && bp.line === 5)),
      'adapter verifies the breakpoint added by F9');
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    await waitUntil(() => !vscode.debug.breakpoints.some(atReturn), 'F9 removes breakpoint in the stopped file');
    assert.equal((await session.customRequest('evaluate', { frameId, context: 'repl', expression: '(+ subtotal 20)' })).result, '120');
    const blocked = session.customRequest('evaluate', {
      frameId, context: 'repl', expression: '(begin (displayln "waiting") (flush-output) (sync never-evt))'
    }).then(() => assert.fail('Blocked evaluation should be cancelled'), error => assert.match(error.message, /cancelled/));
    await event('output', m => m.body.output.includes('waiting'));
    await vscode.commands.executeCommand('racketdap.cancelEvaluation');
    await blocked;
    await session.customRequest('evaluate', { frameId, context: 'repl', expression: '(set! subtotal 200)' });
    await session.customRequest('next', { threadId: stopped.body.threadId });
    stopped = await event('stopped');
    assert.equal(stopped.body.description, 'Expression returned');
    const after = await session.customRequest('stackTrace', { threadId: stopped.body.threadId });
    assert.match(after.stackFrames[0].name, /^Returned 1 value at /);
    assert.equal(after.stackFrames[0].column, '  (define tax (* subtotal rate'.length + 1);
    assert.equal(after.stackFrames[0].endColumn, after.stackFrames[0].column + 1);
    // By its document: while the window has no focus, the active editor can be another group's.
    await waitUntil(() => {
      const editor = vscode.window.visibleTextEditors.find(visible => visible.document.uri.toString() === stoppedUri);
      return editor && editor.selection.start.line === 3 &&
        editor.selection.start.character === after.stackFrames[0].column - 1;
    }, 'editor selects the closing parenthesis after evaluation');
    const { scopes } = await session.customRequest('scopes', { frameId: after.stackFrames[0].id });
    const resultScope = scopes.find(s => s.name === 'Return values (1)');
    assert.ok(resultScope);
    const { variables } = await session.customRequest('variables', { variablesReference: resultScope.variablesReference });
    assert.equal(variables[0].value, '20');
    await session.customRequest('continue', { threadId: stopped.body.threadId });
    await event('racketdap/ready');
    // Control events and stdout travel over separate streams.
    await waitUntil(() => messages.filter(m => m.event === 'output' && m.body.category === 'stdout')
      .map(m => m.body.output).join('') === '220\n20\n', 'program output before console interactions');
    const output = messages.filter(m => m.event === 'output' && m.body.category === 'stdout').map(m => m.body.output).join('');
    assert.equal(output, '220\n20\n');
    await session.customRequest('setBreakpoints', {
      source: { path: program }, breakpoints: [{ line: 4, condition: '(= subtotal 10)', logMessage: 'subtotal={subtotal}' }]
    });
    assert.equal((await session.customRequest('evaluate', { context: 'repl', expression: '(price 10 1/10)' })).result, '11\n1');
    await event('output', m => m.body.output === 'subtotal=10\n');
    await session.customRequest('setBreakpoints', { source: { path: program }, breakpoints: [] });
    await session.customRequest('setExceptionBreakpoints', { filters: ['uncaught'] });
    const failed = session.customRequest('evaluate', { context: 'repl', expression: '(price "bad" 1/10)' })
      .then(() => assert.fail('Bad price should raise'), error => assert.match(error.message, /contract violation/));
    stopped = await event('stopped');
    assert.equal(stopped.body.reason, 'exception');
    assert.equal((await session.customRequest('exceptionInfo', { threadId: stopped.body.threadId })).breakMode, 'unhandled');
    await session.customRequest('continue', { threadId: stopped.body.threadId });
    await failed;
    assert.equal((await session.customRequest('evaluate', { context: 'repl', expression: '(+ 40 2)' })).result, '42');
    await vscode.debug.stopDebugging(session);
    await event('terminated');
    await waitUntil(() => inCaptured().length === 0, 'A captured source keeps no breakpoint after its session');
    await vscode.window.tabGroups.close(capturedTabs());
    vscode.debug.removeBreakpoints([breakpoint]);
    messages.length = 0;
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Packaged Racket terminal test', stopOnEntry: false,
      program: path.join(workspace.uri.fsPath, 'input.rkt'), console: 'integratedTerminal'
    }), true);
    await event('racketdap/terminalOutput', m => m.body.output.includes('Name:'));
    const terminal = vscode.window.terminals.find(t => t.name === 'Racket: Packaged Racket terminal test');
    assert.ok(terminal, 'The extension creates the input terminal');
    terminal.sendText('λ😀');
    await event('racketdap/terminalOutput', m => m.body.output.includes('Hello, λ😀!'));
    await event('terminated');
    terminal.dispose();
    messages.length = 0;
    const multiProgram = path.join(workspace.uri.fsPath, 'multi-file/main.rkt');
    const unopenedConsumer = path.join(workspace.uri.fsPath, 'multi-file/index-consumer.rkt');
    fs.writeFileSync(unopenedConsumer, '#lang racket/base\n(require "app/orders.rkt")\n(order-total 10 2 1/10)\n');
    const multiDocument = await vscode.workspace.openTextDocument(multiProgram);
    await vscode.window.showTextDocument(multiDocument);
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Navigation at a stop',
      program: multiProgram, stopOnEntry: true
    }), true);
    const multiStop = await event('stopped');
    const multiSession = vscode.debug.activeDebugSession;
    const multiFrames = (await multiSession.customRequest('stackTrace', { threadId: multiStop.body.threadId })).stackFrames;
    assert.equal(multiStop.body.reason, 'entry');
    assert.equal(multiFrames[0].line, 10, 'Entry starts at the call inside main');
    const multiUri = vscode.debug.asDebugSourceUri(multiFrames[0].source, multiSession);
    const multiStopped = await vscode.workspace.openTextDocument(multiUri);
    await vscode.window.showTextDocument(multiStopped, { preview: false });
    const orderCall = new vscode.Position(5, 35);
    const ordersPath = path.join(workspace.uri.fsPath, 'multi-file/app/orders.rkt');
    await waitUntil(async () => {
      const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', multiUri, orderCall);
      return locations.some(item => (item.targetUri || item.uri).fsPath === ordersPath &&
        (item.targetSelectionRange || item.range).start.line === 4);
    }, 'the stopped file navigates to an imported function');
    await waitUntil(async () => {
      const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', multiUri, orderCall);
      referenceLocations = references;
      return references.some(item => item.uri.fsPath === multiProgram && item.range.start.line === 5) &&
        references.some(item => item.uri.fsPath === ordersPath && item.range.start.line === 4) &&
        references.some(item => item.uri.fsPath === unopenedConsumer && item.range.start.line === 2);
    }, 'the stopped file finds references in unopened files');
    assert.ok(!vscode.workspace.textDocuments.some(item => item.uri.fsPath === unopenedConsumer));
    let stepStop = multiStop;
    for (const [command, file, line, kind] of [
      ['stepInto', multiProgram, 6, 'before'],
      ['stepInto', ordersPath, 6, 'before'],
      ['stepOver', ordersPath, 6, 'after'],
      ['stepOver', ordersPath, 7, 'before'],
      ['stepOver', ordersPath, 7, 'after'],
      ['stepOver', ordersPath, 8, 'before'],
      ['stepOut', multiProgram, 6, 'after']
    ]) {
      await selectedFrame(multiSession, stepStop);
      await vscode.commands.executeCommand(`workbench.action.debug.${command}`);
      stepStop = await event('stopped', message => message.sessionId === multiSession.id);
      const { stackFrames } = await multiSession.customRequest('stackTrace', { threadId: stepStop.body.threadId });
      assert.equal(stackFrames[0].source.path, file, `${command} selects the expected file`);
      assert.equal(stackFrames[0].line, line, `${command} selects the expected expression`);
      assert.equal(stackFrames[0].endLine, line, 'A body stop does not highlight the enclosing function');
      assert.equal(stepStop.body.racketdapStopKind, kind);
    }
    await vscode.debug.stopDebugging(multiSession);
    await event('terminated');
    await waitUntil(() => vscode.debug.activeDebugSession?.id !== multiSession.id, 'navigation session ends');
    assert.deepEqual(capturedTabs().map(tab => tab.label), [], 'Stops in unchanged files open no captured copies');
    messages.length = 0;
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Debug initialization',
      program: multiProgram, stopOnEntry: true, stopOnEntryMode: 'firstExpression'
    }), true);
    const initializationStop = await event('stopped');
    const initializationSession = vscode.debug.activeDebugSession;
    await selectedFrame(initializationSession, initializationStop);
    const initializationFrames = (await initializationSession.customRequest('stackTrace', {
      threadId: initializationStop.body.threadId
    })).stackFrames;
    assert.equal(initializationStop.body.reason, 'entry');
    assert.equal(initializationFrames[0].source.path, multiProgram);
    assert.equal(initializationFrames[0].line, 5, 'Initialization mode starts at function setup');
    await vscode.debug.stopDebugging(initializationSession);
    await event('terminated');
    await waitUntil(() => vscode.debug.activeDebugSession?.id !== initializationSession.id, 'initialization session ends');
    messages.length = 0;
    const parityProgram = path.join(workspace.uri.fsPath, 'debugger-actions.rkt');
    fs.writeFileSync(parityProgram, '#lang racket/base\n(define hidden 3)\n(define x (+ hidden 1))\n(displayln x)\n');
    const parityDocument = await vscode.workspace.openTextDocument(parityProgram);
    const parityEditor = await vscode.window.showTextDocument(parityDocument);
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Packaged debugger actions',
      program: parityProgram, stopOnEntry: true
    }), true);
    stopped = await event('stopped');
    const paritySession = vscode.debug.activeDebugSession;
    assert.equal(stopped.body.racketdapStopKind, 'before');
    assert.ok(stopped.body.racketdapActions.includes('racketdap/skipExpression'));
    assert.ok(!stopped.body.racketdapActions.includes('racketdap/replaceResults'));
    await selectedFrame(paritySession, stopped);
    assert.equal((await vscode.commands.executeCommand('racketdap.skipExpression', '(+ hidden 7)')).result, '10');
    await paritySession.customRequest('next', { threadId: stopped.body.threadId });
    stopped = await event('stopped');
    assert.equal(stopped.body.racketdapStopKind, 'after');
    assert.ok(stopped.body.racketdapActions.includes('racketdap/replaceResults'));
    assert.ok(!stopped.body.racketdapActions.includes('racketdap/skipExpression'));
    await selectedFrame(paritySession, stopped);
    assert.equal((await vscode.commands.executeCommand('racketdap.replaceResults', '20')).result, '20');
    await vscode.commands.executeCommand('racketdap.printResults');
    await event('output', m => m.body.category === 'console' && m.body.output === '20\n');
    // Wait for VS Code to focus the new stop before actions use its selected frame.
    await selectedFrame(paritySession, stopped);
    assert.equal((await vscode.commands.executeCommand('racketdap.printBinding', 'hidden')).result, '3');
    assert.equal((await vscode.commands.executeCommand('racketdap.setBinding', 'hidden', '9')).result, '9');
    const cursorEditor = await vscode.window.showTextDocument(parityDocument);
    cursorEditor.selection = new vscode.Selection(3, 0, 3, 0);
    await vscode.commands.executeCommand('racketdap.continueToCursor');
    stopped = await event('stopped');
    assert.equal(stopped.body.reason, 'goto');
    // Exercise the ordinary editor Step Over command all the way to termination.
    // No interactive launch flag is supplied: completing the file ends debugging.
    for (let steps = 0; ; steps++) {
      assert.ok(steps < 10, 'Stepping must finish the small program');
      await selectedFrame(paritySession, stopped);
      await vscode.commands.executeCommand('workbench.action.debug.stepOver');
      const next = await event(['stopped', 'terminated']);
      if (next.event === 'terminated') break;
      stopped = next;
    }
    await waitUntil(() => vscode.debug.activeDebugSession?.id !== paritySession.id, 'VS Code leaves debug mode');
    assert.ok(!messages.some(m => m.event === 'racketdap/ready'), 'Normal launch does not stay in the interaction loop');
    await waitUntil(() => messages.filter(m => m.event === 'output' && m.body.category === 'stdout')
      .map(m => m.body.output).join('') === '20\n', 'substituted result output');
    // Captured coordinates belong to the session that captured them, even
    // when two sessions use the same path with different saved contents.
    const ownershipProgram = path.join(workspace.uri.fsPath, 'source-ownership.rkt');
    const ownershipSessions = [];
    try {
      let firstThread;
      for (const [index, source] of [
        '#lang racket/base\n(define value (+ 1 2))\n(displayln value)\n',
        '#lang racket/base\n; a different captured version\n(define value (+ 4 5))\n(displayln value)\n'
      ].entries()) {
        fs.writeFileSync(ownershipProgram, source);
        const name = `Captured owner ${index}`;
        assert.equal(await vscode.debug.startDebugging(workspace, {
          type: 'racketdap', request: 'launch', name,
          program: ownershipProgram, stopOnEntry: true, interactive: true
        }), true);
        const owner = [...sessions.values()].find(session => session.configuration.name === name);
        assert.ok(owner, 'Tracker identifies the new session independently of editor focus');
        ownershipSessions.push(owner);
        const ownerStop = await event('stopped', message => message.sessionId === owner.id);
        const ownerFrames = await owner.customRequest('stackTrace', { threadId: ownerStop.body.threadId });
        // VS Code can keep the previous paused session selected. Choose the
        // owner using ordinary console/session cycling. Continue to Cursor
        // uses the session's paused thread and does not require a selected frame.
        for (let attempts = 0; vscode.debug.activeDebugSession?.id !== owner.id; attempts++) {
          assert.ok(attempts <= sessions.size, 'Session cycling must reach the captured source owner');
          const previous = vscode.debug.activeDebugSession?.id;
          await vscode.commands.executeCommand('workbench.action.debug.nextConsole');
          await waitUntil(() => vscode.debug.activeDebugSession?.id !== previous, 'debug console selects the next session');
        }
        if (index === 0) firstThread = ownerStop.body.threadId;
        else {
          // The second save left the first session's running text behind.
          const firstFrames = await ownershipSessions[0].customRequest('stackTrace', { threadId: firstThread });
          const firstCaptured = vscode.debug.asDebugSourceUri(firstFrames.stackFrames[0].source, ownershipSessions[0]);
          const foreignEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(firstCaptured));
          foreignEditor.selection = new vscode.Selection(2, 0, 2, 0);
          assert.equal(vscode.debug.activeDebugSession.id, owner.id);
          await assert.rejects(vscode.commands.executeCommand('racketdap.continueToCursor'), /current Racket debug session/);
          assert.ok((await owner.customRequest('stackTrace', { threadId: ownerStop.body.threadId })).stackFrames.length,
            'Rejecting foreign source coordinates leaves the current session paused');
        }
      }
    } finally {
      for (const owner of ownershipSessions) await vscode.debug.stopDebugging(owner);
    }
    const report = { passed: true, extension: extension.id, version: extension.packageJSON.version,
      vscode: vscode.version, checks: [...languageChecks, ...macroChecks, ...rhombusChecks, ...workflowChecks, ...testExplorerChecks, ...packageChecks, ...applicationChecks, ...applicationLogChecks, ...imageChecks, ...plotChecks, ...wxmeChecks, ...variableChecks, ...hoverChecks, 'activation', 'language registration', 'gutter breakpoint', 'stack',
        'stopped file language', 'F9 adds verified breakpoint in the stopped file', 'F9 removes breakpoint',
        'stopped file semantic highlighting', 'stopped file language hover', 'captured source breakpoints end with the session', 'completed session excludes source navigation',
        'stopped file definitions and references across unopened files', 'stops in unchanged files open no captured copies',
        'editor Step Into reaches the callee initializer', 'editor Step Over advances through internal definitions',
        'editor Step Out returns to the caller',
        'return marker and value count distinguish expression completion',
        'editor Step Over to completion exits debugging',
        'live evaluation', 'mutation', 'step over', 'Return values scope', 'continue', 'output', 'termination',
        'conditional and hit-count breakpoint', 'logpoint', 'exception stop', 'exceptionInfo',
        'cancel command', 'persistent console', 'terminal input and Unicode output',
        'adapter-provided action availability', 'skip expression command', 'replace results command', 'print results command',
        'startup mode selects main or initialization',
        'print variable command', 'set variable command', 'continue to cursor command',
        'continue to cursor rejects another session’s captured source'] };
    if (process.env.RACKETDAP_TEST_REPORT) fs.writeFileSync(process.env.RACKETDAP_TEST_REPORT, JSON.stringify(report, null, 2));
    console.log(`Integration stage debugging passed in ${Math.round((Date.now() - debuggingStarted) / 1000)} s`);
    console.log('Packaged VS Code integration passed:', JSON.stringify(report));
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    await vscode.debug.stopDebugging();
    tracker.dispose();
  }
};
