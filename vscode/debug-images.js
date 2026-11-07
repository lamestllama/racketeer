// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const { pngBytes } = require('./interaction-output');

function registerDebugImages(context) {
  const scheme = 'racketeer-image';
  const sessions = new Map(), images = new Map();
  const changes = new vscode.EventEmitter();
  let nextImage = 0;
  function image(uri) {
    // Viewer cache queries do not change the identity of an immutable file.
    const entry = images.get(uri.with({ query: '', fragment: '' }).toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return entry;
  }
  // VS Code 1.144 shows images in a workbench editor whose tabs expose no
  // input to extensions; the tab label is then the snapshot's unique name.
  function snapshotOf(tab) {
    if (tab.input === undefined) return [...images].find(([, entry]) => entry.name === tab.label)?.[0];
    if (tab.input?.uri?.scheme === scheme) return tab.input.uri.toString();
  }
  function readOnly() { throw vscode.FileSystemError.NoPermissions('Image results are read-only. Use Save Image As.'); }
  function imageResults(result) {
    return result?.racketdapImage || result?.racketdapPlot ? [result] : result?.racketdapImages || [];
  }
  function updateContext() {
    const result = sessions.get(vscode.debug.activeDebugSession?.id)?.result;
    void vscode.commands.executeCommand('setContext', 'racketdap.openPlot.enabled', imageResults(result).some(value => value.racketdapPlot));
    void vscode.commands.executeCommand('setContext', 'racketdap.viewImage.enabled', imageResults(result).some(value => value.racketdapImage));
  }
  async function viewValue(variableContext, interactive = false) {
    try {
      const record = sessions.get(variableContext ? variableContext.sessionId : vscode.debug.activeDebugSession?.id);
      if (!record) throw new Error('The Racket debug session has ended or is unavailable.');
      const result = record?.result;
      const choices = variableContext ? [variableContext.variable] : imageResults(result).filter(value => interactive ? value.racketdapPlot : value.racketdapImage);
      if (variableContext && (!Number.isSafeInteger(choices[0]?.variablesReference) || choices[0].variablesReference <= 0)) {
        throw new Error(interactive ? 'Select an interactive plot in Variables.' : 'Select an image value in Variables.');
      }
      if (!choices.length) throw new Error(interactive ? 'Evaluate a plot or plot3d value in the Racket Debug Console first.' : 'Evaluate an image value in the Racket Debug Console first.');
      if (record.rendering) throw new Error('An image or plot is already in progress. Finish or cancel it first.');
      record.rendering = true;
      let rendered;
      try {
        const selected = choices.length === 1 ? choices[0] : (await vscode.window.showQuickPick(
          choices.map(value => ({ label: value.name, description: value.type, value })),
          { title: interactive ? 'Open Interactive Plot' : 'View Image Result', placeHolder: choices.length === 200
            ? 'Choose from the first 200 returned image or plot values'
            : 'Choose a returned value to view' }))?.value;
        if (!selected) return;
        if ((!variableContext && record.result !== result) || !sessions.has(record.session.id)) {
          throw new Error('The result has expired. Evaluate it again before viewing.');
        }
        if (interactive) {
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Window,
            title: 'Opening Racket plot (Racket: Cancel Evaluation to interrupt)' }, () =>
            record.session.customRequest('racketdap/openPlot', { variablesReference: selected.variablesReference }));
          return;
        }
        rendered = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window,
          title: 'Rendering Racket image (Racket: Cancel Evaluation to interrupt)' }, () =>
          record.session.customRequest('racketdap/renderImage', { variablesReference: selected.variablesReference }));
      } finally { record.rendering = false; }
      return await openSnapshot(rendered);
    } catch (error) { vscode.window.showErrorMessage(error.message); throw error; }
  }
  async function openSnapshot(rendered) {
    let data;
    try { data = pngBytes(rendered); }
    catch (error) { throw new Error(`The debugger returned an invalid image: ${error.message}`); }
    const name = `Racket image ${++nextImage}.png`;
    const uri = vscode.Uri.from({ scheme, path: `/${name}` });
    images.set(uri.toString(), { data, time: Date.now(), name, uri });
    const group = vscode.window.tabGroups.all.find(group => group.tabs.some(snapshotOf));
    try { await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: group?.viewColumn ?? vscode.ViewColumn.Beside, preview: false }); }
    catch (error) { images.delete(uri.toString()); throw error; }
    return uri;
  }
  context.subscriptions.push(
    changes,
    vscode.workspace.registerFileSystemProvider(scheme, {
      onDidChangeFile: changes.event,
      watch: () => new vscode.Disposable(() => {}),
      stat(uri) {
        const entry = image(uri);
        return { type: vscode.FileType.File, ctime: entry.time, mtime: entry.time, size: entry.data.length };
      },
      readFile: uri => image(uri).data,
      readDirectory: uri => { throw vscode.FileSystemError.FileNotADirectory(uri); },
      createDirectory: readOnly, writeFile: readOnly, delete: readOnly, rename: readOnly
    }, { isReadonly: true }),
    vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
      createDebugAdapterTracker(session) {
        const record = { session, pending: new Set(), result: undefined, rendering: false };
        sessions.set(session.id, record);
        return {
          onWillReceiveMessage(message) {
            if (message.type === 'request' && message.command === 'evaluate' && message.arguments?.context === 'repl') {
              record.pending.add(message.seq);
              record.result = undefined;
              updateContext();
            }
          },
          onDidSendMessage(message) {
            if (message.type === 'response' && record.pending.delete(message.request_seq)) {
              record.result = message.success ? message.body : undefined;
              updateContext();
            }
            if (message.type === 'event' && ['continued', 'terminated'].includes(message.event)) {
              record.result = undefined;
              if (message.event === 'terminated') sessions.delete(session.id);
              updateContext();
            }
          }
        };
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession(updateContext),
    vscode.debug.onDidTerminateDebugSession(session => { sessions.delete(session.id); updateContext(); }),
    vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.closed) {
        const key = snapshotOf(tab);
        if (key && !vscode.window.tabGroups.all.some(group => group.tabs.some(open => snapshotOf(open) === key))) images.delete(key);
      }
    }),
    vscode.commands.registerCommand('racketdap.viewImage', context => viewValue(context)),
    vscode.commands.registerCommand('racketdap.openPlot', context => viewValue(context, true)),
    vscode.commands.registerCommand('racketdap.saveImage', async uri => {
      try {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        uri ||= active && images.get(snapshotOf(active))?.uri;
        if (uri?.scheme !== scheme) throw new Error('Open a Racket image result first.');
        const entry = image(uri);
        const destination = await vscode.window.showSaveDialog({ title: 'Save Racket Image', filters: { 'PNG image': ['png'] } });
        if (destination) await vscode.workspace.fs.writeFile(destination, entry.data);
      } catch (error) { vscode.window.showErrorMessage(error.message); throw error; }
    }),
    new vscode.Disposable(() => { sessions.clear(); images.clear(); })
  );
  updateContext();
  return { openSnapshot };
}
module.exports = { registerDebugImages };
