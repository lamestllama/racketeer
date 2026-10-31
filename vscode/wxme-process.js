'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

// Each codec worker owns no child processes. Its input pipe is a lease:
// closing it also stops a worker whose extension host has exited unexpectedly.
function decodeWxme(command, helper, file, { signal, timeout = 60000 } = {}) {
  return requestWxme(command, helper, file, { path: file }, { signal, timeout });
}

function requestWxme(command, helper, file, request, { signal, timeout = 60000, outputLimit = 48 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let child, deadline, fallback, failure, length = 0, stderr = '';
    const chunks = [];
    const stop = error => {
      if (failure) return;
      failure = error;
      child.stdin.destroy();
      fallback = setTimeout(() => child.kill('SIGKILL'), 1500);
      fallback.unref();
    };
    const cancelled = () => stop(signal.reason || new Error('WXME viewing cancelled.'));
    try {
      child = spawn(command, [helper], { cwd: path.dirname(file), windowsHide: true, stdio: 'pipe' });
    } catch (error) { reject(error); return; }
    child.on('error', error => { failure ||= new Error(`Cannot start WXME viewer: ${error.message}. Check racketdap.racketExecutable.`); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > outputLimit) stop(new Error('WXME worker output exceeds its limit.'));
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('close', code => {
      clearTimeout(deadline); clearTimeout(fallback);
      signal?.removeEventListener('abort', cancelled);
      if (failure) { reject(failure); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error) throw new Error(result.error);
        if (code !== 0 || !Array.isArray(result.parts)) throw new Error('Invalid decoder response.');
        resolve(result);
      } catch (error) { reject(new Error(`Cannot view WXME: ${error.message}${stderr ? `\n${stderr}` : ''}`)); }
    });
    signal?.addEventListener('abort', cancelled, { once: true });
    deadline = setTimeout(() => stop(new Error('WXME viewer timed out after 60 seconds.')), timeout);
    child.stdin.write(JSON.stringify(request) + '\n');
    if (signal?.aborted) cancelled();
  });
}

module.exports = { decodeWxme, requestWxme };
