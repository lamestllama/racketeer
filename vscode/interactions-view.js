'use strict';
const { randomBytes } = require('node:crypto');
function webviewMain() {
  const vscode = acquireVsCodeApi();
  const output = document.getElementById('output'), prompt = document.getElementById('expression');
  const status = document.getElementById('status'), entries = new Map();
  const history = []; let position = 0, draft = '', busy = true, followTail = true;
  output.addEventListener('scroll', () => { followTail = output.scrollHeight - output.scrollTop - output.clientHeight < 60; });
  const send = (action, extra = {}) => vscode.postMessage({ action, ...extra });
  function submit() {
    const expression = prompt.value;
    if (busy || !expression.trim()) return;
    busy = true; document.getElementById('evaluate').disabled = true;
    history.push(expression); if (history.length > 200) history.shift();
    position = history.length; draft = ''; prompt.value = ''; followTail = true; send('evaluate', { expression });
  }
  function entry(value) {
    let node = entries.get(value.id);
    if (!node) {
      node = document.createElement(value.kind === 'image' ? 'figure' : 'pre');
      node.className = value.kind; node.dataset.id = value.id;
      entries.set(value.id, node); output.append(node);
      if (value.kind === 'image') {
        const button = document.createElement('button'); button.className = 'picture';
        button.title = 'Open full-size image'; button.setAttribute('aria-label', 'Open full-size image');
        const img = document.createElement('img'); img.alt = 'Racket image result';
        img.onload = () => { if (followTail) output.scrollTop = output.scrollHeight; };
        img.src = 'data:image/png;base64,' + value.data; button.append(img);
        button.onclick = () => send('openImage', { id: value.id });
        const save = document.createElement('button'); save.textContent = 'Save image…';
        save.onclick = () => send('saveImage', { id: value.id });
        node.append(button, save);
      }
    }
    if (value.kind !== 'image') node.textContent = (value.kind === 'input' ? '> ' : '') + value.text;
  }
  window.addEventListener('message', ({ data }) => {
    const atBottom = followTail;
    if (data.type === 'entry') entry(data.entry);
    if (data.type === 'remove') {
      for (const id of data.ids) { entries.get(id)?.remove(); entries.delete(id); }
      document.getElementById('trimmed').hidden = false;
    }
    if (data.type === 'clear' || data.type === 'snapshot') {
      output.replaceChildren(); entries.clear(); document.getElementById('trimmed').hidden = true;
      for (const value of data.entries || []) entry(value);
    }
    if (data.type === 'status') {
      busy = !['Ready', 'Paused'].includes(data.text); status.textContent = data.text;
      document.getElementById('evaluate').disabled = busy;
      document.getElementById('cancel').disabled = ['Ready', 'Stopped'].includes(data.text);
      document.getElementById('stop').disabled = data.text === 'Stopped';
      document.getElementById('continue').hidden = data.text !== 'Paused';
    }
    if (atBottom) requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; followTail = true; });
  });
  document.getElementById('evaluate').onclick = submit;
  for (const action of ['restart', 'cancel', 'stop', 'clear', 'continue']) document.getElementById(action).onclick = () => send(action);
  document.getElementById('sendInput').onclick = () => {
    const input = document.getElementById('stdin'); send('input', { text: input.value + '\n' }); input.value = '';
  };
  document.getElementById('eof').onclick = () => send('input', { eof: true });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    if (event.key === 'ArrowUp' && prompt.selectionStart === 0 && history.length) {
      event.preventDefault(); if (position === history.length) draft = prompt.value;
      prompt.value = history[position = Math.max(0, position - 1)]; prompt.setSelectionRange(0, 0);
    }
    if (event.key === 'ArrowDown' && prompt.selectionEnd === prompt.value.length) {
      event.preventDefault(); position = Math.min(history.length, position + 1);
      prompt.value = position === history.length ? draft : history[position];
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    }
  });
  send('ready'); prompt.focus();
}
function interactionsHtml() {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
body{color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:12px;box-sizing:border-box;height:100vh;display:flex;flex-direction:column;margin:0}
header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-bottom:10px}#status{margin-right:auto;color:var(--vscode-descriptionForeground)}header button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:1px solid transparent;padding:4px 9px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.5;cursor:default}button:focus-visible,textarea:focus,input:focus{outline:1px solid var(--vscode-focusBorder)}
#output{flex:1;overflow:auto;min-height:80px}pre{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;line-height:1.45}.input{border-top:1px solid var(--vscode-panel-border);padding:12px 0 6px;margin-top:8px;color:var(--vscode-debugConsole-sourceForeground)}.stderr{color:var(--vscode-errorForeground)}
figure{margin:8px 0;display:flex;flex-direction:column;align-items:flex-start;gap:6px}.picture{padding:0;background:transparent;border:1px solid var(--vscode-panel-border);max-width:100%}.picture img{display:block;max-width:100%;height:auto}
textarea,input{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:6px}textarea{width:100%;resize:vertical;min-height:65px}footer{padding-top:10px;border-top:1px solid var(--vscode-panel-border)}.hint{color:var(--vscode-descriptionForeground);font-size:12px;margin:5px 0}details{margin-top:8px}summary{cursor:pointer}#trimmed{color:var(--vscode-descriptionForeground)}
</style></head><body>
<header><strong>Interactions</strong><span id="status" role="status">Loading…</span><button id="restart">Run again</button><button id="continue" hidden>Continue</button><button id="cancel">Interrupt</button><button id="stop">Stop</button><button id="clear">Clear output</button></header>
<p id="trimmed" hidden>Earlier output was removed to keep the view within its memory limit.</p>
<div id="output" role="log" aria-label="Racket interaction output" aria-live="polite"></div>
<footer><label for="expression">Expression</label><textarea id="expression" rows="2" spellcheck="false" aria-label="Racket expression"></textarea>
<div class="hint">Enter evaluates · Shift+Enter adds a line · Up/Down recalls previous expressions</div><button id="evaluate" disabled>Evaluate</button>
<details><summary>Program input</summary><input id="stdin" aria-label="Program input"><button id="sendInput">Send line</button><button id="eof">End input</button></details></footer>
<script nonce="${nonce}">(${webviewMain})();</script></body></html>`;
}
module.exports = { interactionsHtml };
