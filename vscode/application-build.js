// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const path = require('node:path');

const actions = new Set(['launcher', 'executable', 'distribution']);
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a nonempty path or name.`);
  return value;
}
function strings(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map(item => text(item, name));
}
// Windows and macOS file systems compare names without regard to case by default.
const foldsCase = platform => platform === 'win32' || platform === 'darwin';
function executablePath(output, gui, platform = process.platform) {
  const extension = platform === 'win32' ? '.exe' : platform === 'darwin' && gui ? '.app' : '';
  const ending = output.slice(-extension.length);
  const present = foldsCase(platform) ? ending.toLowerCase() === extension : ending === extension;
  return extension && !present ? output + extension : output;
}
function sameFile(cwd, first, second, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const [a, b] = [first, second].map(name => paths.resolve(cwd, name));
  return foldsCase(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Only public raco options are assembled here. ProcessExecution resolves native
// task variables and supplies each argument separately; no shell quoting occurs.
function buildPlan(definition, cwd, platform = process.platform) {
  const { action } = definition;
  if (!actions.has(action)) throw new Error('Choose launcher, executable or distribution.');
  const source = text(definition.source, 'source');
  let output = text(definition.output, 'output');
  const gui = definition.gui ?? false;
  if (typeof gui !== 'boolean') throw new Error('gui must be true or false.');
  const libraries = strings(definition.libraries, 'libraries');
  const languages = strings(definition.languages, 'languages');
  if (action !== 'executable' && (libraries.length || languages.length))
    throw new Error('Additional libraries and languages apply to embedded executables.');
  if (action === 'distribution' && gui) throw new Error('The distribution inherits its GUI mode from the executable.');
  if (action !== 'distribution') output = executablePath(output, gui, platform);
  if (source === output || (!source.includes('${') && !output.includes('${') && sameFile(cwd, source, output, platform)))
    throw new Error('Choose an output different from the input.');
  const args = action === 'distribution' ? ['distribute', '--', output, source] : [
    'exe', ...(gui ? ['--gui'] : []),
    // Launchers must see the same user packages as the selected Racket runtime.
    ...(action === 'launcher' ? ['--launcher', '--exf', '-U'] : []),
    ...libraries.flatMap(name => ['++lib', name]), ...languages.flatMap(name => ['++lang', name]),
    '-o', output, '--', source
  ];
  return { args, output, source, action, gui };
}

module.exports = { buildPlan, executablePath };
