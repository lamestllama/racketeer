// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const execute = promisify(execFile);

exports.run = async function (workspace, observe = async () => {}) {
  const root = path.join(workspace.uri.fsPath, 'application build λ');
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(output);
  const consoleSource = path.join(source, 'console λ.rkt'), guiSource = path.join(source, 'gui.rkt');
  const taskConfig = path.join(workspace.uri.fsPath, '.vscode/tasks.json');
  let previousTasks;
  try { previousTasks = await fs.readFile(taskConfig); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const live = new Set(), events = [], checks = [];
  const settings = vscode.workspace.getConfiguration('racketdap');
  const previousLanguageServer = settings.inspect('languageServer.enabled').workspaceValue;
  let restoreLanguageServer = false;
  let childPid;
  const started = vscode.tasks.onDidStartTask(event => { if (event.execution.task.definition.type === 'racket-build') live.add(event.execution); });
  const ended = vscode.tasks.onDidEndTask(event => live.delete(event.execution));
  const results = vscode.tasks.onDidEndTaskProcess(event => events.push(event));
  const processes = new Map();
  const processStarts = vscode.tasks.onDidStartTaskProcess(event => processes.set(event.execution, event.processId));
  const exists = async filename => { try { await fs.stat(filename); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } };
  async function until(check, label, timeout = 60000, details = () => '') {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await check(); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out: ${label}${details()}`);
  }
  const alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  async function open(filename) { return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename)); }
  async function build(command, request) {
    const result = await vscode.commands.executeCommand(`racketdap.${command}`, request);
    assert.equal(result.exitCode, 0); assert.ok(await exists(result.output)); return result.output;
  }
  async function executable(file) {
    if (process.platform !== 'darwin' || !file.endsWith('.app')) return file;
    const directory = path.join(file, 'Contents/MacOS');
    const names = await fs.readdir(directory); assert.equal(names.length, 1);
    return path.join(directory, names[0]);
  }
  function distributed(directory, file, gui = false) {
    return path.join(directory, ...(process.platform === 'win32' || (process.platform === 'darwin' && gui) ? [] : ['bin']), path.basename(file));
  }
  async function checkGui(file, name) {
    const receipt = path.join(output, name + '.json');
    await execute(await executable(file), [receipt], { cwd: output, timeout: 30000 });
    const value = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(value.visible, true); assert.equal(value.payload, 'runtime λ');
  }
  try {
    await fs.writeFile(path.join(source, 'message.rkt'), `#lang racket/base
(require racket/runtime-path racket/file)
(provide message)
(define-runtime-path data "message.txt")
(define message (file->string data))
`);
    await fs.writeFile(path.join(source, 'message.txt'), 'runtime λ');
    await fs.writeFile(consoleSource, `#lang racket/base
(require "message.rkt")
(displayln (list message (vector->list (current-command-line-arguments))))
`);
    await fs.writeFile(guiSource, `#lang racket/gui
(require json "message.rkt")
(define window (new frame% [label "Application build fixture"] [width 320] [height 120]))
(new message% [parent window] [label message])
(send window show #t)
(queue-callback (lambda ()
  (call-with-output-file (vector-ref (current-command-line-arguments) 0) #:exists 'truncate/replace
    (lambda (out) (write-json (hasheq 'visible (send window is-shown?) 'payload message) out)))
  (exit 0)))
`);
    const editor = await open(consoleSource);
    await editor.edit(edit => edit.insert(new vscode.Position(3, 0), '(displayln "saved edit")\n'));
    assert.equal(editor.document.isDirty, true);
    const launcher = await build('createLauncher', { gui: false, output: path.join(output, 'console-launcher') });
    assert.equal(editor.document.isDirty, false);
    assert.match((await execute(launcher, ['argument λ'])).stdout, /runtime λ.*argument λ/);
    assert.match((await execute(launcher)).stdout, /saved edit/);
    checks.push('Console launcher saves the active document and retains source/runtime arguments');
    const consoleExe = await build('buildExecutable', { gui: false, output: path.join(output, 'console-app') });
    const consoleDist = await build('createDistribution', { source: consoleExe, output: path.join(output, 'console-dist') });
    await open(guiSource);
    const guiLauncher = await build('createLauncher', { gui: true, output: path.join(output, 'gui-launcher') });
    await checkGui(guiLauncher, 'gui-launcher');
    const guiExe = await build('buildExecutable', { gui: true, output: path.join(output, 'gui-app') });
    await checkGui(guiExe, 'gui-executable');
    const guiDist = await build('createDistribution', { source: guiExe, output: path.join(output, 'gui-dist') });
    checks.push('Console and GUI executables and a GUI launcher build through native tasks');
    await fs.rename(source, path.join(root, 'hidden source'));
    await fs.rename(consoleExe, consoleExe + '.hidden'); await fs.rename(guiExe, guiExe + '.hidden');
    const movedConsole = path.join(output, 'moved console'), movedGui = path.join(output, 'moved gui');
    await fs.rename(consoleDist, movedConsole); await fs.rename(guiDist, movedGui);
    assert.match((await execute(distributed(movedConsole, consoleExe), ['relocated λ'], { cwd: output })).stdout, /runtime λ.*relocated λ/);
    await checkGui(distributed(movedGui, guiExe, true), 'gui-relocated');
    checks.push('Console and GUI distributions run after relocation without the original source or executable');
    await fs.rename(path.join(root, 'hidden source'), source);

    const taskExe = process.platform === 'win32' ? 'task-app.exe' : 'task-app';
    await fs.mkdir(path.dirname(taskConfig), { recursive: true });
    await fs.writeFile(taskConfig, JSON.stringify({ version: '2.0.0', tasks: [
      { label: 'Acceptance executable', type: 'racket-build', action: 'executable',
        source: '${workspaceFolder}/application build λ/source/console λ.rkt', output: '${workspaceFolder}/application build λ/output/' + taskExe, problemMatcher: [] },
      { label: 'Acceptance distribution', type: 'racket-build', action: 'distribution',
        source: '${workspaceFolder}/application build λ/output/' + taskExe, output: '${workspaceFolder}/application build λ/output/task-dist',
        dependsOn: 'Acceptance executable', dependsOrder: 'sequence', problemMatcher: [] }
    ] }, null, 2));
    const configured = await until(async () => (await vscode.tasks.fetchTasks({ type: 'racket-build' }))
      .find(task => task.name === 'Acceptance distribution'), 'Configured distribution task');
    const taskExecution = await vscode.tasks.executeTask(configured);
    const completed = await until(() => events.find(event => event.execution === taskExecution), 'Configured task completion');
    assert.equal(completed.exitCode, 0);
    assert.ok(await exists(path.join(output, taskExe)), 'Task dependency built the executable');
    assert.match((await execute(distributed(path.join(output, 'task-dist'), taskExe))).stdout, /runtime λ/);
    checks.push('Configured tasks resolve native variables and sequence executable/distribution dependencies');

    const bad = path.join(source, 'invalid.rkt'); await fs.writeFile(bad, '#lang racket/base\n('); await open(bad);
    await assert.rejects(vscode.commands.executeCommand('racketdap.buildExecutable', { gui: false, output: path.join(output, 'invalid') }), /did not complete successfully/);
    checks.push('Compiler failure settles the command and leaves diagnostics in the task terminal');

    // The cancellation fixture must run only in the compiler task, not during
    // the language server's independent expansion of an open document.
    restoreLanguageServer = true;
    await settings.update('languageServer.enabled', false, vscode.ConfigurationTarget.Workspace);
    await vscode.extensions.getExtension('lamestllama.racketeer').exports.languageServerReady();
    const receipt = path.join(output, 'compiler-child.json'), slow = path.join(source, 'slow.rkt');
    await fs.writeFile(slow, `#lang racket/base
(require (for-syntax racket/base))
(begin-for-syntax
 (define-values (child out in err) (subprocess #f #f #f (find-executable-path "racket") "-e" "(sync never-evt)"))
 (call-with-output-file ${JSON.stringify(receipt)} #:exists 'truncate/replace
   (lambda (port) (display (subprocess-pid child) port)))
 (sync never-evt))
`);
    await open(slow);
    const pending = vscode.commands.executeCommand('racketdap.buildExecutable', { gui: false, output: path.join(output, 'cancelled') })
      .then(() => { throw new Error('Cancelled build unexpectedly succeeded'); }, error => error);
    await until(() => exists(receipt), 'Compiler child receipt');
    childPid = Number(await fs.readFile(receipt, 'utf8')); assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    const running = await until(() => vscode.tasks.taskExecutions.find(execution => execution.task.name === 'Build executable slow.rkt'), 'Compiler task execution');
    await observe({ stage: 'cancellation', checks, task: running.task.definition, childPid });
    running.terminate();
    assert.match((await pending).message, /did not complete successfully/);
    // Report which process outlived the task, to tell a compiler that ignored
    // termination from a child that the termination did not reach.
    const compilerPid = processes.get(running);
    await until(() => !alive(childPid), 'Compiler child stopped', 10000,
      () => ` (compiler process ${compilerPid ?? 'unknown'} ${compilerPid && alive(compilerPid) ? 'still running' : 'stopped'})`);
    childPid = undefined;
    checks.push('Native task cancellation stops a stalled compiler and its ordinary child process');
    await open(consoleSource);
    await build('buildExecutable', { gui: false, output: path.join(output, 'after-cancel') });
    checks.push('A build succeeds after failure and cancellation');
    await observe({ checks, events: events.map(event => ({ name: event.execution.task.name, code: event.exitCode })) });
    return checks;
  } finally {
    for (const execution of live) execution.terminate();
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    started.dispose(); ended.dispose(); results.dispose(); processStarts.dispose();
    if (previousTasks) await fs.writeFile(taskConfig, previousTasks); else await fs.rm(taskConfig, { force: true });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    if (restoreLanguageServer) {
      await settings.update('languageServer.enabled', previousLanguageServer, vscode.ConfigurationTarget.Workspace);
      await vscode.extensions.getExtension('lamestllama.racketeer').exports.languageServerReady();
    }
  }
};
