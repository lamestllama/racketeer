// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const { createMacroProcess } = require('../macro-process');

// One sequential request stream per owned worker. The byte ceiling resets at
// every newline, even when several replies arrive in one stdout chunk.
function createMacroSession(command, helper, request, { finished = () => {}, checkpoint, idleMs = 0,
  queryMs = 10000, factory = createMacroProcess } = {}) {
  const LIMIT = 64 * 1024 * 1024;
  let buffer = '', received = 0, pending, closed = false, idle, started = false, deciding = false;
  let tail = Promise.resolve();
  const fail = error => { pending?.reject(error); pending = null; };
  const process = factory(command, helper, request, {
    output(text) {
      if (closed) return;
      for (const part of text.split(/(?<=\n)/)) {
        received += Buffer.byteLength(part);
        if (received - Number(part.endsWith('\n')) > LIMIT) { fail(Error('Macro stepper answer exceeds 64 MiB')); void session.stop(); return; }
        buffer += part;
        if (!part.endsWith('\n')) continue;
        const line = buffer.trim(); buffer = ''; received = 0;
        if (!line) continue;
        try {
          if (!pending) throw Error('Unexpected macro session reply');
          const reply = JSON.parse(line);
          if (reply.mode === 'checkpoint') {
            if (deciding || !checkpoint || reply.schemaVersion !== 2 || !Number.isSafeInteger(reply.count) || reply.count <= 0 ||
                reply.snapshot?.sourceHash !== request.snapshot?.sourceHash || reply.snapshot?.sourceVersion !== request.snapshot?.sourceVersion) throw Error('Invalid checkpoint');
            deciding = true;
            Promise.resolve().then(() => closed ? undefined : checkpoint(reply)).then(decision => {
              if (closed) return;
              deciding = false;
              if (!process.send({ mode: 'checkpointDecision', snapshot: request.snapshot, count: reply.count,
                decision: decision === 'stop' ? 'stop' : 'continue' })) throw Error('Macro session is unavailable');
            }).catch(error => { fail(error); void session.stop(); });
            continue;
          }
          const terminalFailure = deciding && typeof reply.failed === 'string' && reply.failed.length > 0 &&
            (reply.failureCode === undefined || typeof reply.failureCode === 'string');
          if (deciding && !terminalFailure) throw Error('Reply while awaiting checkpoint decision');
          const p = pending; pending = null;
          p.resolve(reply);
          if (terminalFailure) { void session.stop(); return; }
        } catch { fail(Error('The macro stepper gave an unreadable answer')); void session.stop(); return; }
      }
    },
    failure(message) { fail(Error(message)); },
    finished() {
      closed = true; clearTimeout(idle);
      fail(Error('Macro session expired. Refresh to continue.'));
      finished();
    }
  });
  function exchange(send, timeout) {
    if (closed) return Promise.reject(Error('Macro session expired. Refresh to continue.'));
    clearTimeout(idle);
    return new Promise((resolve, reject) => {
      let timer;
      const complete = callback => value => {
        clearTimeout(timer);
        if (!closed && idleMs > 0) { idle = setTimeout(() => { void session.stop(); }, idleMs); idle.unref?.(); }
        callback(value);
      };
      pending = { resolve: complete(resolve), reject: complete(reject) };
      if (timeout) timer = setTimeout(() => {
        fail(Error('Macro session request timed out. Refresh to retry.')); void session.stop();
      }, timeout);
      send();
    });
  }
  const session = {
    done: process.done,
    start() {
      if (started) throw Error('Macro session already started');
      started = true;
      const result = exchange(() => process.start());
      tail = result.catch(() => {}); return result;
    },
    request(query) {
      const result = tail.then(() => exchange(() => {
        if (!process.send(query)) { fail(Error('Macro session is unavailable')); void session.stop(); }
      }, query.mode === 'reexpand' ? 0 : queryMs));
      tail = result.catch(() => {}); return result;
    },
    stop() {
      closed = true; clearTimeout(idle);
      fail(Error('Macro session closed'));
      return process.stop();
    }
  };
  return session;
}
module.exports = { createMacroSession };
