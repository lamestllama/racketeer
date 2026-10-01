'use strict';
const vscode = require('vscode');

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
  function readOnly() { throw vscode.FileSystemError.NoPermissions('Image results are read-only. Use Save Image As.'); }
  function imageResults(result) {
    return result?.racketdapImage ? [result] : result?.racketdapImages || [];
  }
  function updateContext() {
    const result = sessions.get(vscode.debug.activeDebugSession?.id)?.result;
    void vscode.commands.executeCommand('setContext', 'racketdap.viewImage.enabled', imageResults(result).length > 0);
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
        const uri = tab.input?.uri;
        if (uri?.scheme === scheme && !vscode.window.tabGroups.all.some(group =>
          group.tabs.some(open => open.input?.uri?.toString() === uri.toString()))) images.delete(uri.toString());
      }
    }),
    vscode.commands.registerCommand('racketdap.viewImage', async variableContext => {
      try {
        const record = sessions.get(variableContext ? variableContext.sessionId : vscode.debug.activeDebugSession?.id);
        if (!record) throw new Error('The Racket debug session has ended or is unavailable.');
        const result = record?.result;
        const choices = variableContext ? [variableContext.variable] : imageResults(result);
        if (variableContext && (!Number.isSafeInteger(choices[0]?.variablesReference) || choices[0].variablesReference <= 0)) {
          throw new Error('Select an image value in Variables.');
        }
        if (!choices.length) throw new Error('Evaluate an image value in the Racket Debug Console first.');
        if (record.rendering) throw new Error('An image preview is already in progress. Finish or cancel it first.');
        record.rendering = true;
        let rendered;
        try {
          const selected = choices.length === 1 ? choices[0] : (await vscode.window.showQuickPick(
            choices.map(value => ({ label: value.name, description: value.type, value })),
            { title: 'View Image Result', placeHolder: choices.length === 200
              ? 'Choose from the first 200 returned image values'
              : 'Choose a returned value to view' }))?.value;
          if (!selected) return;
          if ((!variableContext && record.result !== result) || !sessions.has(record.session.id)) {
            throw new Error('The image result has expired. Evaluate it again before viewing.');
          }
          rendered = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window,
            title: 'Rendering Racket image (Racket: Cancel Evaluation to interrupt)' }, () =>
            record.session.customRequest('racketdap/renderImage', { variablesReference: selected.variablesReference }));
        } finally { record.rendering = false; }
        if (rendered?.mimeType !== 'image/png' || typeof rendered.data !== 'string' || rendered.data.length > 12 * 1024 * 1024) {
          throw new Error('The debugger returned an invalid image response.');
        }
        const data = Buffer.from(rendered.data, 'base64');
        if (data.length > 8 * 1024 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error('The debugger returned an invalid PNG image.');
        }
        const uri = vscode.Uri.from({ scheme, path: `/Racket image ${++nextImage}.png` });
        images.set(uri.toString(), { data, time: Date.now() });
        const group = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.input?.uri?.scheme === scheme));
        try { await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: group?.viewColumn ?? vscode.ViewColumn.Beside, preview: false }); }
        catch (error) { images.delete(uri.toString()); throw error; }
        return uri;
      } catch (error) { vscode.window.showErrorMessage(error.message); throw error; }
    }),
    vscode.commands.registerCommand('racketdap.saveImage', async uri => {
      try {
        uri ||= vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
        if (uri?.scheme !== scheme) throw new Error('Open a Racket image result first.');
        const entry = image(uri);
        const destination = await vscode.window.showSaveDialog({ title: 'Save Racket Image', filters: { 'PNG image': ['png'] } });
        if (destination) await vscode.workspace.fs.writeFile(destination, entry.data);
      } catch (error) { vscode.window.showErrorMessage(error.message); throw error; }
    }),
    new vscode.Disposable(() => { sessions.clear(); images.clear(); })
  );
  updateContext();
}
module.exports = { registerDebugImages };
