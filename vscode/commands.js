// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');
const { selectedEditor } = require('./selected-editor');
const path = require('node:path');
const { activeTarget } = require('./execution');
const { registerMacroStepper } = require('./macro-stepper');

// A Racket string literal, not a shell command. JSON escapes mostly coincide,
// except that Racket does not use JSON's surrogate pairs for Unicode escapes.
function racketString(text) {
  return '"' + text.replace(/["\\\x00-\x1f\x7f]/g, character => {
    if (character === '"' || character === '\\') return '\\' + character;
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  }) + '"';
}

function selectedExpressions(editor) {
  if (!editor || editor.document.languageId !== 'racket') throw new Error('Open a Racket editor first.');
  const selections = editor.selections.filter(selection => !selection.isEmpty);
  if (!selections.length) throw new Error('Select a complete Racket expression to evaluate.');
  return selections.sort((a, b) => a.start.compareTo(b.start))
    .map(selection => editor.document.getText(selection));
}

function registerFileCommands(context, sessions, testing, debugRepl, fileRuns) {
  const terminals = new Map();
  const macroStepper = registerMacroStepper(context);

  function repl(document) {
    const uri = document?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const cwd = folder?.uri.fsPath || (document && path.dirname(document.uri.fsPath));
    const config = vscode.workspace.getConfiguration('racketdap', uri);
    const command = config.get('racketExecutable', 'racket');
    const source = config.get('repl.sessionScope', 'workspace') === 'file' ? document?.uri : undefined;
    const key = JSON.stringify([cwd, command, source?.toString()]);
    let terminal = terminals.get(key);
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({
        name: source ? `Racket REPL: ${vscode.workspace.asRelativePath(source, true)}` : 'Racket REPL',
        shellPath: command,
        shellArgs: ['-i', '-l', 'racket/enter'], cwd,
        // Do not let bracketed-paste wrappers turn Racket forms into escape
        // sequences. Racket receives the submitted text directly.
        isTransient: true
      });
      terminals.set(key, terminal);
      context.subscriptions.push(terminal);
    }
    terminal.show(true);
    return terminal;
  }

  async function taskForFile(target) {
    const { program, folder, cwd, racketExecutable } = target;
    const name = `Run ${path.basename(program)}`;
    const task = new vscode.Task({ type: 'racket', program, action: 'run' },
      folder || vscode.TaskScope.Global, name, 'Racket',
      new vscode.ProcessExecution(racketExecutable, [program], { cwd }), []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
    return vscode.tasks.executeTask(task);
  }

  const fileCommands = {
    runFile: target => fileRuns.run(target),
    runFileInTerminal: taskForFile,
    debugFile: target => fileRuns.run(target, true),
    testFile: target => testing.runFile(target.uri),
    debugTestFile: target => testing.runFile(target.uri, true),
    startDebugRepl: target => debugRepl.open(target),
    runInteractions: target => debugRepl.open(target, true),
    restartDebugRepl: target => debugRepl.open(target, true),
    loadFile: target => {
      const terminal = repl(target);
      terminal.sendText(`(enter! (file ${racketString(target.program)}) #:quiet)`);
      return terminal;
    }
  };
  const commands = {
    openMacroStepper: () => macroStepper(),
    openFileInMacroStepper: () => macroStepper(true),
    ...Object.fromEntries(Object.entries(fileCommands).map(([name, command]) =>
      [name, async () => command(await activeTarget({ allowWxme: ['runFile', 'runFileInTerminal', 'debugFile'].includes(name) }))])),
    sendSelectionToDebugRepl: async () => {
      const expressions = selectedExpressions(selectedEditor(vscode.window));
      return debugRepl.evaluate(await activeTarget(), expressions);
    },
    startRepl: () => {
      const document = selectedEditor(vscode.window)?.document;
      return repl(document?.uri.scheme === 'file' ? document : undefined);
    },
    sendSelection: async () => {
      const editor = selectedEditor(vscode.window);
      const expressions = selectedExpressions(editor);
      const terminal = repl(editor.document.uri.scheme === 'file' ? editor.document : undefined);
      for (const expression of expressions) terminal.sendText(expression);
      return terminal;
    }
  };
  commands.fileActions = async () => {
    const target = await activeTarget({ allowWxme: true });
    const choices = [
      ['Run file', 'runFile'], ['Debug file', 'debugFile'],
      ['Run in Terminal', 'runFileInTerminal'],
      ['Run in Interactions', 'runInteractions'],
      ['Run tests', 'testFile'], ['Debug tests', 'debugTestFile'],
      ['Load in REPL', 'loadFile'], ['Load in Debug REPL', 'startDebugRepl'],
      ['Restart Debug REPL', 'restartDebugRepl']
    ].filter(([, command]) => target.format !== 'wxme' || ['runFile', 'runFileInTerminal', 'debugFile'].includes(command))
      .map(([label, command]) => ({ label, command }));
    const choice = await vscode.window.showQuickPick(choices, { title: `Racket: ${path.basename(target.program)}` });
    if (choice) return fileCommands[choice.command](target);
  };
  for (const [name, command] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`racketdap.${name}`, async () => {
      if (!vscode.workspace.isTrusted) return;
      try { return await command(); }
      catch (error) {
        console.error(`Racket command ${name} failed:`, error);
        void vscode.window.showErrorMessage(`Racket: ${error.message}`);
      }
    }));
  }
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    for (const [key, value] of terminals) if (value === terminal) terminals.delete(key);
  }));
}

module.exports = { registerFileCommands, racketString };
