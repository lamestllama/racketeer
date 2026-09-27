'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { sourceIdentity, recordArtifact, verifyArtifact, archiveContents } = require('../scripts/artifact');
const { inventory } = require('../scripts/test-headless');
const root = path.resolve(__dirname, '..');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT', 'info.rkt']) fs.writeFileSync(path.join(directory, name), name);
  for (const name of ['.vscode', 'examples', 'experiments', 'racketdap', 'scripts', 'tests', 'vendor', 'vscode']) fs.mkdirSync(path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'racketdap/main.rkt'), '#lang racket/base\n');
  const metadata = { name: 'racketeer', publisher: 'lamestllama', version: '0.7.1', main: './out/extension.js' };
  fs.writeFileSync(path.join(directory, 'vscode/package.json'), JSON.stringify(metadata));
  const artifact = path.join(directory, 'same-version.vsix');
  const { ZipFile } = require(require.resolve('yazl', { paths: [path.join(root, 'vscode')] }));
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(metadata)), 'extension/package.json');
  zip.addBuffer(Buffer.from('module.exports = {};'), 'extension/out/extension.js');
  zip.addBuffer(Buffer.from('manifest'), 'extension.vsixmanifest');
  const output = fs.createWriteStream(artifact);
  zip.outputStream.pipe(output);
  zip.end();
  await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
  await recordArtifact(artifact, sourceIdentity(directory), { directory });
  return { directory, artifact };
}

test('headless entry point discovers every native and Node suite except explicit GUI tests', () => {
  const suites = inventory();
  const names = fs.readdirSync(path.join(root, 'tests'));
  assert.deepEqual(suites.node, names.filter(n => n.endsWith('.test.js') && !['gui-parity.test.js', 'macro-stepper-gui.test.js'].includes(n)).sort().map(n => `tests/${n}`));
  assert.deepEqual(suites.racket, [...names.filter(n => n.endsWith('.rkt')).sort().map(n => `tests/${n}`), 'experiments/lexical-eval.rkt']);
  assert.equal(require('../vscode/package.json').scripts.test, 'node ../scripts/test-headless.js');
  const task = JSON.parse(fs.readFileSync(path.join(root, '.vscode/tasks.json'))).tasks.find(t => t.label === 'Racket: Check adapter protocol and extension logic');
  assert.deepEqual(task.args, ['scripts/test-headless.js']);
});

test('editor orchestration uses fresh state and sanitized collection paths', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-B', path.join(__dirname, 'harness-checks.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('a same-version artifact is rejected when a source or test input changes', async t => {
  const { directory, artifact } = await fixture(t);
  const verified = await verifyArtifact(artifact, { directory });
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(directory, 'tests/new-regression.test.js'), 'changed');
  await assert.rejects(verifyArtifact(artifact, { directory }), /Stale VSIX/);
});

test('archive tampering and missing build manifests cannot pass verification', async t => {
  const { directory, artifact } = await fixture(t);
  fs.appendFileSync(artifact, 'changed');
  await assert.rejects(verifyArtifact(artifact, { directory }), /VSIX hash/);
  fs.unlinkSync(`${artifact}.build.json`);
  await assert.rejects(verifyArtifact(artifact, { directory }), /ENOENT/);
});

test('installed files must match the exact artifact, allowing only editor metadata', async t => {
  const { directory, artifact } = await fixture(t);
  const installed = path.join(directory, 'installed');
  for (const [name, bytes] of Object.entries(await archiveContents(artifact))) {
    const file = path.join(installed, name.startsWith('extension/') ? name.slice(10) : '.vsixmanifest');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const manifestPath = path.join(installed, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(manifestPath));
  metadata.__metadata = { installedTimestamp: 1 };
  fs.writeFileSync(manifestPath, JSON.stringify(metadata));
  assert.equal((await verifyArtifact(artifact, { directory, installed })).verifiedFiles, 2);
  const extensionPath = path.join(installed, 'out/extension.js');
  fs.appendFileSync(extensionPath, 'changed');
  await assert.rejects(verifyArtifact(artifact, { directory, installed }), /Installed extension differs/);
  fs.writeFileSync(extensionPath, 'module.exports = {};');
  fs.writeFileSync(path.join(installed, 'unexpected.js'), 'old content');
  await assert.rejects(verifyArtifact(artifact, { directory, installed }), /Unexpected installed extension file/);
});
