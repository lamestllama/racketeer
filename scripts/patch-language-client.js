'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const hash = text => createHash('sha256').update(text).digest('hex');
const patches = [
  ['vscode-languageclient', '9.0.1', 'lib/common/client.js', 'vscode-languageclient-start-promise.patch',
    '9d49ea9912f652bbdf749ddcd7e15526981c81355b3ff3c7bfb4277c405308d2',
    'bd409b63e59f536184d9451fb08aeeb9dd720d48e4450040c94234c67873c8f3'],
  ['vscode-jsonrpc', '8.2.0', 'lib/common/connection.js', 'vscode-jsonrpc-write-rejection.patch',
    'b21227f1c33f30114dd20c38116db829db0799d39f06bba062a3fa68d0e25a61',
    '1f0d817916f46d8b142f18728771a55967e7aedeaff0bd37bf969394dc5485e9']
];
for (const [name, version, file, patchName, originalHash, patchedHash] of patches) {
  const dependency = path.join(root, 'vscode/node_modules', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dependency, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Review ${patchName} before changing ${name} ${version}.`);
  const filename = path.join(dependency, file);
  const source = fs.readFileSync(filename, 'utf8');
  if (hash(source) === patchedHash) continue;
  if (hash(source) !== originalHash) throw new Error(`Unexpected ${name} source; refusing to apply ${patchName}.`);
  const patch = fs.readFileSync(path.join(root, 'vendor/patches', patchName), 'utf8');
  const hunks = patch.split(/^@@[^\n]*\n/m);
  if (hunks.length !== 2) throw new Error(`Expected one patch hunk in ${patchName}.`);
  const lines = hunks[1].trimEnd().split('\n');
  if (lines.some(line => ![' ', '+', '-'].includes(line[0]))) throw new Error(`Invalid patch hunk in ${patchName}.`);
  const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
  const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
  if (source.split(before).length !== 2) throw new Error(`${patchName} does not match exactly once.`);
  const updated = source.replace(before, after);
  if (hash(updated) !== patchedHash) throw new Error(`${patchName} produced an unexpected source hash.`);
  fs.writeFileSync(filename, updated);
}
