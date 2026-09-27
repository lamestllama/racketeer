'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const dependency = path.join(root, 'vscode/node_modules/vscode-languageclient');
const manifest = JSON.parse(fs.readFileSync(path.join(dependency, 'package.json'), 'utf8'));
if (manifest.version !== '9.0.1') throw new Error('Review the language-client startup patch before changing vscode-languageclient 9.0.1.');
const filename = path.join(dependency, 'lib/common/client.js');
const originalHash = '9d49ea9912f652bbdf749ddcd7e15526981c81355b3ff3c7bfb4277c405308d2';
const patchedHash = 'bd409b63e59f536184d9451fb08aeeb9dd720d48e4450040c94234c67873c8f3';
const hash = text => createHash('sha256').update(text).digest('hex');
const source = fs.readFileSync(filename, 'utf8');
if (hash(source) !== patchedHash) {
  if (hash(source) !== originalHash) throw new Error('Unexpected language-client source; refusing to apply its startup patch.');
  const patch = fs.readFileSync(path.join(root, 'vendor/patches/vscode-languageclient-start-promise.patch'), 'utf8');
  const hunks = patch.split(/^@@[^\n]*\n/m);
  if (hunks.length !== 2) throw new Error('Expected one language-client patch hunk.');
  const lines = hunks[1].trimEnd().split('\n');
  if (lines.some(line => ![' ', '+', '-'].includes(line[0]))) throw new Error('Invalid language-client patch hunk.');
  const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
  const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
  if (source.split(before).length !== 2) throw new Error('Language-client patch does not match exactly once.');
  const updated = source.replace(before, after);
  if (hash(updated) !== patchedHash) throw new Error('Language-client patch produced an unexpected source hash.');
  fs.writeFileSync(filename, updated);
}
