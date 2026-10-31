'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../vscode');
const esbuild = require(require.resolve('esbuild', { paths: [root] }));

async function build() {
  require('./stage-extension');
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: ['extension.js'], outfile: 'out/extension.js',
    bundle: true, platform: 'node', format: 'cjs', target: 'node18',
    banner: { js: '/*! Racketeer. Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT */' },
    external: ['vscode'], metafile: true
  });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
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
    return `${manifest.name} ${manifest.version}\n\n${fs.readFileSync(path.join(directory, license), 'utf8')}`;
  });
  fs.writeFileSync(path.join(root, 'out/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n'));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
