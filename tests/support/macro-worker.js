// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Provides worker requests, process observations and framed sessions.
'use strict';
const { root } = require('./macro-common');
const { createMacroProcess } = require('../../vscode/macro-process');
const { createMacroSession } = require('../../vscode/macro-steps/worker-session');
function request(text, mode = 'fragment') {
  return { text, mode, source: 'untitled:macro-test', sourceIsFile: false, prefix: '', directory: root, cwd: root };
}
function owned(command, program, input) {
  let output = '', errors = [], code;
  const process = createMacroProcess(command, program, input, {
    output: text => { output += text; }, failure: error => errors.push(error), finished: value => { code = value; }
  });
  return { process, get output() { return output; }, get errors() { return errors; }, get code() { return code; } };
}
function fakeSession(options = {}, createSession = createMacroSession) {
  let handlers, stopped = 0, started = 0; const sent = [];
  const session = createSession('unused', [], {}, { ...options,
    factory(_command, _helper, _request, callbacks) {
      handlers = callbacks;
      return { start() { started++; }, send(q) { sent.push(q); return true; },
        stop() { stopped++; handlers.finished(); return Promise.resolve(); } };
    } });
  return { session, sent, reply: text => handlers.output(text), get stopped() { return stopped; }, get started() { return started; } };
}
module.exports = { request, owned, fakeSession };
