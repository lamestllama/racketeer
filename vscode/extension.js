// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { createProgramTerminal } = require('./terminal');
const { registerLanguageTools } = require('./language-client');
const { debuggerArgs } = require('./language-process');
const { registerFileCommands } = require('./commands');
const { registerDebugActions } = require('./debug-actions');
const { registerDebugImages } = require('./debug-images');
const { registerDebugSources } = require('./debug-sources');
const { registerSessions } = require('./sessions');
const { registerTesting } = require('./testing');
const { registerDebugRepl } = require('./debug-repl');
const { registerInteractions } = require('./interactions');
const { registerFileRuns } = require('./file-runs');
const { registerPackages } = require('./packages');
const { registerApplicationBuilds } = require('./application-builds');
const { registerApplicationLogs, filterError } = require('./application-logs');
const { registerWxmeViewer } = require('./wxme-viewer');
const { registerWxmeEditor } = require('./wxme-editor');
const { registerDependencies } = require('./dependencies');
let languageTools;

function activate(context) {
  const sessions = registerSessions(context);
  const testing = registerTesting(context, sessions);
  registerPackages(context);
  registerApplicationBuilds(context);
  registerApplicationLogs(context);
  registerWxmeViewer(context);
  registerWxmeEditor(context);
  registerDependencies(context);
  const images = registerDebugImages(context);
  const interactions = registerInteractions(context, images);
  registerFileCommands(context, sessions, testing, registerDebugRepl(sessions, interactions), registerFileRuns(sessions, interactions));
  const debugSources = registerDebugSources(context);
  registerDebugActions(context, debugSources);
  languageTools = registerLanguageTools(context, debugSources);
  const provider = {
    provideDebugConfigurations() {
      return [{ type: 'racketdap', request: 'launch', name: 'Debug Racket file', program: '${file}', stopOnEntry: true }];
    },
    resolveDebugConfiguration(folder, config) {
      if (!config.type && !config.request && !config.name) {
        config = { type: 'racketdap', request: 'launch', name: 'Debug Racket file', program: '${file}', stopOnEntry: true };
      }
      return config;
    },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
      if (!vscode.workspace.isTrusted) return undefined;
      if (!['launch', 'attach'].includes(config.request)) {
        vscode.window.showErrorMessage('Racket DAP supports launch and attach sessions.');
        return undefined;
      }
      if (config.request === 'launch' && (!config.program || !fs.existsSync(config.program) || !fs.statSync(config.program).isFile())) {
        vscode.window.showErrorMessage('Choose an existing Racket source file to debug.');
        return undefined;
      }
      if (config.request === 'launch') config.cwd ||= folder?.uri.fsPath || path.dirname(config.program);
      config.sourceRoots ||= folder ? [folder.uri.fsPath] : config.request === 'launch' ? [path.dirname(config.program)] : [];
      config.debugPackages ??= vscode.workspace.getConfiguration('racketdap', folder?.uri).get('debug.packages', []);
      config.logFilter ??= vscode.workspace.getConfiguration('racketdap', folder?.uri).get('logs.filter', 'error');
      config.debugCache ??= vscode.workspace.getConfiguration('racketdap', folder?.uri).get('debug.compiledCache', true);
      if (context.globalStorageUri) config.debugCacheDirectory ??= path.join(context.globalStorageUri.fsPath, 'debug-cache');
      const invalidFilter = filterError(config.logFilter);
      if (invalidFilter) { void vscode.window.showErrorMessage(invalidFilter); return undefined; }
      config.args ||= [];
      config.racketExecutable ||= vscode.workspace.getConfiguration('racketdap', folder?.uri).get('racketExecutable', 'racket');
      try {
        const { stdout } = await execute(config.racketExecutable, ['--version'], { timeout: 5000, windowsHide: true });
        const version = /v(\d+)\.(\d+)/.exec(stdout);
        if (!version || Number(version[1]) < 9 || (Number(version[1]) === 9 && Number(version[2]) < 1)) {
          throw new Error('Racket 9.1 or newer is required.');
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Cannot start Racket DAP: ${error.message} Set racketdap.racketExecutable to your Racket executable.`,
          'Open Settings').then(action => {
          if (action === 'Open Settings') return vscode.commands.executeCommand('workbench.action.openSettings', '@id:racketdap.racketExecutable');
        });
        return undefined;
      }
      return config;
    }
  };
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('racketdap', provider),
    vscode.debug.registerDebugAdapterDescriptorFactory('racketdap', {
      createDebugAdapterDescriptor(session) {
        return new vscode.DebugAdapterExecutable(session.configuration.racketExecutable,
          debuggerArgs(context, 'main.rkt'));
      }
    }),
    vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
      createDebugAdapterTracker(session) {
        if (session.configuration.console !== 'integratedTerminal' || session.configuration.racketdapRichInteractions) return undefined;
        const terminal = createProgramTerminal(session);
        context.subscriptions.push(terminal);
        return {
          onDidSendMessage(message) {
            if (message.type !== 'event') return;
            if (message.event === 'racketdap/terminalOutput') terminal.output(message.body.output);
            if (message.event === 'terminated') terminal.end();
          }
        };
      }
    }),
    vscode.commands.registerCommand('racketdap.cancelEvaluation', async () => {
      const session = vscode.debug.activeDebugSession;
      if (!session || session.type !== 'racketdap') {
        vscode.window.showInformationMessage('Start a Racket debug session first.');
        return;
      }
      try {
        const response = await session.customRequest('racketdap/cancelEvaluation');
        if (!response.cancelled) vscode.window.showInformationMessage('No Racket evaluation is running.');
      } catch (error) { vscode.window.showErrorMessage(error.message); }
    })
  );
  return { languageServerReady: () => languageTools.whenReady() };
}
async function deactivate() {
  await languageTools?.dispose();
}
module.exports = { activate, deactivate };
