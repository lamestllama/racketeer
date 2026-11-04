// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const fs = require('node:fs/promises'), vscode = require('vscode');
exports.run = async function (workspace, interact) {
  const sessions = [], events = [], ended = new Set(), checks = [];
  const directory = await fs.mkdtemp(path.join(workspace.uri.fsPath, 'application-logs-'));
  const program = path.join(directory, 'log λ.rkt');
  await fs.writeFile(program, `#lang racket/base
(define-logger network)
(define-logger storage)
(define (sample tag)
 (log-network-debug "debug ~a λ" tag)
 (log-network-warning "warning ~a" tag)
 (log-storage-info "info ~a" tag)
 (log-storage-error "error ~a" tag))
(sample "initial")
(define (hold x) (+ x 1))
`);
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.push(session);
      return { onDidSendMessage(message) { events.push({ session, ...message }); if (message.event === 'terminated') ended.add(session.id); } };
    }
  });
  async function until(check, description) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Timed out: ' + description);
  }
  const event = (session, name) => until(() => {
    const i = events.findIndex(message => message.session.id === session.id && message.event === name);
    return i >= 0 && events.splice(i, 1)[0];
  }, name);
  async function start(name, logFilter) {
    assert.equal(await vscode.debug.startDebugging(workspace, { type: 'racketdap', request: 'launch', name, program, interactive: true, submodule: [], logFilter }), true);
    const session = await until(() => sessions.find(session => session.name === name), 'session starts');
    await event(session, 'racketdap/ready'); return session;
  }
  async function evaluate(session, expression) { const result = await session.customRequest('evaluate', { context: 'repl', expression }); await event(session, 'racketdap/ready'); return result; }
  // VS Code 1.144 creates an Output model empty, so its line ends follow files.eol
  // (CRLF by default on Windows). Expect CRLF on every platform, and read the
  // log in the model's own line ends.
  const files = vscode.workspace.getConfiguration('files');
  const eol = files.inspect('eol').globalValue;
  await files.update('eol', '\r\n', vscode.ConfigurationTarget.Global);
  const content = document => document.eol === vscode.EndOfLine.CRLF ? document.getText().replaceAll('\r\n', '\n') : document.getText();
  async function show(session, text) {
    await vscode.commands.executeCommand('racketdap.showApplicationLog', session.id);
    const document = await until(() => vscode.workspace.textDocuments.find(document => document.uri.scheme === 'output' && content(document).startsWith(session.name + ' —') && content(document).includes(text)), 'native Output shows ' + JSON.stringify(text));
    return { getText: () => content(document) };
  }
  const breakpoints = [];
  try {
    const a = await start('First application log', 'warning debug@network none@storage');
    let log = await show(a, 'warning initial');
    assert.match(log.getText(), /debug initial λ/); assert.doesNotMatch(log.getText(), /error initial/);
    checks.push('Native Output captures module startup with topic and severity filtering');
    const b = await start('Second application log', 'none info@storage');
    await evaluate(a, '(sample "alpha")'); await evaluate(b, '(sample "beta")');
    log = await show(a, 'debug alpha'); assert.doesNotMatch(log.getText(), /beta/);
    const second = await show(b, 'info beta'); assert.doesNotMatch(second.getText(), /alpha/);
    checks.push('Concurrent sessions retain independent messages and capture filters');
    if (interact) await interact(a);
    else await vscode.commands.executeCommand('racketdap.filterApplicationLog', a.id, 'none info@storage');
    await evaluate(a, '(sample "changed")'); log = await show(a, 'info changed');
    assert.doesNotMatch(log.getText(), /debug changed|warning changed/); assert.match(log.getText(), /debug alpha/);
    checks.push('Changing a live filter selects new topics and retains previous messages');
    await vscode.commands.executeCommand('racketdap.clearApplicationLog', a.id);
    await evaluate(a, '(sample "after-clear")'); log = await show(a, 'info after-clear'); assert.doesNotMatch(log.getText(), /debug alpha/);
    assert.match((await show(b, 'info beta')).getText(), /info beta/);
    checks.push('Clear affects only the selected session log');
    const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(program), new vscode.Position(9, 16)));
    breakpoints.push(bp); vscode.debug.addBreakpoints([bp]);
    await until(() => events.some(message => message.session.id === a.id && message.type === 'response' &&
      message.command === 'setBreakpoints' && message.body?.breakpoints?.some(item => item.verified)), 'log breakpoint verified');
    const evaluating = a.customRequest('evaluate', { context: 'repl', expression: '(hold 4)' });
    const stop = await event(a, 'stopped');
    await vscode.commands.executeCommand('racketdap.filterApplicationLog', a.id, 'none debug@network');
    const frames = await a.customRequest('stackTrace', { threadId: stop.body.threadId });
    await a.customRequest('evaluate', { context: 'repl', frameId: frames.stackFrames[0].id, expression: '(log-network-info "paused-log")' });
    await show(a, 'paused-log'); await a.customRequest('continue', { threadId: stop.body.threadId });
    assert.equal((await evaluating).result, '5'); await event(a, 'racketdap/ready');
    vscode.debug.removeBreakpoints(breakpoints.splice(0));
    checks.push('Filtering and logging remain available during a debugger pause');
    await vscode.debug.stopDebugging(a); await until(() => ended.has(a.id), 'first session ends');
    log = await show(a, ' — Stopped\n'); assert.match(log.getText(), /paused-log/);
    assert.equal((await evaluate(b, '(+ 20 22)')).result, '42');
    checks.push('Stopping a session retains its log and leaves another debugger usable');
    const c = await start('Restarted application log', 'error');
    log = await show(c, 'error initial'); assert.doesNotMatch(log.getText(), /alpha|paused-log|debug initial/);
    checks.push('A replacement session starts with a fresh log and configured filter');
    await vscode.commands.executeCommand('racketdap.filterApplicationLog', c.id, 'none');
    await evaluate(c, '(sample "disabled")'); log = await show(c, 'Capture filter: none'); assert.doesNotMatch(log.getText(), /disabled/);
    checks.push('Disabling capture leaves evaluation usable');
    return checks;
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    for (const session of sessions) if (!ended.has(session.id)) await vscode.debug.stopDebugging(session);
    tracker.dispose(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await files.update('eol', eol, vscode.ConfigurationTarget.Global);
  }
};
