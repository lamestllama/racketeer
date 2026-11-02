// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

// LanguageClient cannot stop an initializing connection. Own its process so
// a stalled initialize request can be cancelled before awaiting client.stop().
function createLanguageProcess(command, args, options, { timeout = 180000, onTimeout = () => {}, name = 'Language server' } = {}) {
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
      const child = spawn(command, args, { ...options, windowsHide: true, stdio: 'pipe' });
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

// A server runs in a process tree the extension owns. The tree ends when the
// server ends, which it does when its input closes, including when the
// extension host exits without warning.
function ownedArgs(context, args) {
  return [...debuggerArgs(context, 'tools/owned-command.rkt'), ...args];
}

module.exports = { createLanguageProcess, debuggerArgs, ownedArgs };
