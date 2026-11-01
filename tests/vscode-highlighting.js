// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const vscode = require('vscode');

async function semanticTokens(document) {
  const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', document.uri);
  const result = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
  const tokens = [];
  if (!legend || !result) return tokens;
  let line = 0, character = 0;
  for (let i = 0; i < result.data.length; i += 5) {
    const [deltaLine, deltaStart, length, type] = result.data.slice(i, i + 5);
    line += deltaLine;
    character = deltaLine ? deltaStart : character + deltaStart;
    tokens.push({ line, character, type: legend.tokenTypes[type],
      text: document.getText(new vscode.Range(line, character, line, character + length)) });
  }
  return tokens;
}

module.exports = { semanticTokens };
