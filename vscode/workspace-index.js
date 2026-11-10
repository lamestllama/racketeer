// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const path = require('node:path');
const vscode = require('vscode');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource } = require('vscode-languageclient/node');
const { createLanguageProcess, ownedArgs } = require('./language-process');
const { racketTooOld } = require('./racket-version');

const settingsSection = 'racket-langserver.workspaceAnalysis';
// A file event outside these suffixes waits for the next request, so a program
// writing logs cannot hold up one that is waiting. A name with no suffix can be a
// folder, whose deletion is reported by its own name alone.
const sourceSuffixes = ['.rkt', '.ss', '.scrbl', '.rhm', '.rktl', '.rktd', ''];

// The index has its own document synchronisation and transport. It never sends
// fake document opens to the language server or consumes the server's live traces.
function createWorkspaceIndex(context, { executable, timeout, output, onStatus, supportsDocument, code2ProtocolConverter, protocol2CodeConverter }) {
  const isSource = document => ['file', 'untitled'].includes(document.uri.scheme) && supportsDocument(document);
  let connection, starting, disposed = false, synchronized = false, stalled = false;
  let identity = 0, heard = Date.now(), folders = [];
  const identities = new WeakMap();
  // The documents the server holds, at the versions it has.
  const versions = new WeakMap();
  const watchers = new Map();
  // File events waiting for the next request: the latest in each folder.
  const held = new Map();
  // When each URI last closed, counted by closes, so a rename can tell a document
  // that was closed and reopened at the same version from one that stayed open.
  const closes = new Map();
  let closeCount = 0;
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
    { owned: true, timeout, name: 'Workspace index', onTimeout: failure });
  const currentFolders = () => (vscode.workspace.workspaceFolders || []).map(folder => ({ uri: folder.uri.toString(), name: folder.name }));
  function notify(method, params) {
    void connection.sendNotification(method, params).catch(failure);
  }
  // Sends over a live connection. A server started later receives the current state.
  function synchronize(send) {
    if (!disposed && synchronized) send();
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
      const change = { uri: uri.toString(), type };
      if (sourceSuffixes.includes(path.extname(uri.fsPath).toLowerCase())) {
        synchronize(() => notify('workspace/didChangeWatchedFiles', { changes: [change] }));
      } else synchronize(() => {
        // The server discards a report of an excluded folder, so it must not displace one
        // the server needs. It reads the setting as a list of strings or not at all.
        const excluded = settings().excludedDirectories;
        if (!(Array.isArray(excluded) && excluded.every(name => typeof name === 'string') &&
              excluded.includes(path.basename(uri.fsPath)))) {
          held.set(path.dirname(uri.fsPath), change);
        }
      });
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
  // The server starts when first asked for, and its index when a request needs it.
  async function start() {
    if (disposed) return;
    if (starting) return starting;
    starting = (async () => {
      const tooOld = await racketTooOld(executable);
      if (tooOld) throw Object.assign(new Error(tooOld), { refused: true });
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
      connection.onRequest('window/workDoneProgress/create', () => null);
      connection.onUnhandledProgress(({ value }) => {
        heard = Date.now();
        if (value.kind !== 'end') onStatus({ state: 'indexing', message: value.message });
      });
      connection.onRequest('workspace/configuration', ({ items }) =>
        items.map(item => item.section === settingsSection ? settings() : null));
      connection.onRequest('client/registerCapability', ({ registrations }) => { registrations.forEach(watch); });
      connection.onRequest('client/unregisterCapability', ({ unregisterations }) => { unregisterations.forEach(unwatch); });
      connection.listen();
      folders = currentFolders();
      await connection.sendRequest('initialize', {
        processId: null, clientInfo: { name: 'Racketeer' }, rootUri: null, workspaceFolders: folders,
        capabilities: { general: { positionEncodings: ['utf-16'] },
          window: { workDoneProgress: true },
          textDocument: { rename: { prepareSupport: true } },
          workspace: { configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true },
            didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
          experimental: { racketeer: { indexStatus: true } } }
      });
      if (disposed) return;
      await connection.sendNotification('initialized', {});
      process.ready();
      synchronized = true;
      // It sees what happened during startup.
      didChangeFolders();
      for (const document of vscode.workspace.textDocuments) {
        if (isSource(document) && !document.isClosed) didOpen(document);
      }
    })();
    return starting;
  }
  function refresh() {
    synchronize(() => {
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
      closes.set(document.uri.toString(), ++closeCount);
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
    if (stalled) return Promise.resolve(silent);
    const source = new CancellationTokenSource();
    const linked = token.onCancellationRequested(() => source.cancel());
    heard = Date.now();
    if (held.size) {
      notify('workspace/didChangeWatchedFiles', { changes: [...held.values()] });
      held.clear();
    }
    let check;
    return new Promise((resolve, reject) => {
      check = setInterval(() => {
        if (Date.now() - heard < timeout) return;
        source.cancel();
        failure(new Error(`no answer to ${method} for ${timeout / 1000} seconds.`));
        stalled = true;
        synchronized = false;
        resolve(silent);
        connection.dispose();
        void process.dispose();
      }, Math.min(1000, timeout));
      connection.sendRequest(method, params, source.token).then(resolve, reject);
    }).finally(() => { clearInterval(check); linked.dispose(); source.dispose(); }).then(value => { if (value !== silent) heard = Date.now(); return value; });
  }
  async function renameRequest(method, document, position, token, newName) {
    if (!enabled()) throw new Error('Enable workspace analysis to rename safely across files.');
    if (disposed || token.isCancellationRequested) return;
    const version = document.version, owned = documentIdentity(document), began = closeCount;
    await start();
    if (disposed || token.isCancellationRequested) return;
    const response = await ask(method, {
      textDocument: { uri: document.uri.toString() },
      position: { line: position.line, character: position.character },
      ...(newName === undefined ? {} : { newName })
    }, token).catch(error => {
      if (!disposed && !token.isCancellationRequested) throw error;
    });
    if (disposed || token.isCancellationRequested) return;
    if (response === silent) throw new Error('The workspace index stopped answering. Run Racket: Restart Language Server.');
    if (version !== document.version ||
        identities.get(document) !== owned || document.isClosed ||
        !vscode.workspace.textDocuments.includes(document) ||
        !(response.documentChanges || []).every(change => editable(change, began))) {
      throw new Error('Workspace changed during rename. Try Rename again.');
    }
    return response;
  }
  // An edit stands while each file holds what was analysed: an open document at
  // the version named and open since the rename began, or for the text on disk, no
  // buffer that differs from it. A version number restarts when a document reopens.
  // A document that merely opened, unchanged, leaves the edit standing. Disk,
  // settings and folder events read before the answer are the server's to absorb:
  // it starts again, and answers from the new sources or refuses.
  function editable({ textDocument: { uri, version } }, began) {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri && !document.isClosed);
    return version === null ? !open?.isDirty : open?.version === version && !(closes.get(uri) > began);
  }
  // The process is ended either way, so a server slow to close its engine
  // holds up restarting language tools only briefly.
  async function stopServer() {
    let timer;
    const stopped = connection.sendRequest('shutdown').then(() => connection.sendNotification('exit'));
    await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]).catch(() => {});
    clearTimeout(timer);
  }
  async function navigation(operation, document, position, options, token, next) {
    const args = options === undefined ? [document, position, token] : [document, position, options, token];
    if (!isSource(document)) return next(...args);
    if (disposed || token.isCancellationRequested) return [];
    const version = document.version, owned = documentIdentity(document);
    const fresh = () => !disposed && !token.isCancellationRequested && version === document.version &&
      identities.get(document) === owned && !document.isClosed && vscode.workspace.textDocuments.includes(document);
    try {
      await start();
      if (!fresh()) return [];
      // Flush an edit that arrived before its change event.
      if (versions.get(document) !== document.version) didChange(document);
      const params = options === undefined
        ? code2ProtocolConverter.asTextDocumentPositionParams(document, position)
        : code2ProtocolConverter.asReferenceParams(document, position, options);
      const result = await ask(`textDocument/${operation}`, params, token);
      if (!fresh()) return [];
      if (result === silent) return next(...args);
      if (result === null) return next(...args);
      const converted = await (operation === 'documentHighlight' ? protocol2CodeConverter.asDocumentHighlights(result, token)
        : operation === 'definition' ? protocol2CodeConverter.asDefinitionResult(result, token)
        : protocol2CodeConverter.asReferences(result, token));
      return fresh() ? converted : [];
    } catch (error) {
      if (disposed || token.isCancellationRequested || [-32800, -32801].includes(error.code)) return [];
      if (error.code === -32803 || error.refused) onStatus({ state: 'refused', message: error.message });
      else failure(error);
      throw error;
    }
  }
  return {
    start, refresh,
    cancelStart: () => process.cancelStart(),
    async prepareRename(document, position, token, next) {
      if (document.uri.scheme !== 'file' || !isSource(document)) return next(document, position, token);
      const result = await renameRequest('textDocument/prepareRename', document, position, token);
      return result && range(result);
    },
    async provideRenameEdits(document, position, newName, token, next) {
      if (document.uri.scheme !== 'file' || !isSource(document)) return next(document, position, newName, token);
      const result = await renameRequest('textDocument/rename', document, position, token, newName);
      if (!result) return;
      const edit = new vscode.WorkspaceEdit();
      for (const { textDocument: { uri }, edits } of result.documentChanges) {
        edit.set(vscode.Uri.parse(uri), edits.map(change => new vscode.TextEdit(range(change.range), change.newText)));
      }
      return edit;
    },
    provideDefinition: (document, position, token, next) =>
      navigation('definition', document, position, undefined, token, next),
    provideDocumentHighlights: (document, position, token, next) =>
      navigation('documentHighlight', document, position, undefined, token, next),
    provideReferences: (document, position, options, token, next) =>
      navigation('references', document, position, options, token, next),
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
