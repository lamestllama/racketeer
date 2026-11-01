// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function setup() {
  const uri = name => ({ scheme: 'file', fsPath: name, toString: () => 'file://' + name });
  class TabInputCustom { constructor(uri, viewType = 'racketeer.wxmeEditor') { this.uri = uri; this.viewType = viewType; } }
  const tab = { input: new TabInputCustom(uri('/wxme.rkt')), isDirty: false };
  const saves = [], vscode = { TabInputCustom,
    window: { tabGroups: { activeTabGroup: { activeTab: tab }, all: [{ tabs: [tab] }] }, activeTextEditor: { document: { uri: uri('/other.rkt'), languageId: 'racket', isDirty: false } } },
    workspace: { textDocuments: [], getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: () => 'racket' }),
      save: async uri => { saves.push(uri.fsPath); tab.isDirty = false; return uri; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vscode/execution.js'), 'utf8'), { module, require: name => name === 'vscode' ? vscode : require(name) });
  return { tab, saves, vscode, activeTarget: module.exports.activeTarget };
}
test('WXME commands capture the active custom document instead of a background text editor', async () => {
  const h = setup();
  assert.equal((await h.activeTarget({ allowWxme: true })).program, '/wxme.rkt');
  await assert.rejects(h.activeTarget(), /text editor/);
  h.tab.input.viewType = 'unrelated.editor'; await assert.rejects(h.activeTarget({ allowWxme: true }), /text editor/);
});
test('a dirty WXME target uses the public save API and retains its identity across focus changes', async () => {
  const h = setup(); h.tab.isDirty = true;
  h.vscode.workspace.save = async uri => { h.saves.push(uri.fsPath); h.tab.isDirty = false; h.vscode.window.tabGroups.activeTabGroup.activeTab = undefined; return uri; };
  assert.equal((await h.activeTarget({ allowWxme: true })).program, '/wxme.rkt'); assert.deepEqual(h.saves, ['/wxme.rkt']);
});
test('failed, cancelled or incomplete saves and conflicting text edits prevent launch', async () => {
  const h = setup(); h.tab.isDirty = true;
  for (const save of [async () => undefined, async () => { throw Error('conflict'); }, async uri => uri]) {
    h.vscode.workspace.save = save; await assert.rejects(h.activeTarget({ allowWxme: true }));
  }
  h.tab.isDirty = false; h.vscode.workspace.textDocuments = [{ uri: h.tab.input.uri, isDirty: true }];
  await assert.rejects(h.activeTarget({ allowWxme: true }), /unsaved changes/);
});

test('running a read-only WXME view saves a dirty editable view of the same document', async () => {
  const h = setup(); h.tab.input.viewType = 'racketeer.wxme';
  assert.equal((await h.activeTarget({ allowWxme: true })).program, '/wxme.rkt');
  const editor = { input: new h.vscode.TabInputCustom(h.tab.input.uri), isDirty: true };
  h.vscode.window.tabGroups.all[0].tabs.push(editor);
  h.vscode.workspace.save = async uri => { h.saves.push(uri.fsPath); return uri; };
  await assert.rejects(h.activeTarget({ allowWxme: true }), /could not be saved/);
  h.vscode.workspace.save = async uri => { h.saves.push(uri.fsPath); editor.isDirty = false; return uri; };
  assert.equal((await h.activeTarget({ allowWxme: true })).program, '/wxme.rkt');
  assert.deepEqual(h.saves, ['/wxme.rkt', '/wxme.rkt']);
});
