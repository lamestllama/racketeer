'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { activeTarget, targetFor } = require('./execution');
const { buildPlan, executablePath } = require('./application-build');
const { racoTask, runTask } = require('./raco-task');

function buildTask(selected, definition, label) {
  const plan = buildPlan(definition, selected.cwd);
  const task = racoTask({ ...selected, executable: selected.racketExecutable }, label, plan.args,
    definition);
  task.group = vscode.TaskGroup.Build;
  return { task, plan };
}

function registerApplicationBuilds(context) {
  let lastExecutable;
  context.subscriptions.push(vscode.tasks.registerTaskProvider('racket-build', {
    provideTasks: () => [],
    resolveTask(task) {
      if (!vscode.workspace.isTrusted) return undefined;
      if (!task.scope?.uri) throw new Error('A Racket build task needs a workspace folder.');
      const folder = task.scope;
      const selected = { folder, cwd: folder.uri.fsPath,
        racketExecutable: vscode.workspace.getConfiguration('racketdap', folder.uri).get('racketExecutable', 'racket') };
      const result = buildTask(selected, task.definition, task.name).task;
      result.group = task.group || vscode.TaskGroup.Build;
      result.presentationOptions = { ...result.presentationOptions, ...task.presentationOptions };
      result.runOptions = task.runOptions;
      result.problemMatchers = task.problemMatchers;
      result.detail = task.detail;
      return result;
    }
  }));
  async function build(action, request = {}) {
    if (!vscode.workspace.isTrusted) return undefined;
    try {
      let selected;
      if (action === 'distribution') {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const source = request.source ? vscode.Uri.file(request.source) : (await vscode.window.showOpenDialog({
          title: 'Select the Racket executable to distribute', defaultUri: lastExecutable,
          canSelectFiles: true, canSelectFolders: process.platform === 'darwin', canSelectMany: false,
          openLabel: 'Select Executable'
        }))?.[0];
        if (!source) return undefined;
        selected = targetFor(source);
        // Outputs may be outside the workspace. Keep the build tool selected
        // by the source workspace instead of silently falling back to PATH.
        if (!selected.folder) {
          const folders = vscode.workspace.workspaceFolders || [];
          const folder = (activeUri && vscode.workspace.getWorkspaceFolder(activeUri))
            || (folders.length === 1 ? folders[0] : folders.length > 1 ? await vscode.window.showWorkspaceFolderPick() : undefined);
          if (folders.length > 1 && !folder) return undefined;
          if (folder) selected = { ...selected, folder, cwd: folder.uri.fsPath,
            racketExecutable: vscode.workspace.getConfiguration('racketdap', folder.uri).get('racketExecutable', 'racket') };
        }
      } else selected = await activeTarget();
      let gui = request.gui;
      if (action !== 'distribution' && gui === undefined) {
        const mode = await vscode.window.showQuickPick([
          { label: 'Console', description: 'Program with terminal input and output', gui: false },
          { label: 'GUI', description: 'Graphical application using Racket GUI libraries', gui: true }
        ], { title: action === 'launcher' ? 'Create Launcher' : 'Build Executable' });
        if (!mode) return undefined;
        gui = mode.gui;
      }
      const stem = path.basename(selected.program, path.extname(selected.program));
      const suggested = action === 'distribution' ? `${stem}-dist` : executablePath(`${stem}-${action}`, gui);
      const destination = request.output ? vscode.Uri.file(request.output) : await vscode.window.showSaveDialog({
        title: action === 'distribution' ? 'Create Distribution Directory' : action === 'launcher' ? 'Create Launcher' : 'Build Executable',
        saveLabel: action === 'distribution' ? 'Create Distribution' : 'Build',
        defaultUri: vscode.Uri.file(path.join(path.dirname(selected.program), suggested))
      });
      if (!destination) return undefined;
      if (destination.scheme !== 'file') throw new Error('Choose a filesystem output path.');
      const definition = { type: 'racket-build', action, source: selected.program, output: destination.fsPath,
        gui: gui ?? false, libraries: request.libraries, languages: request.languages };
      const label = `${action === 'distribution' ? 'Distribute' : 'Build ' + action} ${path.basename(selected.program)}`;
      const { task, plan } = buildTask(selected, definition, label);
      const result = await runTask(task);
      if (result.exitCode !== 0) throw new Error(`${label} did not complete successfully; see its task terminal.`);
      if (action === 'executable') lastExecutable = vscode.Uri.file(plan.output);
      void vscode.window.showInformationMessage(`Racket ${action} created: ${plan.output}`);
      return { ...result, output: plan.output };
    } catch (error) { void vscode.window.showErrorMessage(`Racket build: ${error.message}`); throw error; }
  }
  for (const [name, action] of [['createLauncher', 'launcher'], ['buildExecutable', 'executable'], ['createDistribution', 'distribution']]) {
    context.subscriptions.push(vscode.commands.registerCommand(`racketdap.${name}`, request => build(action, request)));
  }
}

module.exports = { registerApplicationBuilds, buildTask };
