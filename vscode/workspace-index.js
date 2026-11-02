// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const path = require('node:path');
const vscode = require('vscode');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource } = require('vscode-languageclient/node');
const { createLanguageProcess, ownedArgs } = require('./language-process');

// The index covers saved files. Untitled documents keep the language server's
// own document-local references and rename.
const isSource = document => document.uri.scheme === 'file' && ['racket', 'rhombus'].includes(document.languageId);
const settingsSection = 'racket-langserver.workspaceAnalysis';
// A file event outside these suffixes starts no pass. A name with no suffix can
// be a folder, whose deletion is reported by its own name alone. A macro reading
// another kind of file is caught up by the next source change or a restart.
const sourceSuffixes = ['.rkt', '.ss', '.scrbl', '.rhm', '.rktl', '.rktd', ''];

// The index has its own document synchronisation and transport. It never sends
// fake document opens to the language server or consumes the server's live traces.
function createWorkspaceIndex(context, { executable, timeout, output, onStatus }) {
  let connection, starting, disposed = false, requested = false, synchronized = false;
  // `revision` counts the messages sent that change the source view, as the
  // server counts those it has read, so a rename's answer shows whether any is
  // still on its way.
  let revision = 0, identity = 0, heard = Date.now(), extensions = {}, folders = [];
  const identities = new WeakMap();
  // The documents the server holds, at the versions it has.
  const versions = new WeakMap();
  const watchers = new Map();
  const documentIdentity = document => {
    if (!identities.has(document)) identities.set(document, ++identity);
    return identities.get(document);
  };
  const settings = () => vscode.workspace.getConfiguration('racket-langserver', vscode.workspace.workspaceFolders?.[0]?.uri)
    .get('workspaceAnalysis', { enabled: true });
  const enabled = () => settings().enabled !== false;
  function failure(error) {
    if (disposed) return;
    output.appendLine(`Workspace index: ${error.message || error}`);
    onStatus({ state: 'failed', indexed: 0, failures: 1 });
  }
  const process = createLanguageProcess(executable, ownedArgs(context, [context.asAbsolutePath('workspace-index-server.rkt')]),
    { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath },
    { timeout, name: 'Workspace index', onTimeout: failure });
  const currentFolders = () => (vscode.workspace.workspaceFolders || []).map(folder => ({ uri: folder.uri.toString(), name: folder.name }));
  function notify(method, params) {
    revision++;
    void connection.sendNotification(method, params).catch(failure);
  }
  // Sends over a live connection. Before there is one, an event can still start
  // the server, which then receives the current state.
  function synchronize(send) {
    if (disposed) return;
    if (synchronized) send();
    else if (requested && enabled()) void start().catch(failure);
  }
  function didOpen(document) {
    versions.set(document, document.version);
    notify('textDocument/didOpen', { textDocument: { uri: document.uri.toString(), languageId: document.languageId,
      version: document.version, text: document.getText() } });
  }
  function didChange(document) {
    if (!versions.has(document)) return;
    versions.set(document, document.version);
    notify('textDocument/didChange', { textDocument: { uri: document.uri.toString(), version: document.version },
      contentChanges: [{ text: document.getText() }] });
  }
  function didClose(document) {
    if (!versions.delete(document)) return;
    notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
  }
  function didChangeFolders() {
    const current = currentFolders();
    const absent = (list, other) => list.filter(folder => !other.some(item => item.uri === folder.uri));
    const added = absent(current, folders), removed = absent(folders, current);
    folders = current;
    if (added.length || removed.length) notify('workspace/didChangeWorkspaceFolders', { event: { added, removed } });
  }
  function watch({ id, registerOptions }) {
    const report = type => uri => {
      if (!sourceSuffixes.includes(path.extname(uri.fsPath).toLowerCase())) return;
      synchronize(() => notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type }] }));
    };
    const items = registerOptions.watchers.flatMap(({ globPattern }) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.parse(globPattern.baseUri), globPattern.pattern));
      return [watcher, watcher.onDidCreate(report(1)), watcher.onDidChange(report(2)), watcher.onDidDelete(report(3))];
    });
    watchers.set(id, { dispose: () => items.forEach(item => item.dispose()) });
  }
  function unwatch({ id }) {
    watchers.get(id)?.dispose();
    watchers.delete(id);
  }
  async function start() {
    requested = true;
    if (disposed || !enabled()) return;
    if (starting) return starting;
    starting = (async () => {
      const child = await process.start();
      if (disposed) return;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', text => output.append(text));
      connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
      connection.onNotification('racketeer/indexStatus', status => { heard = Date.now(); onStatus(status); });
      connection.onError(([error]) => failure(error));
      connection.onClose(() => {
        synchronized = false;
        connection.dispose();
        if (!disposed) failure(new Error('Process stopped. Run Racket: Restart Language Server to restart language tools.'));
      });
      connection.onRequest('workspace/configuration', ({ items }) =>
        items.map(item => item.section === settingsSection ? settings() : null));
      connection.onRequest('client/registerCapability', ({ registrations }) => { registrations.forEach(watch); });
      connection.onRequest('client/unregisterCapability', ({ unregisterations }) => { unregisterations.forEach(unwatch); });
      connection.listen();
      folders = currentFolders();
      const { capabilities } = await connection.sendRequest('initialize', {
        processId: null, clientInfo: { name: 'Racketeer' }, rootUri: null, workspaceFolders: folders,
        capabilities: { general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true,
            didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
          experimental: { racketeer: { indexStatus: true, sourceReferences: true } } }
      });
      if (disposed) return;
      extensions = capabilities?.experimental?.racketeer || {};
      await connection.sendNotification('initialized', {});
      process.ready();
      synchronized = true;
      // The server's first pass starts once it has its settings, which it can
      // only have after these messages. It sees what happened during startup.
      didChangeFolders();
      for (const document of vscode.workspace.textDocuments) {
        if (isSource(document) && !document.isClosed) didOpen(document);
      }
    })();
    return starting;
  }
  function refresh() {
    synchronize(() => {
      revision++;
      void connection.sendRequest('workspace/executeCommand', { command: 'racketeer.refreshWorkspaceIndex' }).catch(failure);
    });
  }
  const subscriptions = [
    vscode.workspace.onDidOpenTextDocument(document => { if (isSource(document)) synchronize(() => didOpen(document)); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      // Dirty-state events can leave both content and version unchanged.
      if (isSource(event.document) &&
          (event.contentChanges.length || versions.get(event.document) !== event.document.version)) {
        synchronize(() => didChange(event.document));
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      identities.delete(document);
      if (isSource(document)) synchronize(() => didClose(document));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => synchronize(didChangeFolders)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(settingsSection)) {
        synchronize(() => notify('workspace/didChangeConfiguration', { settings: null }));
      }
    })
  ];
  const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
  // The index reports after each file it analyses and bounds each request's
  // work, so it is never silent for long. A request it leaves unanswered and
  // silent for as long as it may take to start is withdrawn: references then
  // come from the language server alone, and rename reports the stall.
  const silent = Symbol('silent');
  function ask(method, params, token) {
    const source = new CancellationTokenSource();
    const linked = token.onCancellationRequested(() => source.cancel());
    heard = Date.now();
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (Date.now() - heard < timeout) return;
        source.cancel();
        failure(new Error(`no answer to ${method} for ${timeout / 1000} seconds.`));
        resolve(silent);
      }, Math.min(1000, timeout));
      connection.sendRequest(method, params, source.token).then(resolve, reject)
        .finally(() => { clearInterval(check); linked.dispose(); source.dispose(); });
    }).then(value => { if (value !== silent) heard = Date.now(); return value; });
  }
  async function renameRequest(method, document, position, token, newName) {
    if (!enabled()) throw new Error('Enable workspace analysis to rename safely across files.');
    if (disposed || token.isCancellationRequested) return;
    const version = document.version, owned = documentIdentity(document);
    await start();
    if (disposed || token.isCancellationRequested) return;
    const response = await ask(method, {
      uri: document.uri.toString(), version,
      position: { line: position.line, character: position.character },
      ...(newName === undefined ? {} : { newName })
    }, token).catch(error => {
      if (!disposed && !token.isCancellationRequested) throw error;
    });
    if (disposed || token.isCancellationRequested) return;
    if (response === silent) throw new Error('The workspace index stopped answering. Run Racket: Restart Language Server.');
    if (response.revision !== revision || version !== document.version ||
        identities.get(document) !== owned || document.isClosed ||
        !vscode.workspace.textDocuments.includes(document)) {
      throw new Error('Workspace changed during rename. Try Rename again.');
    }
    return response.result;
  }
  // The process is ended either way, so a server slow to close its engine
  // holds up restarting language tools only briefly.
  async function stopServer() {
    let timer;
    const stopped = connection.sendRequest('shutdown').then(() => connection.sendNotification('exit'));
    await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]).catch(() => {});
    clearTimeout(timer);
  }
  return {
    start, refresh,
    cancelStart: () => process.cancelStart(),
    async prepareRename(document, position, token, next) {
      if (!isSource(document)) return next(document, position, token);
      const result = await renameRequest('racketeer/prepareRename', document, position, token);
      return result && range(result);
    },
    async provideRenameEdits(document, position, newName, token, next) {
      if (!isSource(document)) return next(document, position, newName, token);
      const result = await renameRequest('racketeer/rename', document, position, token, newName);
      if (!result) return;
      const edit = new vscode.WorkspaceEdit();
      for (const [uri, changes] of Object.entries(result.changes)) {
        edit.set(vscode.Uri.parse(uri), changes.map(change => new vscode.TextEdit(range(change.range), change.newText)));
      }
      return edit;
    },
    // A captured source supplies its file URI separately; its own document
    // owns the request even if VS Code closes the underlying file document.
    async provideReferences(document, position, options, token, next, sourceUri) {
      if (!enabled() || (!sourceUri && !isSource(document))) return next(document, position, options, token);
      if (disposed || token.isCancellationRequested) return [];
      const version = document.version, owned = documentIdentity(document);
      const text = sourceUri && document.getText();
      try {
        await start();
        if (disposed || token.isCancellationRequested) return [];
        if (sourceUri && !extensions.sourceReferences) return next(document, position, options, token);
        const locations = await ask(sourceUri ? 'racketeer/sourceReferences' : 'racketeer/references', {
          uri: (sourceUri || document.uri).toString(),
          ...(sourceUri ? { text } : { version }),
          position: { line: position.line, character: position.character },
          includeDeclaration: options.includeDeclaration
        }, token);
        if (locations === silent) return next(document, position, options, token);
        if (disposed || token.isCancellationRequested || version !== document.version ||
            identities.get(document) !== owned || !vscode.workspace.textDocuments.includes(document)) return [];
        return locations.map(location => new vscode.Location(vscode.Uri.parse(location.uri),
          new vscode.Range(location.range.start.line, location.range.start.character,
            location.range.end.line, location.range.end.character)));
      } catch (error) {
        if (disposed || token.isCancellationRequested || [-32800, -32801].includes(error.code)) return [];
        failure(error);
        throw error;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      subscriptions.forEach(item => item.dispose());
      watchers.forEach(item => item.dispose());
      if (synchronized) await stopServer();
      connection?.dispose();
      await process.dispose();
      await starting?.catch(() => {});
    }
  };
}

module.exports = { createWorkspaceIndex };
