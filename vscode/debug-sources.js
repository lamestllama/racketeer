'use strict';
const vscode = require('vscode');

function registerDebugSources(context) {
  const paths = new Map();
  const changed = new vscode.EventEmitter();
  let providers = [];
  const normalize = text => text.replace(/\r\n/g, '\n');
  function pathFor(uri, sessionId) {
    const source = paths.get(uri.toString());
    if (sessionId === undefined || source?.session === sessionId) return source?.path;
  }

  // The language server analyzes file documents. A captured debugger source
  // may use those results only while both documents contain the same code.
  async function matchingFile(document, token) {
    const path = pathFor(document.uri);
    if (!path || token.isCancellationRequested) return;
    try {
      const file = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      if (!token.isCancellationRequested && normalize(file.getText()) === normalize(document.getText())) return file;
    } catch (_) { /* Deleted/unavailable files retain basic syntax highlighting. */ }
  }
  async function query(client, document, token, method, args = {}) {
    const file = await matchingFile(document, token);
    if (!file) return;
    const version = file.version;
    const result = await client.sendRequest(method, { textDocument: { uri: file.uri.toString() }, ...args }, token);
    if (!token.isCancellationRequested && version === file.version && pathFor(document.uri) &&
        normalize(file.getText()) === normalize(document.getText())) return result;
  }
  function setLanguageClient(client, provideReferences) {
    for (const provider of providers) provider.dispose();
    providers = [];
    if (!client) return;
    const selector = { language: 'racket', scheme: 'debug' };
    const legend = client.initializeResult?.capabilities.semanticTokensProvider?.legend;
    if (legend) providers.push(vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChangeSemanticTokens: changed.event,
      async provideDocumentSemanticTokens(document, token) {
        const result = await query(client, document, token, 'textDocument/semanticTokens/full');
        return new vscode.SemanticTokens(Uint32Array.from(result?.data || []));
      }
    }, new vscode.SemanticTokensLegend(legend.tokenTypes, legend.tokenModifiers)));
    providers.push(vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position, token) {
        const result = await query(client, document, token, 'textDocument/hover', {
          position: { line: position.line, character: position.character }
        });
        return result ? client.protocol2CodeConverter.asHover(result) : undefined;
      }
    }));
    providers.push(vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        const result = await query(client, document, token, 'textDocument/definition', {
          position: client.code2ProtocolConverter.asPosition(position)
        });
        return client.protocol2CodeConverter.asDefinitionResult(result, token);
      }
    }));
    providers.push(vscode.languages.registerReferenceProvider(selector, {
      async provideReferences(document, position, options, token) {
        const path = pathFor(document.uri);
        if (!path || token.isCancellationRequested) return;
        const version = document.version;
        const next = async () => {
          const result = await query(client, document, token, 'textDocument/references', {
            position: client.code2ProtocolConverter.asPosition(position), context: options
          });
          return client.protocol2CodeConverter.asReferences(result, token);
        };
        const result = provideReferences
          ? await provideReferences(document, position, options, token, next, vscode.Uri.file(path)) : await next();
        if (await matchingFile(document, token) && version === document.version && pathFor(document.uri) === path) return result;
      }
    }));
    changed.fire();
  }
  context.subscriptions.push(changed,
    { dispose: () => setLanguageClient(undefined) },
    vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
      createDebugAdapterTracker(session) {
        return { onDidSendMessage(message) {
          if (message.type !== 'event') return;
          const source = message.body?.source;
          if (message.event === 'loadedSource' && source?.path) {
            const uri = vscode.debug.asDebugSourceUri(source, session).toString();
            if (message.body.reason === 'removed') paths.delete(uri);
            else paths.set(uri, { path: source.path, session: session.id });
            changed.fire();
          }
        } };
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      for (const [uri, source] of paths) if (source.session === session.id) paths.delete(uri);
      changed.fire();
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'racket' && event.document.uri.scheme === 'file') changed.fire();
    }),
    vscode.languages.onDidChangeDiagnostics(event => {
      if (event.uris.some(uri => [...paths.values()].some(source => source.path === uri.fsPath))) changed.fire();
    })
  );
  return { pathFor, setLanguageClient };
}

module.exports = { registerDebugSources };
