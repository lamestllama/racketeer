'use strict';
const path = require('node:path');
const { createLanguageProcess } = require('./language-process');

async function requestDependencies(executable, helper, collects, request, { signal, timeout = 20000 } = {}) {
  if (signal?.aborted) throw signal.reason;
  let failure;
  const process = createLanguageProcess(executable, ['-S', collects, helper], { cwd: path.dirname(request.path) },
    { timeout, name: 'Module dependency analysis', onTimeout: error => { failure = error; } });
  const cancel = () => { failure ||= signal.reason || new Error('Dependency analysis cancelled.'); void process.dispose(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const child = await process.start();
    if (signal?.aborted) cancel();
    return await new Promise((resolve, reject) => {
      let size = 0, errors = '';
      const chunks = [];
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          failure ||= new Error('Dependency result exceeds 8 MiB.'); void process.dispose();
        } else chunks.push(chunk);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', text => { errors = (errors + text).slice(-8192); });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') { failure ||= error; void process.dispose(); } });
      child.once('close', code => {
        if (failure) { reject(failure); return; }
        try {
          if (code !== 0) throw new Error(errors.trim() || `Analysis exited with code ${code}.`);
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.version !== 1 || !Array.isArray(result.modules) || !Array.isArray(result.files)) throw new Error('Invalid dependency response.');
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.write(JSON.stringify(request) + '\n');
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
    await process.dispose();
  }
}
module.exports = { requestDependencies };
