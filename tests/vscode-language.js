'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { semanticTokens } = require('./vscode-highlighting');

async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

exports.run = async (extension, workspace) => {
  const directory = path.join(workspace.uri.fsPath, 'development checks');
  fs.mkdirSync(directory, { recursive: true });
  const program = path.join(directory, process.platform === 'win32' ? "language 'λ'.rkt" : 'language "λ".rkt');
  const marker = name => path.join(directory, `${name}.txt`);
  const write = (name, expression) => `(call-with-output-file ${JSON.stringify(marker(name))} #:exists 'truncate (lambda (out) (display ${expression} out)))`;
  for (const name of ['run', 'test', 'repl', 'selection', 'selections']) fs.rmSync(marker(name), { force: true });
  const source = [
    '#lang racket/base',
    '(provide square)',
    '(define (square x)',
    '(* x x))',
    '(define result (square 7))',
    '(define unused-list (list 1 2))',
    `(module+ main ${write('run', 'result')})`,
    `(module+ test (require rackunit) (check-equal? result 49) ${write('test', 'result')})`,
    `;; ${write('selection', '(square 9)')}`,
    '(define-values (answer remainder) (values 49 0))',
    '; (values 1 2)',
    '(define text "(values 1 2)")',
    ';; (define selected-value 40) ; a trailing comment',
    `;; ${write('selections', '(+ selected-value 2)')}`, ''
  ].join('\n');
  fs.writeFileSync(program, source);
  const unopened = path.join(directory, 'unopened consumer.rkt');
  fs.writeFileSync(unopened, `#lang racket/base\n(require (file ${JSON.stringify(path.basename(program))}))\n(square 4)\n`);
  const imports = new Map([
    ['alias', [`(prefix-in p: (rename-in (file ${JSON.stringify(path.basename(program))}) [square sq]))`, '(p:sq 4)', 1]],
    ['prefix', [`(prefix-in a: (prefix-in b: (file ${JSON.stringify(path.basename(program))})))`, '(a:b:square 4)', 1]],
    ['selected', [`(prefix-in s: (only-in (file ${JSON.stringify(path.basename(program))}) square))`, '(s:square 4)', 2]],
    ['excluded', [`(prefix-in e: (except-in (file ${JSON.stringify(path.basename(program))}) square))`, '(void)', 1]]
  ].map(([name, [spec, body, count]]) => [vscode.Uri.file(path.join(directory, `${name} consumer.rkt`)),
    { text: `#lang racket/base\n(require ${spec})\n${body}\n`, count }]));
  for (const [uri, { text }] of imports) fs.writeFileSync(uri.fsPath, text);
  const document = await vscode.workspace.openTextDocument(program);
  const editor = await vscode.window.showTextDocument(document);
  await extension.exports.languageServerReady();
  const call = new vscode.Position(4, 18);
  const definitions = await until(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, call);
    return result?.length && result;
  }, 'bundled language server definition');
  const definition = definitions[0];
  assert.equal((definition.targetUri || definition.uri).fsPath, program);
  assert.equal((definition.targetSelectionRange || definition.range).start.line, 2);
  const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, call);
  assert.ok(references.some(reference => reference.range.start.line === 4));
  assert.ok(references.some(reference => reference.uri.fsPath === unopened && reference.range.start.line === 2),
    'References include a workspace module that has never been opened');
  assert.ok(!vscode.workspace.textDocuments.some(item => item.uri.fsPath === unopened),
    'Background analysis leaves unopened files closed in the editor');
  fs.appendFileSync(unopened, '(square 5)\n');
  await until(async () => {
    const updated = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, call);
    return updated.some(reference => reference.uri.fsPath === unopened && reference.range.start.line === 3);
  }, 'workspace references refresh after an external write');
  const analysisConfig = vscode.workspace.getConfiguration('racket-langserver');
  await analysisConfig.update('workspaceAnalysis.enabled', false, vscode.ConfigurationTarget.Workspace);
  const localReferences = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, call);
  assert.ok(localReferences.some(reference => reference.uri.fsPath === program));
  assert.ok(!localReferences.some(reference => reference.uri.fsPath === unopened));
  await analysisConfig.update('workspaceAnalysis.enabled', true, vscode.ConfigurationTarget.Workspace);
  await until(async () => (await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, call))
    .some(reference => reference.uri.fsPath === unopened), 'workspace index re-enabled independently');
  const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(5, 22));
  assert.ok(hover.some(item => item.contents.length), 'Hover includes documentation for list');
  const valuesPosition = new vscode.Position(9, document.lineAt(9).text.indexOf('(values') + 2);
  const valuesHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, valuesPosition);
  assert.ok(valuesHover.some(item => item.contents.some(content => /values/.test(content.value || content))),
    'Bundled language server documents the values procedure');
  await until(async () => (await semanticTokens(document)).some(token => token.text === 'values' && token.type === 'function'),
    'language server highlights values as a function');
  const syntax = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', document.uri);
  assert.ok(syntax.some(token => token.c === 'values' && token.t.includes('support.function.racket')),
    'values has built-in procedure syntax coloring before semantic analysis');
  assert.ok(syntax.some(token => token.c.includes('(values 1 2)') && token.t.includes('comment')));
  assert.ok(syntax.some(token => token.c.includes('(values 1 2)') && token.t.includes('string')));
  const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, call);
  assert.ok(completion.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'square'), 'Completion includes the local function');
  // The package example is deliberately uninstalled until the package suite.
  // An incomplete index must refuse rename, then honor an explicit scope.
  await assert.rejects(vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, call, 'squared'),
    /analysis is incomplete/);
  const excluded = analysisConfig.get('workspaceAnalysis.excludedDirectories');
  try {
    await analysisConfig.update('workspaceAnalysis.excludedDirectories', [...excluded, 'packages'], vscode.ConfigurationTarget.Workspace);
    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, call, 'squared');
    assert.ok(rename.get(document.uri).length >= 3, 'Rename updates definition, provide, and call');
    assert.equal(rename.get(vscode.Uri.file(unopened)).length, 2, 'Rename includes both calls in the unopened consumer');
    assert.ok(!vscode.workspace.textDocuments.some(item => item.uri.fsPath === unopened), 'Rename preview leaves the consumer closed');
    assert.match(fs.readFileSync(unopened, 'utf8'), /\(square 5\)/, 'Producing the preview does not write to disk');
    for (const [uri, { text, count }] of imports) {
      const edits = rename.get(uri);
      assert.equal(edits.length, count, uri.fsPath);
      const lines = text.split('\n');
      for (const edit of [...edits].sort((a, b) => b.range.start.line - a.range.start.line)) {
        const { start, end } = edit.range;
        assert.equal(start.line, end.line);
        const line = lines[start.line];
        lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
      }
      assert.equal(lines.join('\n'), text.replaceAll('square', 'squared'), uri.fsPath);
      assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), text, 'Import rename preview leaves disk unchanged');
      assert.ok(!vscode.workspace.textDocuments.some(item => item.uri.fsPath === uri.fsPath),
        'Import rename preview leaves consumers closed');
    }
  } finally {
    await analysisConfig.update('workspaceAnalysis.excludedDirectories', excluded, vscode.ConfigurationTarget.Workspace);
  }
  const formatting = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 2, insertSpaces: true });
  assert.ok(formatting.length, 'Bundled fixw returns formatting edits');
  const formatEdit = new vscode.WorkspaceEdit();
  formatEdit.set(document.uri, formatting);
  assert.equal(await vscode.workspace.applyEdit(formatEdit), true);
  assert.match(document.getText(), /\n  \(\* x x\)\)/);
  // Restore the fixture, then make and repair an unsaved error. This checks
  // incremental synchronization and diagnostics in both directions.
  async function replace(text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  await replace(source + '\nunknown-racket-name\n');
  await until(() => vscode.languages.getDiagnostics(document.uri).some(diagnostic => /unknown-racket-name/.test(diagnostic.message)), 'diagnostic after unsaved edit');
  await replace(source);
  await until(() => !vscode.languages.getDiagnostics(document.uri).some(diagnostic => /unknown-racket-name/.test(diagnostic.message)), 'diagnostic cleared after repair');
  await document.save();

  for (const name of ['run']) {
    const ended = [];
    const listener = vscode.tasks.onDidEndTaskProcess(event => ended.push(event));
    try {
      const execution = await vscode.commands.executeCommand(`racketdap.${name}File`);
      assert.ok(execution, `${name} command starts a task`);
      const result = await until(() => ended.find(event => event.execution === execution), `${name} task exits`);
      assert.equal(result.exitCode, 0);
      assert.equal(fs.readFileSync(marker(name), 'utf8'), '49');
    } finally { listener.dispose(); }
  }
  assert.deepEqual(await vscode.commands.executeCommand('racketdap.testFile'),
    { passed: 1, failed: 0, errored: 0, skipped: 0 });
  assert.equal(fs.readFileSync(marker('test'), 'utf8'), '49');
  const standalone = await vscode.commands.executeCommand('racketdap.startRepl');
  assert.ok(standalone);
  const terminal = await vscode.commands.executeCommand('racketdap.loadFile');
  assert.equal(terminal, standalone, 'Load file reuses the workspace REPL');
  terminal.sendText(write('repl', '(square 8)'));
  await until(() => fs.existsSync(marker('repl')) && fs.readFileSync(marker('repl'), 'utf8') === '64', 'REPL loads file with quoted Unicode path');
  editor.selection = new vscode.Selection(8, 3, 8, document.lineAt(8).text.length);
  assert.equal(await vscode.commands.executeCommand('racketdap.sendSelection'), terminal);
  await until(() => fs.existsSync(marker('selection')) && fs.readFileSync(marker('selection'), 'utf8') === '81', 'selected expression evaluated in module REPL');
  editor.selections = [new vscode.Selection(0, 0, 0, 0),
    new vscode.Selection(13, document.lineAt(13).text.length, 13, 3),
    new vscode.Selection(12, 3, 12, document.lineAt(12).text.length)];
  assert.equal(await vscode.commands.executeCommand('racketdap.sendSelection'), terminal);
  await until(() => fs.existsSync(marker('selections')) && fs.readFileSync(marker('selections'), 'utf8') === '42',
    'multiple selections evaluate in source order, ignoring the empty primary cursor');
  terminal.dispose();

  await vscode.workspace.getConfiguration('racketdap').update('languageServer.enabled', false, vscode.ConfigurationTarget.Workspace);
  await extension.exports.languageServerReady();
  assert.equal((await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, call)).length, 0);
  await vscode.workspace.getConfiguration('racketdap').update('languageServer.enabled', true, vscode.ConfigurationTarget.Workspace);
  await extension.exports.languageServerReady();
  await until(async () => (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, call))?.length, 'language server re-enabled');
  await vscode.commands.executeCommand('racketdap.restartLanguageServer');
  await until(async () => (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, call))?.length, 'language server restarted');

  const replChecks = await require('./vscode-repl').run(workspace);
  return [process.env.RACKETDAP_TEST_RHOMBUS === '1'
    ? 'bundled language server with isolated Rhombus runtime addon'
    : 'bundled language server with empty Racket addon directory', 'definition', 'references',
    'workspace references include unopened files without opening editor buffers',
    'workspace references refresh after external writes', 'disable/enable workspace index independently', 'hover documentation',
    'values documentation', 'values semantic function highlighting', 'built-in syntax highlighting preserves strings and comments',
    'completion', 'rename', 'rename preserves import aliases and prefixes and updates selectors', 'formatting', 'unsaved diagnostics and repair', 'run task', 'Test Explorer file run',
    'REPL', 'load quoted Unicode file in REPL', 'evaluate selection', 'evaluate multiple selections in the plain REPL',
    'disable/enable language server', 'restart language server', ...replChecks];
};
