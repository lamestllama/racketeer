'use strict';
const { spawn } = require('node:child_process');

// LanguageClient cannot stop an initializing connection. Own its process so
// a stalled initialize request can be cancelled before awaiting client.stop().
function createLanguageProcess(command, args, options, { timeout = 180000, onTimeout = () => {} } = {}) {
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
      if (cancelled) throw new Error('Language server startup was cancelled.');
      starting = true;
      // A disconnected server need not have exited when the client restarts.
      if (process) { terminate(); await closed; }
      if (cancelled) throw new Error('Language server startup was cancelled.');
      const child = spawn(command, args, { ...options, windowsHide: true, stdio: 'pipe' });
      process = child;
      closed = new Promise(resolve => child.once('close', () => {
        if (process === child) { process = undefined; clearDeadline(); starting = false; }
        resolve();
      }));
      timer = setTimeout(() => {
        cancelStart();
        onTimeout(new Error(`Language server initialization timed out after ${timeout / 1000} seconds.`));
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

module.exports = { createLanguageProcess };
