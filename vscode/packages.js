// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { racoTask, runTask } = require('./raco-task');
const execute = promisify(execFile);

// Shared task ownership keeps package commands and Test Explorer cancellation aligned.
async function runPackageTask(selected, label, args, token) {
  return runTask(racoTask(selected, label, args), token);
}

function registerPackages(context) {
  async function target() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    let folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      const folders = vscode.workspace.workspaceFolders || [];
      folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    }
    if (!folder) return undefined;
    return {
      folder, cwd: folder.uri.fsPath,
      executable: vscode.workspace.getConfiguration('racketdap', folder.uri).get('racketExecutable', 'racket')
    };
  }
  async function inventory(selected) {
    const { stdout } = await execute(selected.executable,
      [context.asAbsolutePath('runtime/racketdap/packages.rkt'), 'list'],
      { cwd: selected.cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  }
  async function choosePackage(selected, title, name, { userOnly = false, updatableOnly = false } = {}) {
    let packages = (await inventory(selected)).filter(pkg => !userOnly || pkg.scope === 'user');
    const directoryLink = pkg => ['link', 'static-link'].includes(pkg.sourceType);
    if (name !== undefined) {
      const found = packages.find(pkg => pkg.name === name);
      if (!found) throw new Error(`Package ${name} is not installed${userOnly ? ' in user scope' : ''}.`);
      if (updatableOnly && directoryLink(found)) {
        throw new Error(`Package ${name} is a directory link. Edit its source, then use Racket: Build Package.`);
      }
      return found;
    }
    if (updatableOnly) packages = packages.filter(pkg => !directoryLink(pkg));
    if (!packages.length) {
      void vscode.window.showInformationMessage(updatableOnly
        ? 'No user packages can be updated by name. For directory links, edit the source and use Racket: Build Package.'
        : 'No packages are available for this operation.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(packages.map(pkg => ({
      label: pkg.name, description: `${pkg.scope}${pkg.linked ? ' · linked' : ''}`, detail: pkg.directory, pkg
    })), { title, matchOnDescription: true, matchOnDetail: true });
    return choice?.pkg;
  }
  async function task(selected, label, args, changesPackages = false) {
    const result = await runPackageTask(selected, label, args);
    if (result.exitCode !== 0) throw new Error(`${label} did not complete successfully; see its task terminal.`);
    if (changesPackages) {
      try { await vscode.commands.executeCommand('racketdap.restartLanguageServer'); }
      catch (error) {
        void vscode.window.showWarningMessage(`Package change succeeded, but language analysis could not restart: ${error.message}`);
      }
    }
    return result;
  }
  const actions = {
    async listPackages(selected) { return inventory(selected); },
    async installPackage(selected, source) {
      source ??= await vscode.window.showInputBox({ title: 'Install Racket Package (user scope)',
        prompt: 'Package name, Git URL, archive, or local directory; dependencies are resolved by raco pkg.' });
      if (!source?.trim()) return;
      return task(selected, 'Install Racket package', ['pkg', 'install', '--scope', 'user', '--auto', '--', source.trim()], true);
    },
    async linkPackage(selected, uri) {
      uri ??= (await vscode.window.showOpenDialog({ title: 'Link Racket Package (user scope)',
        defaultUri: selected.folder.uri, canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Link Package' }))?.[0];
      if (!uri) return;
      if (uri.scheme !== 'file') throw new Error('Choose a local package directory.');
      return task(selected, `Link ${path.basename(uri.fsPath)}`,
        ['pkg', 'install', '--scope', 'user', '--auto', '--link', '--', uri.fsPath], true);
    },
    async updatePackage(selected, request) {
      const name = typeof request === 'string' ? request : request?.name;
      const pkg = await choosePackage(selected, 'Update Racket Package (user scope)', name,
        { userOnly: true, updatableOnly: true });
      if (!pkg) return;
      let source = typeof request === 'object' ? request?.source : undefined;
      if (source === undefined && ['file', 'dir'].includes(pkg.sourceType)) {
        source = await vscode.window.showInputBox({ title: `Update ${pkg.name}`,
          prompt: 'This package was installed locally. Enter the replacement archive or directory.' });
        if (!source?.trim()) return;
      }
      if (source !== undefined && !source.trim()) return;
      return task(selected, `Update ${pkg.name}`,
        ['pkg', 'update', '--scope', 'user', '--deps', 'search-auto',
          ...(source === undefined ? ['--', pkg.name] : ['--name', pkg.name, '--', source.trim()])], true);
    },
    async removePackage(selected, name) {
      const pkg = await choosePackage(selected, 'Remove Racket Package (user scope)', name, { userOnly: true });
      if (pkg) return task(selected, `Remove ${pkg.name}`, ['pkg', 'remove', '--scope', 'user', '--', pkg.name], true);
    },
    async testPackage(selected, name) {
      const pkg = await choosePackage(selected, 'Test Racket Package', name);
      if (pkg) return task(selected, `Test package ${pkg.name}`, ['test', '--package', '--timeout', '+inf.0', '--', pkg.name]);
    },
    async setupPackage(selected, name) {
      const pkg = await choosePackage(selected, 'Build Racket Package', name, { userOnly: true });
      if (pkg) return task(selected, `Build package ${pkg.name}`, ['setup', '--pkgs', pkg.name]);
    },
    async openPackage(selected, name) {
      const pkg = await choosePackage(selected, 'Open Racket Package Source', name);
      if (pkg) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(pkg.directory), true);
    },
    async selectDebugPackages(selected) {
      const settings = vscode.workspace.getConfiguration('racketdap', selected.folder.uri);
      const current = settings.get('debug.packages', []);
      const choices = (await inventory(selected)).map(pkg => ({
        label: pkg.name, description: pkg.scope, detail: pkg.directory, picked: current.includes(pkg.name)
      }));
      const chosen = await vscode.window.showQuickPick(choices,
        { title: 'Packages to Debug', canPickMany: true, matchOnDescription: true, matchOnDetail: true });
      if (chosen) await settings.update('debug.packages', chosen.map(pkg => pkg.label), vscode.ConfigurationTarget.WorkspaceFolder);
    }
  };
  actions.managePackages = async selected => {
    const choices = [
      ['Install package', 'installPackage'], ['Link local package', 'linkPackage'],
      ['Update package', 'updatePackage'], ['Remove package', 'removePackage'],
      ['Test package', 'testPackage'], ['Build package', 'setupPackage'],
      ['Open package source', 'openPackage'], ['Choose packages to debug', 'selectDebugPackages']
    ].map(([label, action]) => ({ label, action }));
    const choice = await vscode.window.showQuickPick(choices, { title: 'Racket Packages' });
    if (choice) return actions[choice.action](selected);
  };
  for (const [name, action] of Object.entries(actions)) {
    context.subscriptions.push(vscode.commands.registerCommand(`racketdap.${name}`, async argument => {
      if (!vscode.workspace.isTrusted) return undefined;
      const selected = await target();
      if (!selected) return undefined;
      try { return await action(selected, argument); }
      catch (error) { void vscode.window.showErrorMessage(`Racket packages: ${error.message}`); throw error; }
    }));
  }
}

module.exports = { registerPackages, runPackageTask };
