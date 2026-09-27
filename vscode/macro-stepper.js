'use strict';
const vscode = require('vscode');
const path = require('node:path');
const os = require('node:os');
const { createMacroProcess } = require('./macro-process');

function macroTarget(editor, wholeFile) {
  const document = editor?.document;
  if (!document || document.languageId !== 'racket') throw new Error('Open a Racket editor first.');
  if (!['file', 'untitled'].includes(document.uri.scheme)) {
    throw new Error('Open a local or untitled Racket document to use the macro stepper.');
  }
  const buffer = document.getText();
  const range = wholeFile ? undefined : editor.selection.isEmpty
    ? document.lineAt(editor.selection.active.line).range : editor.selection;
  const start = range ? document.offsetAt(range.start) : 0;
  const end = range ? document.offsetAt(range.end) : buffer.length;
  const text = buffer.slice(start, end);
  if (!text.trim()) throw new Error('The current line, selection, or file contains no Racket forms.');
  const file = document.uri.scheme === 'file';
  const folder = vscode.workspace.getWorkspaceFolder(document.uri) ||
    (!file ? vscode.workspace.workspaceFolders?.[0] : undefined);
  const settings = vscode.workspace.getConfiguration('racketdap', document.uri);
  const cwd = folder?.uri.fsPath || (file ? path.dirname(document.uri.fsPath) : os.homedir());
  return {
    executable: settings.get('racketExecutable', 'racket'),
    request: {
      mode: wholeFile ? 'module' : 'fragment', text, prefix: buffer.slice(0, start), cwd,
      source: file ? document.uri.fsPath : document.uri.toString(), sourceIsFile: file,
      // Relative module imports belong to the source directory, independent
      // of the process cwd. Untitled sources use their workspace.
      directory: file ? path.dirname(document.uri.fsPath) : folder?.uri.fsPath || os.homedir()
    }
  };
}

function registerMacroStepper(context) {
  const owned = new Set();
  let disposed = false;
  context.subscriptions.push({ dispose() {
    disposed = true;
    for (const entry of owned) { void entry.process.stop(); entry.terminal?.dispose(); }
  } });
  return async function open(wholeFile = false) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before expanding Racket macros.');
    if (disposed) throw new Error('The macro-stepper command has stopped.');
    const target = macroTarget(vscode.window.activeTextEditor, wholeFile);
    const written = new vscode.EventEmitter();
    const closed = new vscode.EventEmitter();
    const entry = {};
    let opened = false;
    let ended;
    entry.process = createMacroProcess(target.executable,
      context.asAbsolutePath('runtime/racketdap/tools/macro-stepper.rkt'), target.request, {
        output: text => written.fire(text.replace(/\r?\n/g, '\r\n')),
        failure: message => { void vscode.window.showErrorMessage(message); },
        finished: code => {
          ended = code;
          if (opened) closed.fire(code);
          owned.delete(entry);
          if (opened) { written.dispose(); closed.dispose(); }
        }
      });
    owned.add(entry);
    const pty = {
      onDidWrite: written.event, onDidClose: closed.event,
      open() {
        opened = true;
        if (ended !== undefined) {
          closed.fire(ended); written.dispose(); closed.dispose();
          return;
        }
        written.fire(wholeFile
          ? 'Expanding the current module buffer with Racket\'s macro stepper.\r\n'
          : 'Expanding in a fresh Racket namespace. Enclosing module bindings are unavailable; use Open File in Macro Stepper for module imports and macros.\r\n');
        entry.process.start();
      },
      close() { void entry.process.stop(); }
    };
    try {
      // Tasks auto-save dirty editors and have no per-task save override.
      // A transient owned terminal keeps inspection independent of saving.
      entry.terminal = vscode.window.createTerminal({
        name: `Racket Macro Stepper: ${path.basename(target.request.source)}`,
        pty, isTransient: true
      });
      if (disposed) { void entry.process.stop(); entry.terminal.dispose(); }
      else entry.terminal.show(true);
      return entry.terminal;
    } catch (error) {
      void entry.process.stop();
      if (!opened) { owned.delete(entry); written.dispose(); closed.dispose(); }
      throw error;
    }
  };
}

module.exports = { registerMacroStepper, macroTarget };
