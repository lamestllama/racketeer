'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const { semanticTokens } = require('./vscode-highlighting');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('lamestllama.racketeer');
  assert.ok(extension, 'Packaged extension is available');
  await extension.activate();
  const workspace = vscode.workspace.workspaceFolders[0];
  const languageChecks = await require('./vscode-language').run(extension, workspace);
  const macroChecks = await require('./vscode-macro-stepper').run(extension, workspace);
  const rhombusChecks = process.env.RACKETDAP_TEST_RHOMBUS === '1'
    ? await require('./vscode-rhombus').run(extension, workspace) : [];
  const workflowChecks = await require('./vscode-workflows').run(workspace);
  const packageChecks = await require('./vscode-packages').run(workspace);
  const imageChecks = await require('./vscode-images').run(workspace);
  const program = path.join(workspace.uri.fsPath, 'demo.rkt');
  const document = await vscode.workspace.openTextDocument(program);
  await vscode.window.showTextDocument(document);
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
  async function event(name, predicate = () => true) {
    const names = Array.isArray(name) ? name : [name];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(m => m.type === 'event' && names.includes(m.event) && predicate(m));
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`No ${name} event. Messages: ${JSON.stringify(messages)}`);
  }
  async function waitUntil(predicate, description) {
    const deadline = Date.now() + 20000;
    while (!await predicate()) {
      if (Date.now() >= deadline) {
        const editor = vscode.window.activeTextEditor;
        const item = vscode.debug.activeStackItem;
        throw new Error(`Timed out: ${description}. ${JSON.stringify({
          editor: editor?.document.uri.toString(), selection: editor?.selection,
          stackItem: item && { sessionId: item.session.id, threadId: item.threadId, frameId: item.frameId },
          breakpoints: vscode.debug.breakpoints, messages: messages.slice(-20)
        })}`);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
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
    const capturedUri = vscode.debug.asDebugSourceUri(stackFrames[0].source, session).toString();
    await waitUntil(() => vscode.window.activeTextEditor?.document.uri.toString() === capturedUri,
      'debugger opens captured source');
    const capturedEditor = vscode.window.activeTextEditor;
    assert.equal(capturedEditor.document.languageId, 'racket', 'Captured source enables Racket breakpoint controls');
    const capturedDocument = capturedEditor.document;
    const highlightedValues = async () => (await semanticTokens(capturedDocument))
      .some(token => token.text === 'values' && token.type === 'function');
    const languageDeadline = Date.now() + 20000;
    while (!await highlightedValues()) {
      assert.ok(Date.now() < languageDeadline, 'Captured source receives semantic function highlighting');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const valuesPosition = new vscode.Position(4, 4);
    const snapshotHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', capturedDocument.uri, valuesPosition);
    assert.ok(snapshotHover.some(item => item.contents.some(content => /values/.test(content.value || content))),
      'Captured source receives language-server documentation');
    const callPosition = new vscode.Position(7, 31);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', capturedDocument.uri, callPosition);
    assert.ok(definitions.some(item => (item.targetUri || item.uri).fsPath === program &&
      (item.targetSelectionRange || item.range).start.line === 2), 'Captured source navigates to the function definition');
    await waitUntil(async () => {
      const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', capturedDocument.uri, callPosition);
      return references.some(item => item.uri.fsPath === program && item.range.start.line === 7);
    }, 'captured source finds function references');
    const originalText = document.getText();
    const changedSource = new vscode.WorkspaceEdit();
    changedSource.insert(document.uri, new vscode.Position(0, 0), '; unsaved change while debugging\n');
    assert.equal(await vscode.workspace.applyEdit(changedSource), true);
    assert.deepEqual(await semanticTokens(capturedDocument), [], 'Mismatched source cannot supply semantic tokens');
    assert.deepEqual(await vscode.commands.executeCommand('vscode.executeHoverProvider', capturedDocument.uri, valuesPosition), [],
      'Mismatched source cannot supply hover documentation');
    for (const command of ['vscode.executeDefinitionProvider', 'vscode.executeReferenceProvider']) {
      assert.deepEqual(await vscode.commands.executeCommand(command, capturedDocument.uri, callPosition), [],
        'Mismatched source cannot supply navigation locations');
    }
    const restore = new vscode.WorkspaceEdit();
    restore.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), originalText);
    assert.equal(await vscode.workspace.applyEdit(restore), true);
    await document.save();
    const atReturn = bp => bp instanceof vscode.SourceBreakpoint &&
      bp.location.uri.toString() === capturedUri && bp.location.range.start.line === 4;
    await vscode.window.showTextDocument(capturedDocument, { selection: new vscode.Range(4, 0, 4, 0) });
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    await waitUntil(() => vscode.debug.breakpoints.some(atReturn), 'F9 adds breakpoint in captured source');
    await waitUntil(() => messages.some(m => m.type === 'response' && m.command === 'setBreakpoints' &&
      m.success && m.body.breakpoints.some(bp => bp.verified && bp.line === 5)),
      'adapter verifies the breakpoint added by F9');
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    await waitUntil(() => !vscode.debug.breakpoints.some(atReturn), 'F9 removes breakpoint in captured source');
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
    await waitUntil(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.toString() === capturedUri && editor.selection.start.line === 3 &&
        editor.selection.start.character === after.stackFrames[0].column - 1;
    }, 'editor selects the closing parenthesis after evaluation');
    const { scopes } = await session.customRequest('scopes', { frameId: after.stackFrames[0].id });
    const resultScope = scopes.find(s => s.name.startsWith('Results'));
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
    vscode.debug.removeBreakpoints([breakpoint]);
    messages.length = 0;
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Packaged Racket terminal test',
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
      type: 'racketdap', request: 'launch', name: 'Captured source navigation',
      program: multiProgram, stopOnEntry: true
    }), true);
    const multiStop = await event('stopped');
    const multiSession = vscode.debug.activeDebugSession;
    const multiFrames = (await multiSession.customRequest('stackTrace', { threadId: multiStop.body.threadId })).stackFrames;
    const multiUri = vscode.debug.asDebugSourceUri(multiFrames[0].source, multiSession);
    await vscode.workspace.openTextDocument(multiUri);
    const orderCall = new vscode.Position(5, 35);
    const ordersPath = path.join(workspace.uri.fsPath, 'multi-file/app/orders.rkt');
    await waitUntil(async () => {
      const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', multiUri, orderCall);
      return locations.some(item => (item.targetUri || item.uri).fsPath === ordersPath &&
        (item.targetSelectionRange || item.range).start.line === 4);
    }, 'captured source navigates to an imported function');
    await waitUntil(async () => {
      const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', multiUri, orderCall);
      return references.some(item => item.uri.fsPath === multiProgram && item.range.start.line === 5) &&
        references.some(item => item.uri.fsPath === ordersPath && item.range.start.line === 4) &&
        references.some(item => item.uri.fsPath === unopenedConsumer && item.range.start.line === 2);
    }, 'captured source finds references in unopened files');
    assert.ok(!vscode.workspace.textDocuments.some(item => item.uri.fsPath === unopenedConsumer));
    await vscode.debug.stopDebugging(multiSession);
    await event('terminated');
    await waitUntil(() => vscode.debug.activeDebugSession?.id !== multiSession.id, 'navigation session ends');
    assert.deepEqual(await vscode.commands.executeCommand('vscode.executeDefinitionProvider', multiUri, orderCall), [],
      'A completed session no longer supplies navigation from its captured sources');
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
    const cursorEditor = vscode.window.activeTextEditor || await vscode.window.showTextDocument(parityDocument);
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
      let firstCaptured;
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
        if (index === 0) firstCaptured = vscode.debug.asDebugSourceUri(ownerFrames.stackFrames[0].source, owner);
        else {
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
      vscode: vscode.version, checks: [...languageChecks, ...macroChecks, ...rhombusChecks, ...workflowChecks, ...packageChecks, ...imageChecks, 'activation', 'language registration', 'gutter breakpoint', 'stack',
        'captured source language', 'F9 adds verified breakpoint in captured source', 'F9 removes breakpoint',
        'captured source semantic highlighting', 'captured source language hover', 'stale source excludes language results',
        'captured source definitions and references across unopened files', 'completed session excludes source navigation',
        'return marker and value count distinguish expression completion',
        'editor Step Over to completion exits debugging',
        'live evaluation', 'mutation', 'step over', 'Results scope', 'continue', 'output', 'termination',
        'conditional and hit-count breakpoint', 'logpoint', 'exception stop', 'exceptionInfo',
        'cancel command', 'persistent console', 'terminal input and Unicode output',
        'adapter-provided action availability', 'skip expression command', 'replace results command', 'print results command',
        'print variable command', 'set variable command', 'continue to cursor command',
        'continue to cursor rejects another session’s captured source'] };
    if (process.env.RACKETDAP_TEST_REPORT) fs.writeFileSync(process.env.RACKETDAP_TEST_REPORT, JSON.stringify(report, null, 2));
    console.log('Packaged VS Code integration passed:', JSON.stringify(report));
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    await vscode.debug.stopDebugging();
    tracker.dispose();
  }
};
