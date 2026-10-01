'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const execute = promisify(execFile);

exports.run = async function (workspace) {
  assert.ok(process.env.PLTADDONDIR, 'Package integration requires the isolated test environment');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket editor package λ '));
  const name = `racketdap-editor-library-${process.pid}`;
  const library = path.join(directory, name);
  await fs.mkdir(library);
  await fs.writeFile(path.join(library, 'info.rkt'), [
    '#lang info', '(define collection "editor-example")', '(define deps \'("base"))',
    '(define build-deps \'("rackunit-lib"))', '(define test-omit-paths \'("should-not-run.rkt"))',
    '(define test-command-line-arguments \'(("math.rkt" ("package-test"))))', ''
  ].join('\n'));
  const helper = path.join(library, 'math.rkt');
  await fs.writeFile(helper, [
    '#lang racket/base', '(provide twice)', '', '(define (twice value)', '  (+ value value))',
    '(module+ test (require rackunit)', '  (check-equal? (twice 21) 42)',
    '  (check-equal? (current-command-line-arguments) #("package-test")))', ''
  ].join('\n'));
  await fs.writeFile(path.join(library, 'should-not-run.rkt'), '#lang racket/base\n(error "package metadata must omit this file")\n');
  const program = path.join(workspace.uri.fsPath, 'package-demo.rkt');
  await fs.writeFile(program, '#lang racket/base\n(require editor-example/math)\n(define (answer value) (twice value))\n');
  const document = await vscode.workspace.openTextDocument(program);
  await vscode.window.showTextDocument(document);
  const settings = vscode.workspace.getConfiguration('racketdap', workspace.uri);
  const previous = settings.inspect('debug.packages').workspaceValue;
  let repl;
  const messages = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      return { onDidSendMessage(message) { messages.push({ session, ...message }); } };
    }
  });
  try {
    assert.equal((await vscode.commands.executeCommand('racketdap.linkPackage', vscode.Uri.file(library))).exitCode, 0);
    const packages = await vscode.commands.executeCommand('racketdap.listPackages');
    const pkg = packages.find(pkg => pkg.name === name);
    assert.equal(path.resolve(pkg.directory), library); assert.equal(pkg.linked, true); assert.equal(pkg.scope, 'user');
    assert.equal((await vscode.commands.executeCommand('racketdap.testPackage', name)).exitCode, 0,
      'Native package tests honor info.rkt omissions and command-line arguments');
    assert.equal((await vscode.commands.executeCommand('racketdap.setupPackage', name)).exitCode, 0);
    await assert.rejects(vscode.commands.executeCommand('racketdap.updatePackage', name), /directory link/);
    // A failed task must settle and leave subsequent commands usable.
    await assert.rejects(vscode.commands.executeCommand('racketdap.installPackage', path.join(directory, 'missing.zip')),
      /did not complete successfully/);
    await settings.update('debug.packages', [name], vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(document);
    repl = await vscode.commands.executeCommand('racketdap.startDebugRepl');
    assert.ok(await repl.ready);
    assert.deepEqual(repl.session.configuration.debugPackages, [name]);
    const { breakpoints } = await repl.session.customRequest('setBreakpoints', {
      source: { path: helper }, breakpoints: [{ line: 5 }]
    });
    assert.equal(breakpoints[0].verified, true);
    const evaluated = repl.session.customRequest('evaluate', { context: 'repl', expression: '(answer 7)' });
    const deadline = Date.now() + 15000;
    let stop;
    while (!(stop = messages.find(m => m.session.id === repl.session.id && m.event === 'stopped'))) {
      assert.ok(Date.now() < deadline, 'Debug REPL stops inside external package source');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const { stackFrames } = await repl.session.customRequest('stackTrace', { threadId: stop.body.threadId });
    assert.equal(stackFrames[0].source.path, helper);
    assert.equal((await repl.session.customRequest('evaluate', { frameId: stackFrames[0].id, expression: 'value' })).result, '7');
    await repl.session.customRequest('continue', { threadId: stop.body.threadId });
    assert.equal((await evaluated).result, '14');
    await repl.stop(); await repl.done;
    await vscode.window.showTextDocument(document);
    // Cancel a real package test child, then check that it has exited. The
    // marker is a synchronization point, not scraped terminal output.
    const marker = path.join(library, 'test-process.txt');
    const blocked = path.join(library, 'blocked.rkt');
    await fs.writeFile(blocked, [
      '#lang racket/base', '(module+ test (require racket/os racket/runtime-path)',
      '  (define-runtime-path marker "test-process.txt")',
      '  (call-with-output-file marker (lambda (out) (display (getpid) out)))',
      '  (sync never-evt))', ''
    ].join('\n'));
    const cancelled = assert.rejects(vscode.commands.executeCommand('racketdap.testPackage', name), /did not complete successfully/);
    const cancellationDeadline = Date.now() + 30000;
    let pid;
    while (!pid) {
      try { pid = Number(await fs.readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(Date.now() < cancellationDeadline, 'Package test starts before cancellation');
      if (!pid) await new Promise(resolve => setTimeout(resolve, 30));
    }
    const running = vscode.tasks.taskExecutions.find(execution => execution.task.name === `Test package ${name}`);
    assert.ok(running); running.terminate(); await cancelled;
    for (;;) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      assert.ok(Date.now() < cancellationDeadline, 'Cancelled package test child exits');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await fs.rm(blocked); await fs.rm(marker);
    assert.equal((await vscode.commands.executeCommand('racketdap.removePackage', name)).exitCode, 0);
    assert.ok(!(await vscode.commands.executeCommand('racketdap.listPackages')).some(pkg => pkg.name === name));
    // Install an archive, then replace it with changed source. Unlike a
    // directory link, this requires a real update of the installed copy.
    const archive = path.join(directory, `${name}.zip`);
    const bundle = () => execute(settings.get('racketExecutable', 'racket'),
      ['-l', 'raco', '--', 'pkg', 'create', '--source', '--dest', directory, '--', library], { timeout: 30000 });
    await bundle();
    assert.equal((await vscode.commands.executeCommand('racketdap.installPackage', archive)).exitCode, 0);
    const installed = (await vscode.commands.executeCommand('racketdap.listPackages')).find(pkg => pkg.name === name);
    assert.equal(installed.linked, false);
    const installedSource = path.join(installed.directory, 'math.rkt');
    await fs.appendFile(helper, '\n(provide generation)\n(define generation 2)\n');
    await fs.rm(archive); await fs.rm(`${archive}.CHECKSUM`);
    await bundle();
    assert.doesNotMatch(await fs.readFile(installedSource, 'utf8'), /define generation 2/);
    assert.equal((await vscode.commands.executeCommand('racketdap.updatePackage', { name, source: archive })).exitCode, 0);
    assert.match(await fs.readFile(installedSource, 'utf8'), /define generation 2/);
    // A process that cannot start must also settle its task, and restoring
    // the executable must leave subsequent operations usable.
    const previousExecutable = settings.inspect('racketExecutable').workspaceValue;
    const extension = vscode.extensions.getExtension('lamestllama.racketeer');
    try {
      await settings.update('racketExecutable', path.join(directory, 'missing-racket'), vscode.ConfigurationTarget.Workspace);
      await extension.exports.languageServerReady();
      await assert.rejects(vscode.commands.executeCommand('racketdap.installPackage', archive));
    } finally {
      await settings.update('racketExecutable', previousExecutable, vscode.ConfigurationTarget.Workspace);
    }
    await extension.exports.languageServerReady();
    const recoveredDeadline = Date.now() + 30000;
    for (;;) {
      const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri,
        new vscode.Position(2, document.lineAt(2).text.lastIndexOf('value') + 1));
      if (definitions?.length) break;
      assert.ok(Date.now() < recoveredDeadline, 'Language analysis recovers after restoring the executable');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await vscode.commands.executeCommand('racketdap.testPackage', name)).exitCode, 0);
    // A real process that never speaks LSP must not prevent a corrected
    // configuration from taking over. Build a native executable on every OS.
    const hangingScript = path.join(directory, 'unresponsive-server.rkt');
    const hangingExecutable = path.join(directory, process.platform === 'win32' ? 'unresponsive-racket.exe' : 'unresponsive-racket');
    const startupMarker = path.join(directory, 'server-started.txt');
    await fs.writeFile(hangingScript, `#lang racket/base\n(require racket/os)\n(call-with-output-file ${JSON.stringify(startupMarker)} (lambda (out) (display (getpid) out)))\n(sync never-evt)\n`);
    await execute(settings.get('racketExecutable', 'racket'),
      ['-l', 'raco', '--', 'exe', '-o', hangingExecutable, hangingScript], { timeout: 60000 });
    const initializationRejections = [];
    const captureInitializationRejection = error => initializationRejections.push(String(error?.stack || error));
    process.on('unhandledRejection', captureInitializationRejection);
    try {
      let startupPid;
      try {
        await settings.update('racketExecutable', hangingExecutable, vscode.ConfigurationTarget.Workspace);
        const startupDeadline = Date.now() + 15000;
        while (!startupPid) {
          try { startupPid = Number(await fs.readFile(startupMarker, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          assert.ok(Date.now() < startupDeadline, 'Unresponsive language process starts');
          if (!startupPid) await new Promise(resolve => setTimeout(resolve, 30));
        }
      } finally {
        await settings.update('racketExecutable', previousExecutable, vscode.ConfigurationTarget.Workspace);
      }
      await extension.exports.languageServerReady();
      const startupRecoveryDeadline = Date.now() + 30000;
      for (;;) {
        const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri,
          new vscode.Position(2, document.lineAt(2).text.lastIndexOf('value') + 1));
        if (definitions?.length) break;
        assert.ok(Date.now() < startupRecoveryDeadline, 'Language server recovers from unresponsive initialization');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.throws(() => process.kill(startupPid, 0), { code: 'ESRCH' }, 'Cancelled language process is reaped');
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(initializationRejections, [], 'Cancelling initialization does not leave an unhandled rejection');
    } finally {
      process.off('unhandledRejection', captureInitializationRejection);
    }
    return ['package link and structured inventory', 'package tests honor info.rkt metadata',
      'package build and archive update tasks', 'Debug REPL in linked package source outside workspace',
      'package task failure recovery', 'package task cancellation reaps its child',
      'package removal and local installation', 'package paths with spaces and Unicode',
      'package task startup failure recovery', 'language-server recovery after invalid executable',
      'language-server recovery cancels an unresponsive initializing process'];
  } finally {
    if (repl && !repl.ended) { await repl.stop(); await repl.done; }
    await settings.update('debug.packages', previous, vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(document);
    if ((await vscode.commands.executeCommand('racketdap.listPackages')).some(pkg => pkg.name === name)) {
      await vscode.commands.executeCommand('racketdap.removePackage', name);
    }
    tracker.dispose();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(program, { force: true });
  }
};
