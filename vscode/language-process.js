// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

// A server can die before cleaning up its children, and a worker can block in
// native code instead of reading EOF. Keep two tiny /bin/sh guards on POSIX:
// one waits for the server, the other for the editor's private pipe. Either
// ending kills their own group. The live guard pins the group identity, so no
// saved numeric group id is ever signalled after its owner has exited.
// Save stdin before backgrounding: the shell otherwise replaces it with /dev/null.
const supervise = `
exec 4<&0
(while IFS= read -r lease; do :; done; kill -KILL 0) <&3 3<&- 4<&- &
"$@" <&4 3<&- 4<&- &
exec 3<&- 4<&-
wait "$!"
kill -KILL 0
`;

function spawnLanguageProcess(command, args, options, owned) {
  const settings = { ...options, windowsHide: true, stdio: 'pipe' };
  if (!owned || process.platform === 'win32') return spawn(command, args, settings);
  const child = spawn('/bin/sh', ['-c', supervise, 'racketeer-server', command, ...args], {
    ...settings, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe']
  });
  // Also release the lease when the waiting shell is killed by editor stop.
  // Descendants never inherit its writing endpoint or keep this pipe open.
  child.once('exit', () => child.stdio[3].destroy());
  child.once('error', () => child.stdio[3]?.destroy());
  return child;
}

// LanguageClient cannot stop an initializing connection. Own its process so
// a stalled initialize request can be cancelled before awaiting client.stop().
function createLanguageProcess(command, args, options, { timeout = 180000, onTimeout = () => {}, name = 'Language server', owned = false } = {}) {
  let process;
  let closed = Promise.resolve();
  let timer;
  let starting = false;
  let cancelled = false;
  function clearDeadline() { clearTimeout(timer); timer = undefined; }
  function terminate() {
    if (!process) return;
    process.kill('SIGKILL');
    // Descendants can retain inherited pipe descriptors after this child exits.
    // Close our transport endpoints so they cannot keep initialization or the
    // child's close event pending; close still waits for the owned child exit.
    process.stdin.destroy();
    process.stdout.destroy();
    process.stderr.destroy();
  }
  function cancelStart() {
    if (!starting) return;
    cancelled = true;
    clearDeadline();
    terminate();
  }
  return {
    get cancelled() { return cancelled; },
    get starting() { return starting; },
    async start() {
      if (cancelled) throw new Error(`${name} startup was cancelled.`);
      starting = true;
      // A disconnected server need not have exited when the client restarts.
      if (process) { terminate(); await closed; }
      if (cancelled) throw new Error(`${name} startup was cancelled.`);
      const child = spawnLanguageProcess(command, args, options, owned);
      process = child;
      closed = new Promise(resolve => child.once('close', () => {
        if (process === child) { process = undefined; clearDeadline(); starting = false; }
        resolve();
      }));
      timer = setTimeout(() => {
        cancelStart();
        onTimeout(new Error(`${name} initialization timed out after ${timeout / 1000} seconds.`));
      }, timeout);
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return child;
    },
    ready() { starting = false; clearDeadline(); },
    cancelStart,
    async dispose() {
      cancelled = true;
      clearDeadline();
      terminate();
      await closed;
    }
  };
}

// The arguments that start a file of the debugger. Compiled once into the
// extension's storage, so that Racket need not compile it again in memory on
// every start. racketdap/launcher.rkt keeps that from the programs it runs.
function debuggerArgs(context, file) {
  const target = context.asAbsolutePath(`runtime/racketdap/${file}`);
  const storage = context.globalStorageUri?.fsPath;
  return storage ? [context.asAbsolutePath('runtime/racketdap/launcher.rkt'), path.join(storage, 'debugger'), target] : [target];
}

// POSIX ownership lives in spawnLanguageProcess. Windows needs the Racket
// supervisor's kill-on-close job object; taskkill cannot run after host death.
function ownedArgs(context, args) {
  return process.platform === 'win32'
    ? [...debuggerArgs(context, 'tools/owned-command.rkt'), '--supervise-input', ...args]
    : args;
}

module.exports = { createLanguageProcess, debuggerArgs, ownedArgs };
