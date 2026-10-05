'use strict';
const { randomBytes } = require('node:crypto');
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function renderWxme(result, name, stale = false, options = {}) {
  const nonce = options.nonce || randomBytes(16).toString('hex');
  const decorate = options.object || ((_part, html) => html);
  const renderParts = (parts, depth = 0) => parts.map(part => {
    if (part.kind === 'text') return options.text ? options.text(part) : escape(part.text);
    if (part.kind === 'unsupported') return `<span class="unsupported">[${escape(part.label)}]</span>`;
    if (part.kind === 'editor' || part.kind === 'comment') {
      if (depth >= 32) throw new Error('Nested editors exceed the viewer limit (32 levels).');
      const label = part.kind === 'comment' ? 'Comment box' : 'Nested editor';
      return decorate(part, `<span class="embedded" role="group" aria-label="${label}"><span class="box-label" aria-hidden="true">${label}</span><span>${renderParts(part.parts, depth + 1)}</span></span>`);
    }
    if (part.kind !== 'image' || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data) ||
        !Buffer.from(part.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        ![part.width, part.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) {
      throw new Error('Invalid embedded image.');
    }
    return decorate(part, `<img src="data:image/png;base64,${part.data}" width="${part.width}" height="${part.height}" alt="Embedded image (${part.width} × ${part.height})">`);
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; ${options.script ? `script-src 'nonce-${nonce}';` : ''}">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escape(name)}</title>
<style nonce="${nonce}">
body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 16px; }
p { font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); }
pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre; tab-size: 8; line-height: 1.5; }
img { vertical-align: middle; } .unsupported { color: var(--vscode-editorWarning-foreground); border: 1px solid; padding: 2px; }
.embedded { display: inline-block; vertical-align: middle; border: 1px solid var(--vscode-editorWidget-border, currentColor); padding: 4px 8px; margin: 2px; }
.box-label { display: block; font-family: var(--vscode-font-family); font-size: 0.85em; color: var(--vscode-descriptionForeground); }
${options.styles || ''}
</style></head><body${options.generation === undefined ? '' : ` data-generation="${escape(options.generation)}"`}>${options.toolbar || ''}<p role="status">${escape(options.status || (stale ? 'The file has changed. Close and reopen this view to refresh.' : 'Read-only view of the saved file.'))}</p><pre aria-label="WXME source"><span id="source">${renderParts(result.parts)}</span></pre>${options.script ? `<script nonce="${nonce}">${options.script}</script>` : ''}</body></html>`;
}

module.exports = { renderWxme, escape };
