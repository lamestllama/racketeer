'use strict';
const vscode = require('vscode');
const path = require('node:path');

function registerDebugRepl(sessions, interactions) {
  const modules = new Map();
  const transitions = new Map();
  const keyFor = target => JSON.stringify([target.program, target.racketExecutable, target.cwd]);
  async function ensure(target, restart) {
    const key = keyFor(target);
    let record = modules.get(key);
    if (restart && record) {
      await record.stop();
      await record.done;
      record = undefined;
    }
    if (!record || record.ended) {
      record = await sessions.start(target, {
        name: `Racket REPL: ${path.basename(target.program)}`,
        submodule: [], interactive: true, console: 'integratedTerminal', stopOnEntry: false,
        racketdapRichInteractions: !!interactions,
        ...(interactions ? { internalConsoleOptions: 'neverOpen' } : {})
      });
      modules.set(key, record);
      void record.done.then(() => {
        if (modules.get(key) === record) modules.delete(key);
      });
    }
    if (interactions) interactions.reveal(record, expression => evaluate(target, [expression]), () => open(target, true));
    else await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
    return record;
  }
  function open(target, restart = false) {
    const key = keyFor(target);
    const operation = (transitions.get(key) || Promise.resolve()).catch(() => {}).then(() => ensure(target, restart));
    transitions.set(key, operation);
    const cleanup = () => { if (transitions.get(key) === operation) transitions.delete(key); };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async function evaluate(target, expressions) {
    // The command's target is the frame selected when evaluation was requested.
    // Revealing the console can change the editor's active stack selection.
    const selected = vscode.debug.activeStackItem;
    const record = await open(target);
    let frameId;
    if (record.phase === 'paused') {
      if (selected?.session.id !== record.session.id || selected.frameId === undefined) {
        throw new Error('Select a stack frame in this module’s Debug REPL before evaluating.');
      }
      frameId = selected.frameId;
    } else if (!await record.ready) {
      throw new Error('The Debug REPL ended before the module was ready.');
    }
    // A pending module interaction can be paused at a breakpoint. Inspection
    // in that frame is a separate evaluation and must not unlock the outer one.
    const evaluation = frameId === undefined ? 'interaction' : `frame:${frameId}`;
    record.evaluating ||= new Set();
    if (record.evaluating.has(evaluation)) throw new Error('This Debug REPL is already evaluating. Continue, cancel, or stop that evaluation first.');
    record.evaluating.add(evaluation);
    try {
      let result;
      for (const expression of expressions) {
        result = await record.session.customRequest('evaluate', {
          expression, context: 'repl', frameId, racketdapEcho: true
        });
      }
      return result;
    } finally { record.evaluating.delete(evaluation); }
  }
  return { open, evaluate };
}

module.exports = { registerDebugRepl };
