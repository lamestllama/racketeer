// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Provides the editor host fake, panel lifecycle and deterministic timers.
'use strict';
const { load, helper, tick } = require('./macro-common');
const path = require('node:path');
const Protocol = require('../../vscode/macro-view/protocol');
const Data = require('../../vscode/macro-view-data');
const Model = require('../../vscode/macro-view/model');
const assert = require('node:assert/strict');
const { summaryOf, project, fixtureAnswer } = require('./macro-fixtures');
function fakeStepper({ timeoutMs, timers, stopDelay = false, deferredFocus = false, sources, workerFactory } = {}) {
  class Event {
    callbacks = [];
    event = fn => { this.callbacks.push(fn); return { dispose: () => { this.callbacks = this.callbacks.filter(f => f !== fn); } }; };
    fire(x) { this.callbacks.forEach(f => f(x)); }
  }
  class Uri {
    constructor(scheme, file) { this.scheme = scheme; this.path = file; this.fsPath = file; }
    toString() { return `${this.scheme}:${this.path}`; }
    static file(file) { return new Uri('file', file); }
    static parse(s) { const index = s.indexOf(':'); return new Uri(s.slice(0, index), s.slice(index + 1)); }
    static joinPath(uri, ...parts) { return new Uri(uri.scheme, path.join(uri.path, ...parts)); }
  }
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  class Range {
    constructor(start, end, endLine, endCharacter) {
      if (typeof start === 'number') [start, end] = [new Position(start, end), new Position(endLine, endCharacter)];
      Object.assign(this, { start, end });
    }
  }
  class Selection extends Range {
    constructor(...args) { super(...args); this.active = this.end; this.isEmpty = this.start.line === this.end.line && this.start.character === this.end.character; }
  }
  class Document {
    languageId = 'racket'; version = 1;
    constructor(name) { this.uri = new Uri('untitled', name); this.text = '#lang racket/base\n(define-syntax-rule (m) 42)\n\t(m)\n'; }
    getText() { return this.text; }
    get lineCount() { return this.text.split('\n').length; }
    positionAt(offset) { const lines = this.text.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); }
    offsetAt(p) { return this.text.split('\n').slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character; }
    lineAt(n) { return { range: new Range(n, 0, n, this.text.split('\n')[n].length) }; }
  }
  const change = new Event(), close = new Event(), save = new Event(), editorChange = new Event(), selectionChange = new Event(), themeChange = new Event(), configurationChange = new Event();
  const commands = {}, contexts = {}, pending = [], panels = [], follows = [], decorations = [], clipboard = [], progress = [];
  const debug = {}, executed = [], focusNotifications = [];
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const disposables = [], noop = () => ({ dispose() {} });
  let serializer, token, activeColumn = 1;
  const window = {
    visibleTextEditors: [], activeTextEditor: undefined,
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: editorChange.event, onDidChangeTextEditorSelection: selectionChange.event,
    onDidChangeActiveColorTheme: themeChange.event,
    registerWebviewPanelSerializer(_type, value) { serializer = value; return noop(); },
    withProgress(_options, work) { progress.push(_options); const cancel = new Event(); token = cancel; return work(null, { onCancellationRequested: cancel.event }); },
    showWarningMessage: noop, showInputBox: async () => undefined, showQuickPick: async items => items[0],
    createQuickPick() {
      const accept = new Event(), hide = new Event();
      const picker = { items: [], selectedItems: [], activeItems: [], canSelectMany: false,
        onDidAccept: accept.event, onDidHide: hide.event,
        accept() { accept.fire(); }, hide() { hide.fire(); },
        dispose() { this.disposed = true; },
        show() {
          // Existing chooser fixtures supply a response; picker regressions
          // disable this adapter and drive the actual events and properties.
          if (!window.showQuickPick) return;
          Promise.resolve(window.showQuickPick(this.items, {
            title: this.title, placeHolder: this.placeholder, canPickMany: this.canSelectMany
          })).then(result => {
            if (this.disposed) return;
            if (result === undefined) return this.hide();
            this.selectedItems = this.canSelectMany ? result : [result];
            if (!this.canSelectMany) this.activeItems = [result];
            this.accept();
          });
        }
      };
      return picker;
    },
    async showTextDocument(document, options = {}) {
      const editor = { document, viewColumn: options.viewColumn || 1, selection: new Selection(2, 0, 2, 0),
        setDecorations(_style, ranges) { decorations.push({ document, ranges }); }, revealRange(range) { follows.push({ document, range, options }); } };
      this.visibleTextEditors.push(editor);
      if (!options.preserveFocus) {
        for (const panel of panels) if (panel.active) { panel.active = false; panel.viewState.fire(); }
        this.activeTextEditor = editor; editorChange.fire(editor);
      }
      return editor;
    },
    createWebviewPanel(type, title, column, options) {
      for (const panel of panels) if (panel.active) { panel.active = false; panel.viewState.fire(); }
      const incoming = new Event(), disposed = new Event(), viewState = new Event();
      const p = { type, title, options, viewColumn: column.viewColumn === 2 ? 2 : activeColumn, active: true, visible: true, events: [], incoming, disposed, viewState, messages: [], client: null,
        ack: true, receiver: new Protocol.Receiver(Data.validateProjection), env: null,
        onDidDispose: disposed.event, onDidChangeViewState: viewState.event,
        reveal(_column, preserve) {
          if (!preserve && deferredFocus) {
            window.tabGroups = { activeTabGroup: { viewColumn: p.viewColumn,
              activeTab: { input: new TabInputWebview(p.type), get label() { return p.title; } } } };
            if (deferredFocus !== 'flags') for (const other of panels) other.active = other === p;
            focusNotifications.push(() => {
              for (const other of panels) { other.active = false; other.viewState.fire(); }
              p.active = true; p.visible = true; viewState.fire();
            });
            return;
          }
          if (!preserve) { for (const other of panels) { other.active = false; other.viewState.fire(); } p.active = true; p.visible = true; viewState.fire(); }
        },
        dispose() { if (p.closed) return; p.closed = true; p.active = false; p.visible = false; disposed.fire(); },
        navigationSequence: 0,
        send(type, fields = {}) { incoming.fire({ ...p.env, v: 1, type, requestId: `fake${p.messages.length}`,
          ...(type === 'navigate' ? { clientInstanceId: p.client || 'client', navigationSequence: ++p.navigationSequence } : {}), ...fields }); },
        webview: { cspSource: 'local:', asWebviewUri: x => x.toString(), onDidReceiveMessage: fn => { p.events.push('listener'); return incoming.event(fn); },
          async postMessage(m) {
            p.messages.push(m);
            if (m.type === 'init') p.env = { sessionId: m.sessionId, generation: m.generation, positionRevision: m.positionRevision };
            if (p.env && m.positionRevision > p.env.positionRevision) p.env.positionRevision = m.positionRevision;
            const ack = sequence => { if (p.ack) queueMicrotask(() => p.send('transferAck', { transferId: m.transferId, lastSequence: sequence, success: true })); };
            if (m.type === 'positionBegin') ack(p.receiver.begin(m));
            if (m.type === 'positionChunk') ack(p.receiver.chunk(m));
            if (m.type === 'positionCommit') {
              const result = p.receiver.commit(m); if (result.kind === 'position') p.projection = result.value; else p.selection = result.value;
              ack(result.sequence);
              queueMicrotask(() => p.send('rendered', { transferId: m.transferId, sections: Model.sections(p.projection).map(s => s.section.id), focus: null, mounted: true }));
            }
            if (m.type === 'transferAbort') p.receiver.abort();
            return true;
          }
        }
      };
      Object.defineProperty(p.webview, 'options', { get() { return p.webviewOptions; }, set(value) { p.events.push('options'); p.webviewOptions = value; } });
      Object.defineProperty(p.webview, 'html', { set(value) { p.events.push('html'); assert.match(value, /<meta http-equiv="Content-Security-Policy"/); p.html = value; queueMicrotask(() => incoming.fire({ v: 1, type: 'ready', clientInstanceId: 'client' })); } });
      panels.push(p); return p;
    }
  };
  const settings = new Map(), workspaceSettings = new Map(), folderSettings = new Map(), settingUpdates = [];
  const settingScopes = [settings, workspaceSettings, folderSettings];
  const workspace = { isTrusted: true, textDocuments: [], getWorkspaceFolder: () => ({ uri: Uri.file('/workspace') }),
    getConfiguration: (section = '') => ({
      get: (key, value) => settingScopes.reduce((result, scope) => scope.has(`${section}.${key}`) ? scope.get(`${section}.${key}`) : result, value),
      inspect: key => Object.fromEntries(['globalValue', 'workspaceValue', 'workspaceFolderValue'].map((name, index) => [name, settingScopes[index].get(`${section}.${key}`)])),
      async update(key, value, target = 1) {
        settingUpdates.push({ key: `${section}.${key}`, value, target });
        settingScopes[target - 1].set(`${section}.${key}`, value);
        configurationChange.fire({ affectsConfiguration: name => name === `${section}.${key}` });
      }
    }), onDidChangeConfiguration: configurationChange.event, onDidChangeTextDocument: change.event,
    onDidCloseTextDocument: close.event, onDidSaveTextDocument: save.event, createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noop, onDidDelete: noop }),
    async openTextDocument(uri) { const d = this.textDocuments.find(d => d.uri.toString() === uri.toString()); if (!d) throw Error('Missing source'); return d; }
  };
  const vscode = { window, workspace, debug, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }, TabInputWebview, Uri, Position, Range, Selection, ThemeColor: class {}, ExtensionMode: { Test: 3 },
    ViewColumn: { Active: -1, Beside: 2, One: 1 }, ProgressLocation: { Notification: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    env: { clipboard: { writeText: async text => clipboard.push(text) } },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return noop(); }, executeCommand: async (cmd, key, value) => {
      if (cmd === 'setContext') contexts[key] = value; else if (cmd === 'workbench.action.newGroupBelow') { activeColumn = 3; } else executed.push(cmd);
    } }
  };
  const fakeProcesses = { createMacroProcess(_command, _helper, request, handlers) {
    const process = { request, handlers, start() { pending.push(process); }, stopped: false,
      stop() {
        if (this.stopResult) return this.stopResult;
        this.stopped = true;
        if (stopDelay) this.stopResult = new Promise(resolve => { this.reap = () => { handlers.finished(); resolve(); }; });
        else { handlers.finished(); this.stopResult = Promise.resolve(); }
        return this.stopResult;
      },
      send(request) {
        process.queries ||= []; process.queries.push(request);
        if (!process.stopped && request.mode === 'closeView') queueMicrotask(() => handlers.output(JSON.stringify({ mode: 'closed' }) + '\n'));
        if (!process.stopped && request.mode === 'duplicate') queueMicrotask(() => handlers.output(JSON.stringify(summaryOf(process.data)) + '\n'));
        if (!process.stopped && request.replay && ['reexpand', 'configure'].includes(request.mode)) queueMicrotask(() => handlers.output(JSON.stringify(summaryOf(process.data)) + '\n'));
        if (!process.stopped && request.mode === 'hidingRule') queueMicrotask(() => handlers.output(JSON.stringify({
          id: request.id, action: request.action, label: `${request.action} 'x' imported from example/helpers`,
          syntax: 'retained-syntax-context', index: 1, origin: [process.request.source, request.snapshot],
          replaces: request.rules.filter(rule => rule.index === 1).map(rule => rule.id)
        }) + '\n'));
        if (!process.stopped && request.mode === 'position') queueMicrotask(() => handlers.output(JSON.stringify(project(process.data, request.position)) + '\n'));
        if (!process.stopped && request.mode === 'inspect' && !process.manualInspection) queueMicrotask(() => {
          const a = process.data;
          handlers.output(JSON.stringify({ schemaVersion: 2, mode: 'inspect', snapshot: request.snapshot, position: request.position,
            term: request.term, shared: a.shared, termData: a.terms[request.term], sources: a.sources }) + '\n');
        });
        return !process.stopped;
      } };
    return process;
  } };
  let colorVersion = 0;
  const open = load({ vscode, './macro-token-colors': { colorPosition: async () => ({ tokenSections: {}, tokenStyles: [], themeName: `Theme ${colorVersion}` }) }, __setTimeout: timers?.setTimeout || ((fn, ms) => setTimeout(fn, ms === 10000 && timeoutMs ? timeoutMs : ms)), __clearTimeout: timers?.clearTimeout, './macro-process': { createMacroProcess: workerFactory || fakeProcesses.createMacroProcess }, './language-process': { debuggerArgs: () => helper } }, 'vscode/macro-stepper.js', sources).registerMacroStepper({
    subscriptions: disposables, extensionMode: 3, extensionUri: Uri.file('/extension'),
    workspaceState: { get: (_k, defaultValue) => defaultValue, update: async () => {} }
  });
  async function source(name) { const d = new Document(name); workspace.textDocuments.push(d); await window.showTextDocument(d); return d; }
  function answer(process, mutate = () => {}) {
    const a = fixtureAnswer(process.request.snapshot);
    a.sources.main = { kind: 'untitled', value: process.request.source, fingerprint: process.request.snapshot.sourceHash };
    for (const step of a.steps) step.source = { sourceId: 'main', line: 3, column: 8, span: 3, position: 59 };
    // A selected source action uses host-owned metadata, not a path submitted by a page.
    a.shared.push({ sourceId: [a.shared.push('main') - 1], line: 3, column: 8, span: 3, position: 59 });
    a.shared[3].source = [a.shared.length - 1];
    // Shared children must precede parents: rebuild the fixture root at the end.
    a.shared.push(a.shared[3]); a.shared[3] = { kind: 'identifier' }; a.terms.x = a.shared.length - 1;
    mutate(a); process.data = a; process.handlers.output(JSON.stringify(summaryOf(a)) + '\n'); return a;
  }
  const command = (name, ...args) => commands[`racketdap.macroSteps.${name}`](...args);
  return { open, source, answer, command, commands, window, workspace, debug, settings, workspaceSettings, folderSettings, settingUpdates,
    setSetting(key, value, target = 1) { settingScopes[target - 1].set(key, value); configurationChange.fire({ affectsConfiguration: name => name === key }); }, executed, panels, pending, follows, decorations, clipboard, contexts, progress,
    save: document => save.fire(document), close: document => { document.isClosed = true; close.fire(document); },
    deferFocus(flags = false) { deferredFocus = flags ? 'flags' : 'notifications'; },
    flushFocus() { while (focusNotifications.length) focusNotifications.shift()(); },
    themeChange() { colorVersion++; themeChange.fire(); },
    tokenChange() { colorVersion++; configurationChange.fire({ affectsConfiguration: key => key === 'editor.tokenColorCustomizations' }); },
    bracketChange(setting) { colorVersion++; configurationChange.fire({ affectsConfiguration: (key, scope) => {
      if (key !== 'editor.bracketPairColorization') return false;
      assert.equal(scope.languageId, 'racket'); assert.ok(scope.uri);
      return setting.startsWith(`${key}.`);
    } }); },
    edit(d, text) { d.text = text; d.version++; change.fire({ document: d }); }, cancel: () => token.fire(),
    finish: (p, a) => p.handlers.output(JSON.stringify(a) + '\n'), serializer: () => serializer,
    dispose() { disposables.forEach(d => d.dispose()); } };
}
async function opened(ui, name = 'A') {
  const d = await ui.source(name), opening = ui.open(true); await tick();
  ui.answer(ui.pending.at(-1)); await opening; await tick();
  return d;
}
function fakeTimers() {
  let now = 0, serial = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const id = ++serial; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]); next[1].fn(); await tick();
      }
      now = end; await tick();
    }
  };
}
module.exports = { fakeStepper, opened, fakeTimers };
