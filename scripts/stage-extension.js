// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const name of ['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT']) {
  fs.copyFileSync(path.join(root, name), path.join(root, 'vscode', name));
}
const runtime = path.join(root, 'vscode/runtime');
fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtime, { recursive: true });
fs.cpSync(path.join(root, 'racketdap'), path.join(runtime, 'racketdap'), {
  recursive: true,
  filter: file => path.basename(file) !== 'compiled'
});
const server = path.join(root, 'vscode/language-server');
fs.rmSync(server, { recursive: true, force: true });
fs.cpSync(path.join(root, 'vendor'), server, {
  recursive: true,
  filter: file => path.basename(file) !== 'compiled'
});
console.log('Staged debugger, language server, dependencies, and license notices.');
