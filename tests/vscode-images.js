'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const vscode = require('vscode');

exports.run = async function (workspace) {
  const events = [], sessions = [], previews = [], requests = [], breakpoints = [], ended = new Set();
  const variableProgram = path.join(workspace.uri.fsPath, 'image-variables.rkt');
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
  async function until(check, description, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${description}. ${JSON.stringify(events.slice(-20)
      .map(({ session, ...message }) => ({ sessionId: session.id, ...message })))}`);
  }
  async function event(session, name, timeout) {
    return until(() => {
      const index = events.findIndex(event => event.session.id === session.id && event.event === name);
      return index >= 0 && events.splice(index, 1)[0];
    }, name, timeout);
  }
  const ready = (session, timeout) => event(session, 'racketdap/ready', timeout);
  try {
    const started = Date.now();
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Image result inspection',
      program: path.join(workspace.uri.fsPath, 'images.rkt'), interactive: true, submodule: []
    }), true);
    const session = await until(() => sessions[0], 'image debug session starts');
    // Match the protocol suite's budget for loading the image libraries.
    await ready(session, 60000);
    console.log(`Image example startup: ${Date.now() - started} ms`);
    await until(() => vscode.debug.activeDebugSession?.id === session.id, 'image session selected');
    for (const [name, width, height] of [['tile', 64, 32], ['drawing', 48, 32], ['chart', 240, 160]]) {
      const value = await session.customRequest('evaluate', { expression: name, context: 'repl' });
      assert.equal(value.racketdapImage, true);
      await ready(session);
      const uri = await vscode.commands.executeCommand('racketdap.viewImage');
      previews.push(uri);
      await ready(session);
      const tab = await until(() => vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()),
      'native image editor opens');
      assert.equal(tab.input.viewType, 'imagePreview.previewEditor');
      const png = Buffer.from(await vscode.workspace.fs.readFile(uri));
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(uri.with({ query: 'version=1' }))), png,
        'image viewer cache queries resolve to the same immutable snapshot');
      assert.equal(png.readUInt32BE(16), width);
      assert.equal(png.readUInt32BE(20), height);
      await assert.rejects(vscode.workspace.fs.writeFile(uri, png), /read.only|permission/i);
    }
    // A single image among multiple values needs no selection dialog.
    const mixed = await session.customRequest('evaluate', { expression: '(values 42 drawing "caption")', context: 'repl' });
    await ready(session);
    assert.deepEqual(mixed.racketdapImages.map(value => value.name), ['value 2']);
    const mixedUri = await vscode.commands.executeCommand('racketdap.viewImage');
    previews.push(mixedUri);
    await ready(session);
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(mixedUri)),
      Buffer.from(await vscode.workspace.fs.readFile(previews[1])));
    await session.customRequest('evaluate', { expression: '(values 42 "caption")', context: 'repl' });
    await ready(session);
    await assert.rejects(vscode.commands.executeCommand('racketdap.viewImage'), /Evaluate an image value/);
    await vscode.debug.stopDebugging(session);
    await until(() => events.some(event => event.session.id === session.id && event.event === 'terminated'), 'image session ends');

    await fs.writeFile(variableProgram, `#lang racket/base
(require pict)
(define (paint picture)
  (define pictures (vector picture))
  (values picture (vector-ref pictures 0)))
(paint (colorize (disk 40) "forestgreen"))
`);
    breakpoints.push(new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(variableProgram), new vscode.Position(4, 0))));
    vscode.debug.addBreakpoints(breakpoints);
    assert.equal(await vscode.debug.startDebugging(workspace, {
      type: 'racketdap', request: 'launch', name: 'Image variable inspection', program: variableProgram, submodule: []
    }), true);
    const paused = await until(() => sessions[1], 'image variable session starts');
    const stop = await event(paused, 'stopped');
    async function scopes() {
      const { stackFrames } = await paused.customRequest('stackTrace', { threadId: stop.body.threadId });
      return (await paused.customRequest('scopes', { frameId: stackFrames[0].id })).scopes;
    }
    const locals = (await scopes()).find(scope => scope.name === 'Locals');
    const { variables } = await paused.customRequest('variables', { variablesReference: locals.variablesReference });
    const picture = variables.find(variable => variable.name === 'picture');
    assert.equal(picture.__vscodeVariableMenuContext, 'racketdap.image');
    async function viewVariable(container, variable) {
      // The menu supplies protocol fields; rendering must not depend on extra metadata surviving the editor.
      const { name, value, type, variablesReference } = variable;
      const uri = await vscode.commands.executeCommand('racketdap.viewImage', {
        sessionId: paused.id, container, variable: { name, value, type, variablesReference }
      });
      previews.push(uri);
      return Buffer.from(await vscode.workspace.fs.readFile(uri));
    }
    const direct = await viewVariable(locals, picture);
    assert.equal(direct.readUInt32BE(16), 40);
    const pictures = variables.find(variable => variable.name === 'pictures');
    assert.equal(pictures.__vscodeVariableMenuContext, undefined);
    const nested = await paused.customRequest('variables', { variablesReference: pictures.variablesReference });
    assert.deepEqual(await viewVariable(pictures, nested.variables[0]), direct);
    await paused.customRequest('next', { threadId: stop.body.threadId });
    await event(paused, 'stopped');
    const results = (await scopes()).find(scope => scope.name === 'Return values (2)');
    assert.ok(results, 'Step Over exposes returned values');
    const returned = await paused.customRequest('variables', { variablesReference: results.variablesReference });
    assert.equal(returned.variables.length, 2);
    assert.deepEqual(await viewVariable(results, returned.variables[1]), direct);
    assert.equal(requests.filter(request => request.session.id === paused.id && request.command === 'evaluate').length, 0,
      'viewing locals, fields and returned values never evaluates an expression');
    assert.equal(vscode.window.tabGroups.all.filter(group => group.tabs.some(tab => tab.input?.uri?.scheme === 'racketeer-image')).length, 1,
      'image previews share one editor group');
    await vscode.debug.stopDebugging(paused);
    await event(paused, 'terminated');
    await assert.rejects(vscode.commands.executeCommand('racketdap.viewImage', {
      sessionId: paused.id, container: locals, variable: picture
    }), /expired|ended|unavailable|terminat|disconnected/i);
    for (const uri of previews) assert.ok((await vscode.workspace.fs.readFile(uri)).length > 8,
      'rendered snapshots remain available after the debug session ends');
    const closed = previews[0];
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input?.uri?.toString() === closed.toString());
    assert.equal(await vscode.window.tabGroups.close(tabs), true);
    await until(async () => {
      try { await vscode.workspace.fs.stat(closed); return false; } catch (_) { return true; }
    }, 'closing the final image tab releases its snapshot');
    return ['image, pict and plot in native image editor', 'image results are read-only', 'image among multiple returned values',
      'ordinary evaluations clear image action', 'image snapshots survive termination', 'closed image snapshots are released',
      'local, nested and returned image values without evaluation', 'image variables expire with their session',
      'image previews share an editor group'];
  } finally {
    for (const session of sessions) if (!ended.has(session.id)) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(breakpoints);
    await fs.rm(variableProgram, { force: true });
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => previews.some(uri => tab.input?.uri?.toString() === uri.toString()));
    await vscode.window.tabGroups.close(tabs);
    tracker.dispose();
  }
};
