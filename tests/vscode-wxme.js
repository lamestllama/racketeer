'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function (_extension, workspace) {
  const checks = [], directory = path.join(workspace.uri.fsPath, 'wxme-viewer');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'embedded λ😀.wxme'), uri = vscode.Uri.file(file);
  fs.copyFileSync(path.join(__dirname, 'fixtures/wxme/images.wxme'), file);
  const bytes = fs.readFileSync(file);
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  const custom = () => tabs().filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
  const open = async column => {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'racketeer.wxme', { viewColumn: column, preview: false });
    const deadline = Date.now() + 10000;
    while (!custom().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    assert.ok(custom().length, 'WXME custom editor opened');
  };
  try {
    await open(vscode.ViewColumn.One);
    assert.equal(custom()[0].input.viewType, 'racketeer.wxme');
    assert.equal(custom()[0].isDirty, false);
    checks.push('WXME opens through the native custom-editor API');
    await vscode.commands.executeCommand('workbench.action.files.save');
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(custom()[0].isDirty, false);
    checks.push('Saving a read-only WXME view leaves its bytes unchanged');
    if (process.env.RACKETDAP_WXME_SCREENSHOT_READY) {
      fs.writeFileSync(process.env.RACKETDAP_WXME_SCREENSHOT_READY, 'ready');
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(process.env.RACKETDAP_WXME_SCREENSHOT_READY + '.done') && Date.now() < deadline)
        await new Promise(r => setTimeout(r, 100));
    }
    await open(vscode.ViewColumn.Beside);
    assert.equal(custom().length, 2);
    await vscode.window.tabGroups.close(custom()[0]);
    assert.equal(custom().length, 1); assert.deepEqual(fs.readFileSync(file), bytes);
    checks.push('Two WXME views share a document and close independently');
    await vscode.window.tabGroups.close(custom());
    assert.equal(custom().length, 0);
    fs.copyFileSync(path.join(__dirname, 'fixtures/wxme/text.wxme'), file);
    await open(vscode.ViewColumn.One);
    assert.equal(custom()[0].isDirty, false);
    await vscode.window.tabGroups.close(custom());
    checks.push('WXME closes and reopens after a file replacement');
    const ordinary = path.join(directory, 'ordinary.rkt');
    fs.writeFileSync(ordinary, '#lang racket/base\n42\n');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(ordinary));
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
    assert.equal(vscode.window.activeTextEditor.document.languageId, 'racket');
    checks.push('Ordinary Racket files retain the default text editor');
    return checks;
  } finally { if (custom().length) await vscode.window.tabGroups.close(custom()); }
};
