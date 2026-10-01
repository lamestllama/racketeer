'use strict';
const vscode = require('vscode');
const { LanguageClient, State, CloseAction } = require('vscode-languageclient/node');
const { createLanguageProcess } = require('./language-process');
const { createWorkspaceIndex } = require('./workspace-index');

const languageIds = ['racket', 'rhombus'];
const isLanguageDocument = document => languageIds.includes(document?.languageId);
// The server's formatter selection is shared by both languages. Its default
// S-expression formatter is unsafe for indentation-sensitive shrubbery. Keep
// Rhombus on the declarative indentation rules until a reader-aware formatter
// has been validated; this also guards range and on-type formatting requests.
const racketFormattingOnly = (document, ...args) => document.languageId === 'rhombus'
  ? [] : args.pop()(document, ...args);

function registerLanguageTools(context, debugSources) {
  const output = vscode.window.createOutputChannel('Racket Language Server');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'racketdap.showLanguageServerOutput';
  let client;
  let index;
  let stateListener;
  let server;
  let scheduled = 0;
  let pending = Promise.resolve();
  let disposed = false;

  function showStatus(text, detail) {
    status.text = text;
    status.tooltip = detail;
    if (isLanguageDocument(vscode.window.activeTextEditor?.document)) status.show();
    else status.hide();
  }

  async function stopClient() {
    debugSources.setLanguageClient(undefined);
    await index?.dispose();
    index = undefined;
    stateListener?.dispose();
    stateListener = undefined;
    if (client) {
      const previous = client;
      client = undefined;
      server = undefined;
      await previous.dispose();
    }
  }

  async function restart() {
    await stopClient();
    if (disposed || !vscode.workspace.isTrusted) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const config = vscode.workspace.getConfiguration('racketdap', folder?.uri);
    if (!config.get('languageServer.enabled', true)) {
      showStatus('Racket: LSP off', 'Enable racketdap.languageServer.enabled for editor language tools.');
      return;
    }
    // Both extensions would otherwise register the same completion, formatting,
    // and diagnostic providers. Leave the existing client under user control.
    if (vscode.extensions.getExtension('evzen-wybitul.magic-racket') &&
        vscode.workspace.getConfiguration('magicRacket').get('languageServer.enabled', true)) {
      output.appendLine('Magic Racket is enabled. Disable it to use this extension’s bundled language server.');
      showStatus('Racket: external LSP', 'Magic Racket is enabled. Disable it and reload to use the bundled language server.');
      return;
    }
    const installed = config.get('languageServer.source', 'bundled') === 'installed';
    const configuredTimeout = config.get('languageServer.startupTimeoutSeconds', 180);
    const startupTimeoutSeconds = Number.isInteger(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= 3600
      ? configuredTimeout : 180;
    function reportFailure(error, advice = 'Check racketdap.racketExecutable.', setting = 'racketdap.racketExecutable') {
      output.appendLine(String(error.stack || error));
      output.appendLine(advice);
      showStatus('$(warning) Racket', 'Language server failed. Click for details. Debugging and file commands remain available.');
      void vscode.window.showErrorMessage(
        `Racket language server could not start: ${error.message} ${advice}`,
        'Open Settings', 'Show Output').then(action => {
        if (action === 'Open Settings') return vscode.commands.executeCommand('workbench.action.openSettings', `@id:${setting}`);
        if (action === 'Show Output') output.show();
      });
    }
    const process = createLanguageProcess(config.get('racketExecutable', 'racket'),
      installed ? ['-l', 'racket-langserver'] : [context.asAbsolutePath('language-server.rkt')],
      { cwd: folder?.uri.fsPath }, {
        timeout: startupTimeoutSeconds * 1000,
        onTimeout: error => reportFailure(error,
          'Cold startup or a busy machine may need more time. Increase racketdap.languageServer.startupTimeoutSeconds, then run Racket: Restart Language Server.',
          'racketdap.languageServer.startupTimeoutSeconds')
      });
    server = process;
    class OwnedLanguageClient extends LanguageClient {
      async start() {
        this.handlesStartupErrors = true;
        try {
          await super.start();
          this.handlesStartupErrors = false;
        }
        catch (error) {
          if (!process.cancelled && !disposed) reportFailure(error);
          throw error;
        }
      }
      error(message, data, showNotification) {
        // Own startup notifications until success, including failed restart logs.
        super.error(message, data, this.handlesStartupErrors || process.cancelled || disposed ? false : showNotification);
      }
      stop(timeout) {
        // The SDK also invokes stop after initialization fails. There is no
        // running LSP connection to shut down in that state; our process and
        // transports can still be released through their own lifecycle.
        this.stopping ||= (async () => {
          try { if (this.isRunning()) await super.stop(timeout); }
          finally {
            await process.dispose();
            this.diagnostics?.dispose();
          }
        })().finally(() => { this.stopping = undefined; });
        return this.stopping;
      }
    }
    let defaultErrorHandler;
    const next = new OwnedLanguageClient('racketDevelopment', 'Racket Language Server', () => process.start(), {
      // The upstream server resolves documents as filesystem paths. Save new
      // documents before requesting semantic analysis.
      documentSelector: languageIds.map(language => ({ language, scheme: 'file' })),
      middleware: {
        provideDocumentFormattingEdits: racketFormattingOnly,
        provideDocumentRangeFormattingEdits: racketFormattingOnly,
        provideDocumentRangesFormattingEdits: racketFormattingOnly,
        provideOnTypeFormattingEdits: racketFormattingOnly,
        provideReferences: (...args) => nextIndex.provideReferences(...args)
      },
      outputChannel: output,
      initializationFailedHandler(error) {
        if (!process.cancelled && !disposed) reportFailure(error);
        return false;
      },
      errorHandler: {
        error: (...args) => defaultErrorHandler.error(...args),
        closed: () => process.cancelled || disposed
          ? { action: CloseAction.DoNotRestart, handled: true }
          : defaultErrorHandler.closed()
      },
      synchronize: {
        configurationSection: 'racket-langserver'
      }
    });
    defaultErrorHandler = next.createDefaultErrorHandler();
    client = next;
    const nextIndex = createWorkspaceIndex(context, {
      executable: config.get('racketExecutable', 'racket'), timeout: startupTimeoutSeconds * 1000, output,
      onStatus: result => {
        if (client !== next) return;
        if (result.state === 'indexing') {
          showStatus('$(sync~spin) Racket: indexing',
            `Finding workspace references: ${result.indexed} files analysed. Reference requests wait for this pass.`);
        } else if (result.state === 'partial') {
          showStatus('$(warning) Racket: partial references',
            'Some files could not be analysed or an indexing limit was reached. References may be incomplete. See Language Server Output; run Racket: Refresh Workspace References to retry.');
        } else if (result.state === 'failed') {
          showStatus('$(warning) Racket: index stopped',
            'Workspace references are unavailable. See Language Server Output and restart language tools.');
        } else {
          showStatus('Racket: ready', result.state === 'disabled'
            ? 'Background analysis is disabled. References are supplied by the language server.'
            : `Workspace reference analysis finished: ${result.indexed} files analysed.`);
        }
      }
    });
    index = nextIndex;
    stateListener = next.onDidChangeState(event => {
      if (client !== next) return;
      if (event.newState === State.Running) {
        process.ready();
        showStatus('Racket: ready', `${installed ? 'Installed' : 'Bundled'} racket-langserver for Racket and Rhombus. Rhombus requires rhombus-lib in the selected Racket installation.`);
      }
      if (event.newState === State.Stopped) showStatus('Racket: LSP stopped', 'Run Racket: Restart Language Server. See output for details.');
    });
    showStatus('$(sync~spin) Racket', 'Starting Racket language tools. Loading source packages can take longer on the first run or a busy machine.');
    try { await next.start(); }
    catch { return; } // The client has already reported the startup failure.
    if (!process.cancelled && !disposed && next.isRunning()) {
      debugSources.setLanguageClient(next, (...args) => nextIndex.provideReferences(...args));
      await nextIndex.start().catch(error => output.appendLine(`Workspace index: ${error.message}`));
    }
  }

  function scheduleRestart() {
    server?.cancelStart();
    index?.cancelStart();
    scheduled++;
    const request = pending.then(restart);
    // Keep the queue usable after failure and handle background requests;
    // command callers still receive the original request's rejection.
    pending = request.catch(error => output.appendLine(String(error.stack || error)))
      .finally(() => { scheduled--; });
    return request;
  }

  context.subscriptions.push(output, status,
    vscode.commands.registerCommand('racketdap.restartLanguageServer', scheduleRestart),
    vscode.commands.registerCommand('racketdap.showLanguageServerOutput', () => output.show()),
    vscode.commands.registerCommand('racketdap.refreshWorkspaceReferences', async () => {
      await pending;
      if (!client?.isRunning()) return;
      index?.refresh();
    }),
    vscode.workspace.onDidOpenTextDocument(document => {
      if (isLanguageDocument(document) && !client && !scheduled) void scheduleRestart();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => showStatus(status.text, status.tooltip)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('racketdap.racketExecutable') ||
          event.affectsConfiguration('racketdap.languageServer') ||
          event.affectsConfiguration('magicRacket.languageServer.enabled')) void scheduleRestart();
    })
  );
  if (vscode.workspace.textDocuments.some(isLanguageDocument)) void scheduleRestart();
  return {
    whenReady: () => pending,
    async dispose() {
      disposed = true;
      server?.cancelStart();
      index?.cancelStart();
      await pending.catch(() => {});
      await stopClient();
    }
  };
}

module.exports = { registerLanguageTools };
