// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Builds the local macro page and its resource policy.
'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const viewType = 'racketeer.macroSteps';
function panelHtml(webview, extensionUri) {
  const assets = vscode.Uri.joinPath(extensionUri, 'macro-view'), nonce = randomBytes(24).toString('base64');
  const escape = s => String(s).replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
  const uri = name => escape(webview.asWebviewUri(vscode.Uri.joinPath(assets, name)));
  // Monaco creates stylesheets and positions editor elements with inline styles.
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; worker-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';`;
  const monacoUri = name => escape(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out/monaco', name)));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><link rel="stylesheet" href="${monacoUri('editor.css')}"><link nonce="${nonce}" rel="stylesheet" href="${uri('view.css')}"><style nonce="${nonce}" id="geometry"></style></head><body><main id="app" aria-label="Macro steps"></main><div id="live" class="sr-only" aria-live="polite"></div><script nonce="${nonce}" src="${monacoUri('editor.js')}"></script>${['model.js','geometry.js','protocol.js','monaco.js','state.js','page.js','editor.js','decorations.js','overlay.js','details.js','sentence.js','input.js','layout.js','test-hooks.js','messages.js','view.js'].map(name => `<script nonce="${nonce}" src="${uri(name)}"></script>`).join('')}</body></html>`;
}

module.exports = { panelHtml, viewType };
