// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const generated = new Set(['node_modules', 'compiled', 'out', 'runtime', 'language-server']);
const copiedNotices = new Set(['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT']);
function sourceIdentity(directory = root) {
  const files = {};
  function visit(relative) {
    const absolute = path.join(directory, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Build inputs must be ordinary files: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (name === 'compiled' || name === '__pycache__') continue;
        if (relative === 'vscode' && (generated.has(name) || copiedNotices.has(name))) continue;
        visit(`${relative}/${name}`);
      }
    } else files[relative] = hash(fs.readFileSync(absolute));
  }
  for (const name of ['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT', 'info.rkt',
    '.vscode', 'examples', 'experiments', 'racketdap', 'scripts', 'tests', 'vendor', 'vscode'].sort()) visit(name);
  return { sha256: digest(files), files };
}
function archiveContents(artifact) {
  const yauzl = require(require.resolve('yauzl', { paths: [path.join(root, 'vscode')] }));
  return new Promise((resolve, reject) => {
    yauzl.open(artifact, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const files = {};
      zip.on('error', reject);
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        if (Object.hasOwn(files, entry.fileName)) { zip.close(); reject(new Error('Duplicate VSIX entry')); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { reject(error); return; }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => { files[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
      zip.readEntry();
    });
  });
}
async function recordArtifact(artifact, source, { directory = root } = {}) {
  if (source.sha256 !== sourceIdentity(directory).sha256) throw new Error('Build inputs changed during packaging; rebuild before verification.');
  const contents = await archiveContents(artifact);
  const metadata = JSON.parse(contents['extension/package.json']);
  const manifest = {
    schema: 1, artifact: path.basename(artifact), sha256: hash(fs.readFileSync(artifact)),
    extension: `${metadata.publisher}.${metadata.name}`, version: metadata.version,
    source, contents: Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, hash(bytes)]))
  };
  fs.writeFileSync(`${artifact}.build.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
async function verifyArtifact(artifact, { directory = root, installed } = {}) {
  const manifest = JSON.parse(fs.readFileSync(`${artifact}.build.json`, 'utf8'));
  if (manifest.schema !== 1 || manifest.sha256 !== hash(fs.readFileSync(artifact))) throw new Error('VSIX hash does not match its build manifest.');
  const source = sourceIdentity(directory);
  if (manifest.source.sha256 !== digest(manifest.source.files) || digest(source.files) !== digest(manifest.source.files)) {
    throw new Error('Stale VSIX: source or test inputs differ from the build manifest; rebuild the artifact.');
  }
  const contents = await archiveContents(artifact);
  const hashes = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, hash(bytes)]));
  if (digest(hashes) !== digest(manifest.contents)) throw new Error('VSIX contents differ from the build manifest.');
  const metadata = JSON.parse(contents['extension/package.json']);
  if (manifest.extension !== `${metadata.publisher}.${metadata.name}` || manifest.version !== metadata.version) throw new Error('VSIX extension identity differs from the build manifest.');
  let verifiedFiles = 0;
  if (installed) {
    const expected = new Set();
    for (const [name, bytes] of Object.entries(contents)) {
      if (!name.startsWith('extension/')) continue;
      const relative = name.slice('extension/'.length);
      expected.add(relative);
      const target = path.resolve(installed, relative);
      if (!target.startsWith(`${path.resolve(installed)}${path.sep}`)) throw new Error(`Invalid VSIX path: ${name}`);
      if (!fs.lstatSync(target).isFile()) throw new Error(`Installed extension file is not ordinary: ${relative}`);
      const actual = fs.readFileSync(target);
      if (relative === 'package.json') {
        const expectedJSON = JSON.parse(bytes), actualJSON = JSON.parse(actual);
        delete actualJSON.__metadata;
        if (digest(expectedJSON) !== digest(actualJSON)) throw new Error('Installed package.json differs from the VSIX.');
      } else if (hash(bytes) !== hash(actual)) throw new Error(`Installed extension differs from the VSIX: ${relative}`);
      verifiedFiles++;
    }
    function checkUnexpected(relative = '') {
      for (const entry of fs.readdirSync(path.join(installed, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) checkUnexpected(name);
        else if (name === '.vsixmanifest' && contents['extension.vsixmanifest']) {
          if (hash(fs.readFileSync(path.join(installed, name))) !== hash(contents['extension.vsixmanifest'])) {
            throw new Error('Installed VSIX manifest differs from the artifact.');
          }
        } else if (!expected.has(name)) throw new Error(`Unexpected installed extension file: ${name}`);
      }
    }
    checkUnexpected();
  }
  return { path: path.resolve(artifact), sha256: manifest.sha256, extension: manifest.extension,
    version: manifest.version, sourceSha256: source.sha256, manifest: `${path.resolve(artifact)}.build.json`,
    ...(installed ? { installed: path.resolve(installed), verifiedFiles } : {}) };
}
if (require.main === module) {
  if (process.argv[2] !== 'verify' || !process.argv[3]) throw new Error('Usage: node scripts/artifact.js verify ARTIFACT [INSTALLED_DIRECTORY]');
  verifyArtifact(path.resolve(process.argv[3]), { installed: process.argv[4] }).then(
    result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { sourceIdentity, recordArtifact, verifyArtifact, archiveContents };
