'use strict';
const { saveTarget } = require('./execution');

function registerFileRuns(sessions, output) {
  const records = new Map(), transitions = new Map();
  function run(target, debug = false) {
    const key = JSON.stringify([target.program, target.racketExecutable, target.cwd]);
    const operation = (transitions.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      await saveTarget(target);
      const previous = records.get(key);
      if (previous) { await previous.stop(); await previous.done; }
      const record = await sessions.start(target, {
        stopOnEntry: debug, interactive: false, console: 'integratedTerminal',
        racketdapRichInteractions: true, internalConsoleOptions: 'neverOpen'
      }, { noDebug: !debug });
      records.set(key, record);
      void record.done.then(() => { if (records.get(key) === record) records.delete(key); });
      output.reveal(record, undefined, () => run(target, debug));
      return record;
    });
    transitions.set(key, operation);
    const cleanup = () => { if (transitions.get(key) === operation) transitions.delete(key); };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  return { run };
}
module.exports = { registerFileRuns };
