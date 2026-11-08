// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs');
const { racketPath, versionProblem } = require('./racket-version');

function executableIdentity(executable, env) {
  try {
    const resolved = fs.realpathSync(racketPath(executable, env));
    const stat = fs.statSync(resolved, { bigint: true });
    if (!stat.isFile()) return undefined;
    return JSON.stringify([executable, resolved, process.cwd(),
      [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
      Object.keys(env).sort().map(key => [key, env[key]])]);
  } catch { return undefined; }
}

// Keep this cache with the debug configuration provider. Other tools retain
// their own version checks, and failed probes never validate an executable.
function createDebugVersionCheck(execute) {
  let validated;
  const pending = new Map();
  return async executable => {
    const env = { ...process.env };
    const identity = executableIdentity(executable, env);
    if (identity && validated === identity) return undefined;
    validated = undefined;
    if (identity && pending.has(identity)) return pending.get(identity);
    const request = (async () => {
      const { stdout } = await execute(executable, ['--version'],
        { env, timeout: 5000, killSignal: 'SIGKILL', windowsHide: true });
      return versionProblem(stdout, executable, env);
    })();
    if (identity) pending.set(identity, request);
    try {
      const problem = await request;
      if (!problem && identity) validated = identity;
      return problem;
    } finally {
      if (identity) pending.delete(identity);
    }
  };
}
module.exports = { createDebugVersionCheck };
