'use strict';
const { spawn } = require('node:child_process');

// The Racket supervisor owns its GUI worker and process-group lease. Closing
// stdin also releases it after an abrupt extension-host exit, without keeping
// a numeric process-group id in JavaScript after its leader might have exited.
function createMacroProcess(command, helper, request, { output, failure, finished }) {
  let child, deadline, cancelled = false, ended = false, started = false;
  let stderr = '', spawnError;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function finish(code) {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    if (!cancelled && (spawnError || code !== 0)) {
      failure(spawnError
        ? `Cannot start Racket macro stepper: ${spawnError.message}. Check racketdap.racketExecutable.`
        : `Racket macro stepper failed: ${stderr.trim() || `process exited with code ${code}`}. A full Racket installation with macro-debugger and a working graphical display is required.`);
    }
    finished(cancelled ? 0 : code || 0);
    resolveDone();
  }
  return {
    done,
    start() {
      if (started) return;
      started = true;
      if (cancelled) { finish(0); return; }
      try {
        child = spawn(command, [helper], { cwd: request.cwd, windowsHide: true, stdio: 'pipe' });
      } catch (error) { spawnError = error; finish(1); return; }
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', output);
      child.stderr.on('data', text => { stderr = (stderr + text).slice(-8192); output(text); });
      child.on('error', error => { spawnError = error; });
      child.stdin.on('error', error => {
        // EPIPE accompanies a worker's early failure; stderr/exit provide the
        // useful diagnostic. Never allow a rejected write to crash the host.
        if (error.code !== 'EPIPE' && !cancelled) spawnError = error;
      });
      child.once('close', code => finish(code ?? 1));
      child.stdin.write(JSON.stringify(request) + '\n');
    },
    stop() {
      cancelled = true;
      if (!started) { finish(0); return done; }
      if (ended) return done;
      child?.stdin.end();
      // Normally EOF makes the supervisor reap everything. If the supervisor
      // itself stalls, killing it closes the independent group's lease too.
      deadline ??= setTimeout(() => {
        child?.kill('SIGKILL');
        child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
      }, 1500);
      deadline.unref?.();
      return done;
    }
  };
}

module.exports = { createMacroProcess };
