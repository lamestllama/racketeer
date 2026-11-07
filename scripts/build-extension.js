// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../vscode');
const esbuild = require(require.resolve('esbuild', { paths: [root] }));

async function build() {
  require('./stage-extension');
  // These local webview resources are shipped beside the host bundle.
  for (const name of ['view.css','model.js','geometry.js','protocol.js','monaco.js','state.js','page.js','editor.js','decorations.js','overlay.js','details.js','sentence.js','input.js','layout.js','test-hooks.js','messages.js','view.js']) {
    if (!fs.statSync(path.join(root, 'macro-view', name)).isFile()) throw Error(`Missing macro view asset: ${name}`);
  }
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.copyFileSync(require.resolve('vscode-oniguruma/release/onig.wasm', { paths: [root] }), path.join(root, 'out/onig.wasm'));
  const preview = await esbuild.build({
    absWorkingDir: root, entryPoints: ['macro-view/monaco-entry.js'], outfile: 'out/monaco/editor.js',
    bundle: true, platform: 'browser', format: 'iife', globalName: 'MacroMonaco', target: 'es2022',
    minify: true, metafile: true, loader: { '.ttf': 'file' }, assetNames: '[name]'
  });
  for (const input of Object.keys(preview.metafile.inputs)) {
    if (/\/(?:basic-languages|languages\/(?:definitions|features))\//.test(input) || /workerMain\.js$/.test(input)) {
      throw Error(`Unexpected language or worker in preview: ${input}`);
    }
  }
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: ['extension.js'], outfile: 'out/extension.js',
    bundle: true, platform: 'node', format: 'cjs', target: 'node18',
    banner: { js: '/*! Racketeer. Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT */' },
    // The UMD entry hides relative requires inside its factory from esbuild.
    alias: { 'jsonc-parser': require.resolve('jsonc-parser/lib/esm/main.js', { paths: [root] }) },
    external: ['vscode'], metafile: true
  });
  const packages = new Set();
  for (const input of Object.keys({ ...result.metafile.inputs, ...preview.metafile.inputs })) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    // Dual-format packages mark dist/commonjs with an unnamed package.json.
    const named = directory => fs.existsSync(path.join(directory, 'package.json')) &&
      JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name;
    while (!named(directory)) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`No package for ${input}`);
      directory = parent;
    }
    packages.add(directory);
  }
  const notices = [...packages].sort().map(directory => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const license = fs.readdirSync(directory).find(name => /^licen[cs]e(?:\..*)?$/i.test(name));
    if (!license) throw new Error(`Missing license for bundled dependency ${manifest.name}`);
    const thirdParty = path.join(directory, 'ThirdPartyNotices.txt');
    return `${manifest.name} ${manifest.version}\n\n${fs.readFileSync(path.join(directory, license), 'utf8')}${fs.existsSync(thirdParty) ? '\n\n' + fs.readFileSync(thirdParty, 'utf8') : ''}`;
  });
  for (const dependency of ['vscode-textmate', 'vscode-oniguruma', 'jsonc-parser', 'monaco-editor']) {
    if (![...packages].some(directory => JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === dependency)) {
      throw Error(`Missing bundled token dependency: ${dependency}`);
    }
  }
  fs.writeFileSync(path.join(root, 'out/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n'));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
