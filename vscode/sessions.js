'use strict';
const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { launchConfiguration } = require('./execution');

// Own only launches created by a workflow. Never infer ownership from the
// active debug session: the user can switch sessions while a launch is pending.
function registerSessions(context) {
  const pending = new Map();
  let disposed = false;
  let listeners = [];
  function releaseListeners() {
    if (!disposed || pending.size) return;
    for (const listener of listeners) listener.dispose();
    listeners = [];
  }
  function finish(record) {
    if (record.ended) return;
    record.ended = true;
    record.phase = 'ended';
    record.cancel?.dispose();
    pending.delete(record.id);
    record.resolveReady(undefined);
    record.resolveDone({ exitCode: record.exitCode });
    releaseListeners();
  }
  listeners = [
    vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
      createDebugAdapterTracker(session) {
        const record = pending.get(session.configuration.racketdapWorkflowId);
        if (!record) return;
        record.session = session;
        return { onDidSendMessage(message) {
          if (record.ended || message.type !== 'event') return;
          if (message.event === 'stopped') record.phase = 'paused';
          if (message.event === 'continued') record.phase = 'running';
          if (message.event === 'racketdap/ready') {
            record.phase = 'ready';
            record.resolveReady(session);
          }
          if (message.event === 'exited') record.exitCode = message.body.exitCode;
          if (!disposed) record.onEvent(message);
          if (message.event === 'terminated') finish(record);
        } };
      }
    }),
    vscode.debug.onDidStartDebugSession(session => {
      const record = pending.get(session.configuration.racketdapWorkflowId);
      if (record) record.session = session;
      if (record?.cancelled) void record.stop().catch(() => {});
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      const record = pending.get(session.configuration.racketdapWorkflowId);
      if (record) finish(record);
    })
  ];
  context.subscriptions.push({ dispose() {
      disposed = true;
      for (const record of pending.values()) {
        // Keep ownership until a pending launch produces a session (or fails).
        // Removing its listeners now would leave that late session running.
        void record.stop().catch(() => {});
      }
      releaseListeners();
    } });

  async function start(target, configuration, { noDebug = false, token, onEvent = () => {} } = {}) {
    if (disposed) throw new Error('The Racket extension has been stopped.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before executing Racket code.');
    if (token?.isCancellationRequested) return undefined;
    const record = { id: randomUUID(), phase: 'starting', onEvent, ended: false };
    record.ready = new Promise(resolve => { record.resolveReady = resolve; });
    record.done = new Promise(resolve => { record.resolveDone = resolve; });
    record.stop = async () => {
      record.cancelled = true;
      if (record.session && !record.ended) await vscode.debug.stopDebugging(record.session);
    };
    record.cancel = token?.onCancellationRequested(() => { void record.stop(); });
    pending.set(record.id, record);
    try {
      const started = await vscode.debug.startDebugging(target.folder,
        launchConfiguration(target, { ...configuration, racketdapWorkflowId: record.id }),
        { noDebug, suppressDebugToolbar: noDebug || !!configuration.racketdapRichInteractions,
          suppressDebugStatusbar: noDebug, suppressDebugView: noDebug || !!configuration.racketdapRichInteractions });
      if (!started) throw new Error('Racket launch was cancelled or failed. See the debug output for details.');
      if (record.cancelled) await record.stop();
      return record;
    } catch (error) {
      finish(record);
      throw error;
    }
  }
  return { start };
}

module.exports = { registerSessions };
