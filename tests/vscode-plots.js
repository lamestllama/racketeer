// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { showsSnapshot } = require('./vscode-images');

exports.run = async function (workspace, observe = async () => {}) {
  const events = [], sessions = [], requests = [], breakpoints = [];
  const ended = new Set();
  const program = path.join(workspace.uri.fsPath, 'interactive-plots.rkt');
  const variableProgram = path.join(workspace.uri.fsPath, 'plot-variables.rkt');
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      sessions.push(session);
      return {
        onWillReceiveMessage(message) { requests.push({ session, ...message }); },
        onDidSendMessage(message) {
          events.push({ session, ...message });
          if (message.type === 'event' && message.event === 'terminated') ended.add(session.id);
        }
      };
    }
  });
  const event = (session, name) => until(() => {
    const index = events.findIndex(e => e.session.id === session.id && e.event === name);
    return index >= 0 && events.splice(index, 1)[0];
  }, name);
  const ready = session => event(session, 'racketdap/ready');
  let snapshot;
  try {
    const doc = await vscode.workspace.openTextDocument(program);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('racketdap.startDebugRepl');
    const session = await until(() => sessions[0], 'Debug REPL starts');
    await ready(session);
    await until(() => vscode.debug.activeDebugSession?.id === session.id, 'Debug REPL selected');
    for (const expression of ['curve', '(values 42 surface "caption")']) {
      const result = await session.customRequest('evaluate', { expression, context: 'repl' });
      await ready(session);
      assert.ok(result.racketdapPlot || result.racketdapImages[0].racketdapPlot);
      await vscode.commands.executeCommand('racketdap.openPlot');
      await ready(session);
    }
    assert.equal(requests.filter(r => r.command === 'evaluate').length, 2, 'Opening must not reevaluate');
    await observe('two-plots', 2);
    snapshot = await vscode.commands.executeCommand('racketdap.viewImage');
    await ready(session);
    assert.ok((await vscode.workspace.fs.readFile(snapshot)).length > 8);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('racketdap.restartDebugRepl');
    await event(session, 'terminated');
    const restarted = await until(() => sessions[1], 'Debug REPL restarts');
    await ready(restarted);
    await observe('restart-cleared', 0);
    assert.ok((await vscode.workspace.fs.readFile(snapshot)).length > 8, 'Static snapshot survives restart');
    await until(() => vscode.debug.activeDebugSession?.id === restarted.id, 'Restarted session selected');
    await restarted.customRequest('evaluate', { expression: 'curve', context: 'repl' });
    await ready(restarted);
    await vscode.commands.executeCommand('racketdap.openPlot');
    await ready(restarted);
    await observe('reopened', 1);
    await vscode.debug.stopDebugging(restarted);
    await event(restarted, 'terminated');
    await observe('stopped', 0);

    const source = (await fs.readFile(program, 'utf8')) + '\n(define (hold value)\n  (define nested (vector value))\n  (values value nested))\n(hold curve)\n';
    await fs.writeFile(variableProgram, source);
    const line = source.split('\n').findIndex(text => text.includes('(values value nested)'));
    breakpoints.push(new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(variableProgram), new vscode.Position(line, 2))));
    vscode.debug.addBreakpoints(breakpoints);
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Interactive plot variables', program: variableProgram, submodule: []
    }), true);
    const paused = await until(() => sessions[2], 'Variable session starts');
    const stop = await event(paused, 'stopped');
    const { stackFrames } = await paused.customRequest('stackTrace', { threadId: stop.body.threadId });
    const { scopes } = await paused.customRequest('scopes', { frameId: stackFrames[0].id });
    const locals = scopes.find(scope => scope.name === 'Locals');
    const { variables } = await paused.customRequest('variables', { variablesReference: locals.variablesReference });
    const value = variables.find(v => v.name === 'value');
    assert.equal(value.__vscodeVariableMenuContext, 'racketdap.plot');
    const nested = variables.find(v => v.name === 'nested');
    const children = await paused.customRequest('variables', { variablesReference: nested.variablesReference });
    for (const variable of [value, children.variables[0]]) {
      // VS Code's menu argument need only retain standard protocol fields.
      const { name, type, variablesReference } = variable;
      await vscode.commands.executeCommand('racketdap.openPlot', {
        sessionId: paused.id, container: locals, variable: { name, type, variablesReference }
      });
    }
    assert.equal(requests.filter(r => r.session.id === paused.id && r.command === 'evaluate').length, 0);
    await observe('paused-variables', 2);
    await vscode.debug.stopDebugging(paused);
    await event(paused, 'terminated');
    await observe('variables-stopped', 0);
    return ['2D plot from Debug REPL', '3D plot among multiple values', 'open without reevaluation',
      'native static preview of a live plot', 'restart closes plots and preserves snapshots',
      'new plot after restart', 'local and nested plot variables', 'stop closes plot windows'];
  } finally {
    for (const session of sessions) if (!ended.has(session.id)) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(breakpoints);
    tracker.dispose();
    await fs.rm(variableProgram, { force: true });
    if (snapshot) {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => showsSnapshot(tab, snapshot));
      await vscode.window.tabGroups.close(tabs);
    }
  }
};
