'use strict';
const path = require('node:path');
const vscode = require('vscode');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-languageclient/node');
const { createLanguageProcess } = require('./language-process');

const isSource = document => document.uri.scheme === 'file' && ['racket', 'rhombus'].includes(document.languageId);
const excludedDefaults = ['.git', 'compiled', 'node_modules', '.test-output', 'dist', 'build'];

// The index has its own document snapshots and transport. It never sends fake
// document opens to the language server or consumes the server's live traces.
function createWorkspaceIndex(context, { executable, timeout, output, onStatus }) {
  let connection, starting, disposed = false, requested = false, synchronized = false;
  let revision = 0, identity = 0;
  const identities = new WeakMap();
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
  const process = createLanguageProcess(executable, [context.asAbsolutePath('workspace-index-server.rkt')],
    { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath },
    { timeout, name: 'Workspace index', onTimeout: failure });
  function snapshot() {
    return {
      revision, settings: settings(),
      roots: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()),
      documents: vscode.workspace.textDocuments.filter(document => isSource(document) && !document.isClosed).map(document => ({
        uri: document.uri.toString(), identity: documentIdentity(document),
        version: document.version, text: document.getText()
      }))
    };
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
      connection.onNotification('status', onStatus);
      connection.onError(([error]) => failure(error));
      connection.onClose(() => {
        synchronized = false;
        if (!disposed) failure(new Error('Process stopped. Run Racket: Restart Language Server to restart language tools.'));
      });
      connection.listen();
      await connection.sendRequest('initialize', snapshot());
      if (disposed) return;
      process.ready();
      synchronized = true;
      refresh(); // Include edits made while the process was initializing.
    })();
    return starting;
  }
  function refresh() {
    if (disposed) return;
    revision++;
    if (synchronized) void connection.sendNotification('update', snapshot()).catch(failure);
    else if (requested && enabled()) void start().catch(failure);
  }
  function relevant(uri) {
    if (uri.scheme !== 'file') return false;
    const excluded = settings().excludedDirectories || excludedDefaults;
    return (vscode.workspace.workspaceFolders || []).some(folder => {
      const relative = path.relative(folder.uri.fsPath, uri.fsPath);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
        !relative.split(path.sep).some(part => excluded.includes(part));
    });
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const changedFile = uri => { if (relevant(uri)) refresh(); };
  const subscriptions = [watcher,
    watcher.onDidCreate(changedFile), watcher.onDidChange(changedFile), watcher.onDidDelete(changedFile),
    vscode.workspace.onDidOpenTextDocument(document => { if (isSource(document)) refresh(); }),
    vscode.workspace.onDidChangeTextDocument(event => { if (isSource(event.document)) refresh(); }),
    vscode.workspace.onDidCloseTextDocument(document => {
      identities.delete(document);
      if (isSource(document)) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidRenameFiles(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('racket-langserver.workspaceAnalysis')) refresh();
    })
  ];
  const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
  async function renameRequest(method, document, position, token, newName) {
    if (!enabled()) throw new Error('Enable workspace analysis to rename safely across files.');
    if (disposed || token.isCancellationRequested) return;
    const version = document.version, owned = documentIdentity(document);
    await start();
    if (disposed || token.isCancellationRequested) return;
    const response = await connection.sendRequest(method, {
      uri: document.uri.toString(), identity: owned, version,
      position: { line: position.line, character: position.character },
      ...(newName === undefined ? {} : { newName })
    }, token).catch(error => {
      if (!disposed && !token.isCancellationRequested) throw error;
    });
    if (disposed || token.isCancellationRequested) return;
    if (response.revision !== revision || version !== document.version ||
        identities.get(document) !== owned || document.isClosed ||
        !vscode.workspace.textDocuments.includes(document)) {
      throw new Error('Workspace changed during rename. Try Rename again.');
    }
    return response.result;
  }
  return {
    start, refresh,
    cancelStart: () => process.cancelStart(),
    async prepareRename(document, position, token) {
      const result = await renameRequest('prepareRename', document, position, token);
      return result && range(result);
    },
    async provideRenameEdits(document, position, newName, token) {
      const result = await renameRequest('rename', document, position, token, newName);
      if (!result) return;
      const edit = new vscode.WorkspaceEdit();
      for (const [uri, changes] of Object.entries(result.changes)) {
        edit.set(vscode.Uri.parse(uri), changes.map(change => new vscode.TextEdit(range(change.range), change.newText)));
      }
      return edit;
    },
    async provideReferences(document, position, options, token, next) {
      if (!enabled()) return next(document, position, options, token);
      if (disposed || token.isCancellationRequested) return [];
      const version = document.version, owned = documentIdentity(document);
      try {
        await start();
        if (disposed || token.isCancellationRequested) return [];
        const locations = await connection.sendRequest('references', {
          uri: document.uri.toString(), identity: owned, version,
          position: { line: position.line, character: position.character },
          includeDeclaration: options.includeDeclaration
        }, token);
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
      connection?.dispose();
      await process.dispose();
      await starting?.catch(() => {});
    }
  };
}

module.exports = { createWorkspaceIndex };
