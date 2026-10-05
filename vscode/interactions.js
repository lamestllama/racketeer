'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { InteractionOutput, pngBytes } = require('./interaction-output');
const { interactionsHtml } = require('./interactions-view');

function registerInteractions(context, images) {
  const views = new Map(), sessions = new Map();
  const keyFor = session => JSON.stringify([session.configuration.program, session.configuration.racketExecutable, session.configuration.cwd]);
  function status(view) {
    const inspecting = [...view.pending.values()].some(frame => frame !== undefined);
    const text = view.ended ? 'Stopped' : view.phase === 'Paused' && !inspecting ? 'Paused' : view.pending.size ? 'Evaluating…' : view.phase;
    void view.panel.webview.postMessage({ type: 'status', text });
  }
  function create(session) {
    const key = keyFor(session);
    let view = views.get(key);
    if (!view || view.closed) {
      const panel = vscode.window.createWebviewPanel('racketeer.interactions', `Interactions: ${path.basename(session.configuration.program)}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
      view = { panel, key };
      view.output = new InteractionOutput(message => { if (!view.closed) void panel.webview.postMessage(message); });
      panel.webview.html = interactionsHtml();
      panel.onDidDispose(() => {
        view.closed = true; views.delete(key); sessions.delete(view.session.id); view.output.clear();
        void (view.owner ? view.owner.stop() : vscode.debug.stopDebugging(view.session)).catch(() => {});
      });
      panel.webview.onDidReceiveMessage(async message => {
        if (view.closed || !message || typeof message.action !== 'string') return;
        try {
          if (message.action === 'ready') {
            await panel.webview.postMessage({ type: 'snapshot', entries: view.output.entries }); status(view);
          } else if (message.action === 'evaluate') {
            if (!vscode.workspace.isTrusted || typeof message.expression !== 'string' || !message.expression.trim() || message.expression.length > 1024 * 1024) return;
            if (!view.evaluate || view.ended) throw new Error('Run the file before evaluating an expression.');
            await view.evaluate(message.expression);
          } else if (message.action === 'restart') {
            if (view.restarting || !view.restart) return;
            view.restarting = true;
            try {
              const document = await vscode.workspace.openTextDocument(view.session.configuration.program);
              if (document.isDirty && !await document.save()) throw new Error('The file could not be saved.');
              await view.restart();
            } finally { view.restarting = false; }
          } else if (message.action === 'clear') view.output.clear();
          else if (message.action === 'logs') await vscode.commands.executeCommand('racketdap.showApplicationLog', view.session.id);
          else if (message.action === 'continue' && !view.ended && view.phase === 'Paused')
            await view.session.customRequest('continue', { threadId: view.threadId });
          else if (message.action === 'stop') await view.owner?.stop();
          else if (message.action === 'cancel' && !view.ended) await view.session.customRequest('racketdap/interrupt');
          else if (message.action === 'input' && !view.ended) {
            if (message.eof === true) await view.session.customRequest('racketdap/input', { eof: true });
            else if (typeof message.text === 'string' && message.text.length <= 65536) await view.session.customRequest('racketdap/input', { text: message.text });
          } else if (['openImage', 'saveImage'].includes(message.action)) {
            const entry = view.output.entries.find(entry => entry.id === message.id && entry.kind === 'image');
            if (!entry) throw new Error('This image is no longer in the output.');
            const snapshot = { mimeType: 'image/png', data: entry.data };
            if (message.action === 'openImage') await images.openSnapshot(snapshot);
            else {
              const destination = await vscode.window.showSaveDialog({ title: 'Save Racket Image', filters: { 'PNG image': ['png'] } });
              if (destination) await vscode.workspace.fs.writeFile(destination, pngBytes(snapshot));
            }
          }
        } catch (error) {
          // Evaluation failures are already reported by the owning protocol request.
          if (message.action !== 'evaluate' || !view.lastError || view.lastError !== error.message)
            view.output.append('stderr', error.message + '\n');
        }
      });
      views.set(key, view);
    } else {
      sessions.delete(view.session.id); view.output.clear();
    }
    Object.assign(view, { session, owner: undefined, ended: false, phase: 'Loading…', pending: new Map(), lastError: undefined, threadId: undefined });
    sessions.set(session.id, view); status(view);
    return view;
  }
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      if (!session.configuration.racketdapRichInteractions) return;
      const view = create(session);
      const current = () => !view.closed && view.session.id === session.id;
      return {
        onWillReceiveMessage(message) {
          if (!current() || message.type !== 'request' || message.command !== 'evaluate' || message.arguments?.context !== 'repl') return;
          view.pending.set(message.seq, message.arguments.frameId); view.lastError = undefined;
          view.output.append('input', message.arguments.expression); status(view);
        },
        onDidSendMessage(message) {
          if (!current()) return;
          if (message.type === 'response' && view.pending.delete(message.request_seq)) {
            if (!message.success) { view.lastError = message.message || 'Evaluation failed.'; view.output.append('stderr', view.lastError + '\n'); }
            status(view);
          }
          if (message.type !== 'event') return;
          if (message.event === 'racketdap/interactionOutput') {
            try { view.output.output(message.body); } catch (error) { view.output.append('stderr', error.message + '\n'); }
          }
          if (message.event === 'racketdap/ready') view.phase = 'Ready';
          if (message.event === 'stopped') { view.phase = 'Paused'; view.threadId = message.body.threadId; }
          if (message.event === 'continued') view.phase = 'Running…';
          if (message.event === 'terminated') { view.ended = true; view.output.finish(); }
          status(view);
        }
      };
    }
  }), vscode.debug.onDidTerminateDebugSession(session => {
    const view = sessions.get(session.id);
    if (view && !view.closed) { view.ended = true; view.output.finish(); status(view); }
  }), new vscode.Disposable(() => { for (const view of [...views.values()]) view.panel.dispose(); }));
  return {
    reveal(owner, evaluate, restart) {
      const view = sessions.get(owner.session.id);
      if (!view || view.closed) { void owner.stop(); return; }
      Object.assign(view, { owner, evaluate, restart });
      view.panel.reveal(undefined, true); status(view);
    }
  };
}
module.exports = { registerInteractions };
