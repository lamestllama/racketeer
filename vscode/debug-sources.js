// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');

function registerDebugSources(context) {
  const paths = new Map();
  function pathFor(uri, sessionId) {
    const source = paths.get(uri.toString());
    if (sessionId === undefined || source?.session === sessionId) return source?.path;
  }
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
      createDebugAdapterTracker(session) {
        return { onDidSendMessage(message) {
          // A source gains a reference when a saved edit leaves its running text behind.
          const answered = message.type !== 'response' ? []
            : message.command === 'stackTrace' ? (message.body?.stackFrames || []).map(frame => frame.source)
              : message.command === 'loadedSources' ? message.body?.sources || [] : [];
          for (const named of answered) {
            if (!(named?.sourceReference > 0 && named.path)) continue;
            const uri = vscode.debug.asDebugSourceUri(named, session).toString();
            if (!paths.has(uri)) paths.set(uri, { path: named.path, session: session.id });
          }
          if (message.type !== 'event') return;
          const source = message.body?.source;
          if (message.event === 'loadedSource' && source?.path) {
            const uri = vscode.debug.asDebugSourceUri(source, session).toString();
            if (message.body.reason === 'removed') paths.delete(uri);
            else paths.set(uri, { path: source.path, session: session.id });
          }
        } };
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      for (const [uri, source] of paths) if (source.session === session.id) paths.delete(uri);
      // A breakpoint in a captured source can reach only that session's running text.
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints.filter(breakpoint =>
        breakpoint.location?.uri.scheme === 'debug' &&
        breakpoint.location.uri.query.split('&').includes(`session=${session.id}`)));
    })
  );
  return { pathFor };
}

module.exports = { registerDebugSources };
