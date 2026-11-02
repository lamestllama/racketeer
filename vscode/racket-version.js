// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const required = [9, 1];
const requiredText = required.join('.');

// The file a command name runs, found the way a child process finds it.
function racketPath(executable, env = process.env) {
  if (path.basename(executable) !== executable) return path.resolve(executable);
  const key = Object.keys(env).find(name => process.platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH');
  const suffixes = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const directory of (key ? env[key] : '').split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory || '.', executable + suffix);
      try { if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch { /* Not in this directory. */ }
    }
  }
  return executable;
}

// What is wrong with the Racket whose --version wrote this, in words for its user.
function versionProblem(stdout, executable, env) {
  const version = /v((\d+)\.(\d+)[\d.]*)/.exec(stdout);
  const major = Number(version?.[2]), minor = Number(version?.[3]);
  if (major > required[0] || (major === required[0] && minor >= required[1])) return undefined;
  const found = racketPath(executable, env);
  return `${version ? `Racket ${version[1]} at ${found} is too old` : `${found} did not report a Racket version`}: ` +
    `Racketeer needs Racket ${requiredText} or newer. Set racketdap.racketExecutable to a newer Racket.`;
}

// Why this executable is too old, or nothing. One that cannot run says so itself when
// it is started, so that is not a concern here.
function racketTooOld(executable) {
  return new Promise(resolve => {
    execFile(executable, ['--version'], { timeout: 10000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : versionProblem(stdout, executable));
    });
  });
}

module.exports = { racketPath, versionProblem, racketTooOld };
