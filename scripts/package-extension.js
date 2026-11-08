// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceIdentity, recordArtifact } = require('./artifact');
const root = path.resolve(__dirname, '..');
async function main() {
  const manifest = require('../vscode/package.json');
  const output = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(`${output}.build.json`, { force: true });
  const source = sourceIdentity();
  const vsce = require.resolve('@vscode/vsce/vsce', { paths: [path.join(root, 'vscode')] });
  const result = spawnSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', output],
    { cwd: path.join(root, 'vscode'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; return; }
  const recorded = await recordArtifact(output, source);
  for (const file of ['out/extension.js', 'out/monaco/editor.js', 'out/monaco/editor.css', 'out/monaco/codicon.ttf', 'out/onig.wasm', 'out/THIRD_PARTY_NOTICES.txt', 'syntaxes/racket.tmLanguage.json',
    'macro-view/model.js', 'macro-view/geometry.js', 'macro-view/protocol.js', 'macro-view/monaco.js', 'macro-view/state.js', 'macro-view/page.js', 'macro-view/editor.js', 'macro-view/decorations.js', 'macro-view/overlay.js', 'macro-view/details.js', 'macro-view/sentence.js', 'macro-view/input.js', 'macro-view/layout.js', 'macro-view/test-hooks.js', 'macro-view/messages.js', 'macro-view/view.js', 'macro-view/view.css']) {
    if (!recorded.contents[`extension/${file}`]) throw Error(`Missing packaged token resource: ${file}`);
  }
  console.log(`Artifact SHA256: ${recorded.sha256}\nBuild manifest: ${output}.build.json`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
