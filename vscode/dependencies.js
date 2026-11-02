// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const { selectedEditor } = require('./selected-editor');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { requestDependencies } = require('./dependency-process');

const moduleKey = node => JSON.stringify([node.path, node.submodules]);
const phaseLabel = phase => phase === null ? 'label phase' : phase === 0 ? 'phase 0' : `phase ${phase > 0 ? '+' : ''}${phase}`;
const isSource = doc => doc.uri.scheme === 'file' && ['racket', 'rhombus'].includes(doc.languageId) && !doc.isClosed;

class DependencyProvider {
  constructor(context, request = requestDependencies) {
    this.context = context; this.request = request; this.generation = 0; this.watchers = new Map();
    this.changed = new vscode.EventEmitter(); this.onDidChangeTreeData = this.changed.event;
  }
  refresh(file = this.file) {
    this.controller?.abort(new Error('Dependency view changed.'));
    this.controller = new AbortController(); this.generation++;
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear(); this.files = new Set(); this.cache = new Map();
    this.file = file; this.root = undefined; this.captureError = undefined;
    if (file && !this.disposed && vscode.workspace.isTrusted) {
      try {
        this.buffers = vscode.workspace.textDocuments.filter(isSource).map(doc => ({ path: doc.uri.fsPath, text: doc.getText() }));
        if (this.buffers.reduce((size, doc) => size + Buffer.byteLength(doc.text), 0) > 32 * 1024 * 1024) throw new Error('Open Racket buffers exceed 32 MiB.');
        this.roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
        if (!this.roots.some(root => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) this.roots.push(path.dirname(file));
        this.executable = vscode.workspace.getConfiguration('racketdap', vscode.Uri.file(file)).get('racketExecutable', 'racket');
        this.root = this.node({ path: file, name: path.basename(file), submodules: [] });
        this.watch([file]);
      } catch (error) { this.captureError = error.message; }
    }
    this.changed.fire();
  }
  watch(files) {
    for (const file of files) {
      this.files.add(file);
      const directory = path.dirname(file);
      if (this.watchers.has(directory)) continue;
      // Watch containing directories so atomic replacement and recreation are
      // observed, including dependencies outside workspace roots.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
      const changed = uri => { if (this.files.has(uri.fsPath)) this.invalidate(); };
      watcher.onDidCreate(changed); watcher.onDidChange(changed); watcher.onDidDelete(changed);
      this.watchers.set(directory, watcher);
    }
  }
  invalidate() {
    if (!this.file || this.disposed) return;
    this.controller?.abort(new Error('Dependency source changed.'));
    this.generation++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 250);
  }
  node(reference, parent, declaration = false) {
    const key = moduleKey(reference), ancestors = parent ? [...parent.ancestors, moduleKey(parent)] : [];
    const route = [...(parent?.route || []), [declaration ? 'submodule' : 'import', key, reference.phase]];
    return { ...reference, parent, declaration, ancestors, cycle: ancestors.includes(key), generation: this.generation,
      route, id: JSON.stringify(route) };
  }
  message(text, parent) { return { message: text, parent, id: `${parent?.id || 'root'}:message` }; }
  getParent(node) { return node.parent; }
  getTreeItem(node) {
    if (node.message) { const item = new vscode.TreeItem(node.message); item.id = node.id; item.tooltip = node.message; return item; }
    const label = node.submodules.length ? `${node.name} › ${node.submodules.join(' › ')}` : node.name;
    const item = new vscode.TreeItem(label, node.path && !node.cycle
      ? (node.parent ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
      : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = [node.declaration ? 'submodule' : node.parent ? phaseLabel(node.phase) : '', node.cycle ? 'already in this branch' : ''].filter(Boolean).join(' · ');
    item.tooltip = [node.path || 'Built-in module', node.submodules.length ? `Submodule: ${node.submodules.join(' / ')}` : '',
      node.parent && !node.declaration ? `Import ${phaseLabel(node.phase)} relative to its parent module.` : ''].filter(Boolean).join('\n');
    item.iconPath = new vscode.ThemeIcon(node.declaration ? 'symbol-namespace' : 'file-code');
    if (node.path) {
      item.resourceUri = vscode.Uri.file(node.path);
      item.command = { command: 'vscode.open', title: 'Open Module Source', arguments: [item.resourceUri] };
    }
    return item;
  }
  async getChildren(node) {
    if (this.disposed || !vscode.workspace.isTrusted) return [];
    if (!node) return this.captureError ? [this.message(this.captureError)] : this.root ? [this.root] : [];
    if (node.message || !node.path || node.cycle || node.generation !== this.generation) return [];
    const generation = this.generation;
    try {
      let pending = this.cache.get(node.path);
      if (!pending) {
        if (this.cache.size >= 200) throw new Error('Dependency view reached 200 files. Browse a selected module as a new root.');
        const request = { version: 1, path: node.path, buffers: this.buffers, roots: this.roots }, signal = this.controller.signal;
        pending = (this.work || Promise.resolve()).then(() => {
          if (signal.aborted) throw signal.reason;
          return this.request(this.executable, this.context.asAbsolutePath('runtime/racketdap/tools/dependency-worker.rkt'),
            this.context.asAbsolutePath('language-server/collects'), request, { signal });
        }).then(async result => {
          if (generation !== this.generation || this.disposed) return result;
          this.watch(result.files);
          // Close the gap between the worker's snapshot and installing watches.
          for (const stamp of result.stamps || []) {
            let hash = null;
            try { hash = createHash('sha1').update(await fs.readFile(stamp.path)).digest('hex'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (hash !== stamp.hash) throw new Error(`Source changed during analysis: ${stamp.path}. Refresh the dependency view.`);
          }
          return result;
        });
        this.work = pending.catch(() => {});
        this.cache.set(node.path, pending);
      }
      const result = await pending;
      if (generation !== this.generation || this.disposed) return [];
      const module = result.modules.find(module => JSON.stringify(module.submodules) === JSON.stringify(node.submodules));
      if (!module) throw new Error('This submodule is no longer present. Refresh the dependency view.');
      return [...module.imports.map(edge => this.node(edge, node)),
        ...module.children.map(names => this.node({ path: node.path, name: node.name, submodules: names }, node, true))];
    } catch (error) {
      if (generation !== this.generation || this.disposed) return [];
      return [this.message(error.message, node)];
    }
  }
  dispose() {
    this.disposed = true; this.generation++; clearTimeout(this.timer);
    this.controller?.abort(new Error('Dependency view closed.'));
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear(); this.changed.dispose();
  }
}

function registerDependencies(context) {
  const provider = new DependencyProvider(context);
  const view = vscode.window.createTreeView('racketeer.dependencies', { treeDataProvider: provider, showCollapseAll: true });
  view.message = 'Choose Racket: Browse Module Dependencies. Imports show phase shifts relative to their parent.';
  const browse = async uri => {
    if (!vscode.workspace.isTrusted) return;
    uri ||= selectedEditor(vscode.window)?.document.uri;
    if (!uri || uri.scheme !== 'file') { void vscode.window.showErrorMessage('Open a saved Racket module to browse dependencies. Unsaved edits in named buffers are included.'); return; }
    clearTimeout(provider.timer); provider.refresh(uri.fsPath);
    view.message = 'Includes open Racket buffers. Select a module to open its source; expand it to inspect imports.';
    await vscode.commands.executeCommand('racketeer.dependencies.focus');
    if (provider.root) await view.reveal(provider.root, { select: true, focus: true, expand: true });
  };
  context.subscriptions.push(provider, view,
    vscode.commands.registerCommand('racketdap.browseDependencies', browse),
    vscode.commands.registerCommand('racketdap.refreshDependencies', () => { clearTimeout(provider.timer); provider.refresh(); }),
    vscode.workspace.onDidChangeTextDocument(event => { if (isSource(event.document) && event.contentChanges.length) provider.invalidate(); }),
    vscode.workspace.onDidOpenTextDocument(document => { if (isSource(document)) provider.invalidate(); }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'file' && ['racket', 'rhombus'].includes(document.languageId)) provider.invalidate(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.invalidate()),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('racketdap.racketExecutable')) provider.invalidate(); }));
  return provider;
}
module.exports = { DependencyProvider, registerDependencies, phaseLabel };
