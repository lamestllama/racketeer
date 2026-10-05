'use strict';
const { renderWxme, escape } = require('./wxme-render');
const path = require('node:path');

function webviewMain() {
  const api = acquireVsCodeApi(), fields = new Map();
  const generation = document.body.dataset.generation;
  let selection;
  function size(field) {
    const lines = field.value.split('\n'); field.rows = Math.max(1, lines.length);
    field.cols = lines.reduce((n, line) => Math.max(n, [...line.replace(/\t/g, '        ')].length), 2) + 1;
  }
  function remember(field) { selection = { id: field.dataset.field, start: field.selectionStart, end: field.selectionEnd, before: field.value }; }
  for (const field of document.querySelectorAll('textarea')) {
    fields.set(field.dataset.field, field); field.previous = field.value; size(field);
    for (const event of ['focus', 'select', 'keyup', 'mouseup']) field.addEventListener(event, () => remember(field));
    field.addEventListener('input', () => {
      api.postMessage({ type: 'edit', generation, id: field.dataset.field, before: field.previous, text: field.value });
      field.previous = field.value; size(field); remember(field);
    });
    field.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (['z', 'y', 's'].includes(event.key.toLowerCase())) event.preventDefault();
      } else if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault(); field.setRangeText('\t', field.selectionStart, field.selectionEnd, 'end'); field.dispatchEvent(new Event('input'));
      }
    });
  }
  for (const button of document.querySelectorAll('button[data-insert]')) button.addEventListener('click', () => {
    if (selection) api.postMessage({ type: 'insert', generation, ...selection, kind: button.dataset.insert });
    else document.querySelector('[role="status"]').textContent = 'Place the cursor in the source text first.';
  });
  for (const button of document.querySelectorAll('button[data-remove]')) button.addEventListener('click', () => api.postMessage({ type: 'remove', generation, id: button.dataset.remove }));
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'text') return;
    const field = fields.get(data.id); if (!field) return;
    if (field.value !== data.text) field.value = data.text;
    field.previous = data.text; size(field);
  });
  const first = document.querySelector('textarea[data-focus]');
  if (first) { first.focus(); remember(first); }
}

function renderEditor(document) {
  const project = parts => parts.map(node => {
    if (node.kind === 'text') return { kind: 'text', id: node.id, text: document.text(node) };
    if (node.kind === 'image') return { ...document.image(node), id: node.id };
    return { kind: node.kind, id: node.id, parts: project(node.parts) };
  });
  return renderWxme({ parts: project(document.tree) }, path.basename(document.uri.fsPath), false, {
    generation: document.generation || '',
    text: part => `<textarea data-field="${escape(part.id)}" ${part.id === document.focus ? 'data-focus' : ''} aria-label="Source text ${escape(part.id)}" spellcheck="false" wrap="off">\n${escape(part.text)}</textarea>`,
    object: (part, body) => `<span class="object">${body}<button class="remove" data-remove="${escape(part.id)}" aria-label="Remove ${part.kind} and its contents" title="Remove ${part.kind} and its contents">×</button></span>`,
    status: 'Place the cursor to insert an object, or select text to put inside a box. Undo and save use the usual editor commands.',
    toolbar: '<div role="toolbar" aria-label="Insert WXME objects"><button data-insert="image">Insert PNG image…</button><button data-insert="comment">Comment box</button><button data-insert="editor">Nested editor</button></div>',
    styles: `textarea { display: inline-block; vertical-align: middle; box-sizing: content-box; resize: none; overflow: hidden; font: inherit; line-height: inherit; tab-size: inherit; color: inherit; background: transparent; border: 1px solid transparent; padding: 2px; }
textarea:focus { outline: 1px solid var(--vscode-focusBorder); } button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 8px; cursor: pointer; } button:focus { outline: 1px solid var(--vscode-focusBorder); } [role="toolbar"] { display: flex; gap: 8px; } .object { display: inline-block; position: relative; vertical-align: middle; padding-right: 18px; } .remove { position: absolute; right: 0; top: 0; padding: 0 4px; }`,
    script: `(${webviewMain.toString()})();`
  });
}
module.exports = { renderEditor, webviewMain };
