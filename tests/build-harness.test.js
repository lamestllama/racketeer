// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('./support/node-test');
const { spawnSync } = require('node:child_process');
const { sourceIdentity, recordArtifact, verifyArtifact, archiveContents } = require('../scripts/artifact');
const { inventory } = require('../scripts/test-headless');
const { load } = require('./support/macro-common');
const { startPage } = require('./support/macro-page-startup');
const root = path.resolve(__dirname, '..');

test('token dependencies are production dependencies bundled with their wasm and grammar', () => {
  const manifest = require('../vscode/package.json');
  for (const name of ['vscode-textmate', 'vscode-oniguruma', 'jsonc-parser', 'monaco-editor']) {
    const installed = require(path.join(root, 'vscode/node_modules', name, 'package.json'));
    assert.equal(manifest.dependencies[name], installed.version);
    assert.equal(manifest.devDependencies[name], undefined);
    const lock = require('../vscode/package-lock.json');
    assert.equal(lock.packages[''].dependencies[name], installed.version);
    assert.notEqual(lock.packages[`node_modules/${name}`].dev, true);
  }
  const build = fs.readFileSync(path.join(root, 'scripts/build-extension.js'), 'utf8');
  assert.match(build, /bundle: true/); assert.match(build, /external: \['vscode'\]/);
  assert.match(build, /copyFileSync\(require.resolve\('vscode-oniguruma\/release\/onig.wasm'/);
  const packaging = fs.readFileSync(path.join(root, 'scripts/package-extension.js'), 'utf8');
  for (const file of ['out/onig.wasm', 'syntaxes/racket.tmLanguage.json']) assert.ok(packaging.includes(file));
  const ignore = fs.readFileSync(path.join(root, 'vscode/.vscodeignore'), 'utf8');
  assert.doesNotMatch(ignore, /^(?:out|syntaxes)\//m);
});

test('packaged extension loads without development dependencies and has usable token resources', async t => {
  const manifest = require('../vscode/package.json');
  const artifact = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  const contents = await archiveContents(artifact);
  for (const file of ['selected-editor.js', 'test-coverage.js', 'macro-session-pool.js'])
    assert.equal(contents['extension/' + file], undefined, 'Bundled host source is excluded: ' + file);
  assert.ok(!Object.keys(contents).some(name => /^extension\/language-server\/collects\/.*\/tests\//.test(name)));
  for (const file of ['README.md', 'patches/analysis-wait.patch', 'patches/clamp-protocol-columns.patch',
    'patches/lazy-documentation.patch', 'patches/url-string.patch',
    'patches/predicted-bindings.patch', 'patches/tail-position-hover.patch', 'collects/racket-langserver/LICENSE',
    'collects/fixw/LICENSE-MIT', 'collects/fixw/LICENSE-APACHE-2.0'])
    assert.ok(contents['extension/language-server/' + file], 'Vendor provenance remains packaged: ' + file);
  const html = load({ vscode: { Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') } } })
    .panelHtml({ cspSource: 'local:', asWebviewUri: uri => uri }, 'extension');
  const pageScripts = [...html.matchAll(/<script nonce="([^"]+)" src="extension\/(macro-view\/[^"]+)"/g)];
  assert.ok(pageScripts.length > 5);
  assert.equal(new Set(pageScripts.map(match => match[1])).size, 1);
  for (const [, nonce, file] of pageScripts) {
    assert.ok(html.includes("script-src 'nonce-" + nonce + "'"));
    assert.ok(contents['extension/' + file], 'Missing packaged page script: ' + file);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-packaged-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(contents)) {
    if (!name.startsWith('extension/')) continue;
    const file = path.resolve(directory, name.slice('extension/'.length));
    assert.ok(file.startsWith(directory + path.sep));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const directory = process.cwd();
    // Only the editor API is supplied by the host. Every other dependency must
    // resolve inside the installed extension or be a Node built-in.
    const vscode = Object.fromEntries([
      'CompletionItem', 'CodeLens', 'DocumentLink', 'CodeAction', 'Diagnostic',
      'CallHierarchyItem', 'TypeHierarchyItem', 'SymbolInformation', 'InlayHint',
      'CancellationError'
    ].map(name => [name, class {}]));
    const load = Module._load;
    Module._load = function(name, parent, isMain) {
      if (name === 'vscode') return vscode;
      if (!Module.isBuiltin(name)) {
        const filename = Module._resolveFilename(name, parent, isMain);
        assert.ok(filename.startsWith(directory + path.sep), 'Dependency outside VSIX: ' + name);
      }
      return load.call(this, name, parent, isMain);
    };
    const manifest = require('./package.json');
    const extension = require(path.resolve(manifest.main));
    assert.equal(typeof extension.activate, 'function');
    assert.equal(typeof extension.deactivate, 'function');
    const pageScripts = ${JSON.stringify(pageScripts.map(match => match[2]))};
    const page = (${startPage.toString()})(pageScripts.map(file => [file, fs.readFileSync(file, 'utf8')]));
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].type, 'ready');
    assert.equal(page.messages[0].v, 1);
    assert.equal(typeof page.listeners.get('message'), 'function');
    assert.ok(page.elements.get('geometry').sheet.cssRules.length > 0);
    const wasm = fs.readFileSync(path.join(path.dirname(manifest.main), 'onig.wasm'));
    new WebAssembly.Module(wasm);
    const grammar = JSON.parse(fs.readFileSync('syntaxes/racket.tmLanguage.json', 'utf8'));
    assert.equal(grammar.scopeName, 'source.racket');
    const monaco = fs.readFileSync('out/monaco/editor.js', 'utf8');
    assert.ok(monaco.includes('MacroMonaco'));
    new (require('node:vm').Script)(monaco);
    const css = fs.readFileSync('out/monaco/editor.css', 'utf8');
    assert.ok(css.includes('.monaco-editor'));
    assert.ok(css.includes('codicon.ttf'));
    const font = fs.readFileSync('out/monaco/codicon.ttf');
    assert.equal(font.readUInt32BE(0), 0x00010000);
    const notices = fs.readFileSync('out/THIRD_PARTY_NOTICES.txt', 'utf8');
    assert.ok(notices.includes('monaco-editor 0.57.0'));
    assert.ok(notices.includes('THIRD-PARTY SOFTWARE NOTICES AND INFORMATION'));
    assert.equal(fs.existsSync('node_modules'), false);
    assert.deepEqual(fs.readdirSync('out/monaco').sort(), ['codicon.ttf', 'editor.css', 'editor.js']);
  `], { cwd: directory, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr || String(result.error));
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-build-'));
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
  const macroSuites = names.filter(name => name.startsWith('macro-stepper-') && name.endsWith('.test.js'));
  assert.ok(macroSuites.length > 1);
  for (const name of macroSuites) assert.ok(suites.node.includes('tests/' + name));
  assert.ok(!suites.node.includes('tests/macro-stepper.test.js'));
  assert.deepEqual(suites.node, names.filter(n => n.endsWith('.test.js') && !['gui-parity.test.js', 'plots-gui.test.js'].includes(n)).sort().map(n => `tests/${n}`));
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

test('headless entry point prepares bundled dependencies in a fresh checkout', async t => {
  const { directory } = await fixture(t);
  for (const name of ['test-headless.js', 'stage-extension.js']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
  }
  fs.writeFileSync(path.join(directory, 'experiments/lexical-eval.rkt'), '#lang racket/base\n');
  fs.writeFileSync(path.join(directory, 'vendor/dependency.rkt'), '#lang racket/base\n');
  fs.writeFileSync(path.join(directory, 'tests/staged.test.js'), `
    const assert = require('node:assert/strict'), fs = require('node:fs');
    assert.equal(fs.readFileSync('vscode/language-server/dependency.rkt', 'utf8'),
      fs.readFileSync('vendor/dependency.rkt', 'utf8'));
    assert.equal(fs.readFileSync('vscode/runtime/racketdap/main.rkt', 'utf8'),
      fs.readFileSync('racketdap/main.rkt', 'utf8'));
    fs.writeFileSync('probe-passed', 'yes');
  `);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['scripts/test-headless.js'],
    { cwd: directory, env, encoding: 'utf8', timeout: 240000 });
  assert.equal(result.status, 0, result.stdout + result.stderr || String(result.error));
  assert.equal(fs.readFileSync(path.join(directory, 'probe-passed'), 'utf8'), 'yes');
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
