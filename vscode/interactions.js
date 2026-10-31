'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { InteractionOutput, pngBytes } = require('./interaction-output');
const { interactionsHtml } = require('./interactions-view');
const { registerErrorSources } = require('./error-sources');

function registerInteractions(context, images) {
  const errorSources = registerErrorSources(context);
  const views = new Map(), sessions = new Map();
  const keyFor = session => JSON.stringify([session.configuration.program, session.configuration.racketExecutable, session.configuration.cwd, !!session.configuration.interactive]);
  function status(view) {
    const inspecting = [...view.pending.values()].some(frame => frame !== undefined);
    const completed = view.interactive || view.stopped || view.exitCode === undefined ? 'Stopped' :
      view.exitCode === 0 ? 'Finished' : `Failed (exit ${view.exitCode})`;
    const text = view.ended ? completed : view.phase === 'Paused' && !inspecting ? 'Paused' : view.pending.size ? 'Evaluating…' : view.phase;
    void view.panel.webview.postMessage({ type: 'status', text, ended: view.ended, canRestart: !!view.restart && !view.restarting,
      restartLabel: !view.interactive && !view.session.configuration.noDebug ? 'Debug again' : 'Run again' });
  }
  function create(session) {
    const key = keyFor(session);
    const interactive = !!session.configuration.interactive;
    let view = views.get(key);
    if (!view || view.closed) {
      // VS Code activates the new editor group when it opens the panel beside
      // the source, even with preserveFocus, and only showing an editor with
      // focus activates the source group again. Reveal returns to this editor,
      // so commands on the active Racket file still find it.
      const origin = vscode.window.activeTextEditor;
      const panel = vscode.window.createWebviewPanel('racketeer.interactions', `${interactive ? 'Interactions' : 'Results'}: ${path.basename(session.configuration.program)}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
      view = { panel, key, interactive, origin };
      view.output = new InteractionOutput(message => { if (!view.closed) void panel.webview.postMessage(message); });
      panel.webview.html = interactionsHtml({ interactive });
      panel.onDidDispose(() => {
        view.closed = true; views.delete(key); sessions.delete(view.session.id); view.output.clear();
        void (view.owner ? view.owner.stop() : vscode.debug.stopDebugging(view.session)).catch(() => {});
      });
      panel.webview.onDidReceiveMessage(async message => {
        if (view.closed || !message || typeof message.action !== 'string') return;
        try {
          if (message.action === 'ready') {
            await panel.webview.postMessage({ type: 'snapshot', entries: view.output.snapshot() }); status(view);
          } else if (message.action === 'evaluate') {
            if (!view.interactive) return;
            if (!vscode.workspace.isTrusted || typeof message.expression !== 'string' || !message.expression.trim() || message.expression.length > 1024 * 1024) return;
            if (!view.evaluate || view.ended) throw new Error('Run the file before evaluating an expression.');
            await view.evaluate(message.expression);
          } else if (message.action === 'restart') {
            if (view.restarting || !view.restart) return;
            view.restarting = true; status(view);
            try {
              if (view.interactive) {
                const document = await vscode.workspace.openTextDocument(view.session.configuration.program);
                if (document.isDirty && !await document.save()) throw new Error('The file could not be saved.');
              }
              await view.restart();
            } finally { view.restarting = false; status(view); }
          } else if (message.action === 'clear') view.output.clear();
          else if (message.action === 'logs') await vscode.commands.executeCommand('racketdap.showApplicationLog', view.session.id);
          else if (message.action === 'continue' && !view.ended && view.phase === 'Paused')
            await view.session.customRequest('continue', { threadId: view.threadId });
          else if (message.action === 'stop' && !view.ended) { view.stopped = true; await view.owner?.stop(); }
          else if (message.action === 'cancel' && !view.ended) await view.session.customRequest('racketdap/interrupt');
          else if (message.action === 'input' && !view.ended) {
            if (message.eof === true) await view.session.customRequest('racketdap/input', { eof: true });
            else if (typeof message.text === 'string' && message.text.length <= 65536) await view.session.customRequest('racketdap/input', { text: message.text });
          } else if (message.action === 'openError') {
            const entry = view.output.entries.find(entry => entry.id === message.id && entry.kind === 'error');
            const location = Number.isInteger(message.index) && entry?.locations[message.index];
            if (!location) throw new Error('This error location is no longer in the output.');
            await errorSources.open(entry.sources[location.source], location);
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
    Object.assign(view, { session, owner: undefined, evaluate: undefined, restart: undefined, ended: false,
      exitCode: undefined, stopped: false, phase: 'Loading…', pending: new Map(), lastError: undefined, threadId: undefined });
    sessions.set(session.id, view); status(view);
    return view;
  }
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      if (session.configuration.request === 'attach' || !session.configuration.racketdapRichInteractions) return;
      const view = create(session);
      const current = () => !view.closed && view.session.id === session.id;
      return {
        onWillReceiveMessage(message) {
          if (!current() || message.type !== 'request') return;
          if (message.command === 'configurationDone' && !view.interactive) { view.phase = 'Running…'; status(view); }
          if (['disconnect', 'terminate'].includes(message.command) && view.exitCode === undefined) view.stopped = true;
          if (message.command !== 'evaluate' || message.arguments?.context !== 'repl') return;
          view.pending.set(message.seq, message.arguments.frameId); view.lastError = undefined;
          view.output.append('input', message.arguments.expression); status(view);
        },
        onDidSendMessage(message) {
          if (!current()) return;
          if (message.type === 'response' && view.pending.delete(message.request_seq)) {
            if (!message.success) { view.lastError = message.message || 'Evaluation failed.'; view.output.error(view.lastError, message.body?.racketdapError); }
            status(view);
          }
          if (message.type !== 'event') return;
          if (message.event === 'racketdap/interactionOutput') {
            try { view.output.output(message.body); } catch (error) { view.output.append('stderr', error.message + '\n'); }
          }
          if (message.event === 'racketdap/interactionError') view.output.error(message.body.message, message.body, true);
          if (message.event === 'racketdap/ready') view.phase = 'Ready';
          if (message.event === 'stopped') { view.phase = 'Paused'; view.threadId = message.body.threadId; }
          if (message.event === 'continued') view.phase = 'Running…';
          if (message.event === 'exited') view.exitCode = message.body.exitCode;
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
    async reveal(owner, evaluate, restart) {
      const view = sessions.get(owner.session.id);
      if (!view || view.closed) { void owner.stop(); return; }
      Object.assign(view, { owner, evaluate, restart });
      status(view);
      const editor = view.origin || vscode.window.activeTextEditor;
      view.origin = undefined;
      if (!view.panel.visible) view.panel.reveal(undefined, true);
      if (editor && !editor.document.isClosed && vscode.window.activeTextEditor?.document !== editor.document)
        await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    }
  };
}
module.exports = { registerInteractions };
