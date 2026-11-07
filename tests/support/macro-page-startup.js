// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Starts complete shipped scripts with a small DOM and observes the composed runtime.
'use strict';
function startPage(scripts, globals = {}) {
  const vm = require('node:vm');
  const messages = [], listeners = new Map(), documentListeners = new Map(), observers = [];
  const node = (tag = 'div') => ({
    tag, tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, listeners: {}, handlers: {}, hidden: false, value: '',
    get textContent() { return this.value + this.children.map(c => c.textContent).join(''); },
    set textContent(value) { this.value = value ?? ''; this.children = []; },
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this; },
    replaceChildren(...children) { this.value = ''; this.children = []; this.append(...children); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, fn) { this.listeners[name] = this.handlers[name] = fn; },
    setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
    contains(candidate) { return this === candidate || this.children.some(c => c.contains?.(candidate)); },
    querySelectorAll(selector) {
      const descendants = n => n.children.flatMap(c => [c, ...descendants(c)]);
      return descendants(this).filter(n => selector === 'text' ? n.tagName === 'text' :
        selector === '.property' ? n.className === 'property' :
        selector === 'details' ? n.tag === 'details' : selector === 'details[open]' ? n.tag === 'details' && n.open : false);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    getBBox() { return { x: 0, y: -8, width: this.textContent.length * 7, height: 10 }; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }),
    sheet: { cssRules: [], insertRule(rule) { this.cssRules.push(rule); }, deleteRule(index) { this.cssRules.splice(index, 1); } }
  });
  const elements = new Map(['app', 'live', 'geometry'].map(name => [name, node()]));
  const context = vm.createContext({
    document: {
      getElementById: name => elements.get(name), createElement: node, createElementNS: (_ns, tag) => Object.assign(node(tag), { tagName: tag }),
      body: node(), documentElement: node(), hasFocus: () => true, visibilityState: 'visible',
      addEventListener: (name, fn, capture) => documentListeners.set(name, { type: name, fn, capture }), elementFromPoint: () => null
    },
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: message => messages.push(message) }),
    MacroMonaco: { languages: { register() {}, setLanguageConfiguration() {} } },
    ResizeObserver: class { constructor(callback) { observers.push(callback); } observe() {} }, MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    KeyboardEvent: undefined, MouseEvent: undefined, PointerEvent: undefined, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask, innerWidth: 900, innerHeight: 600,
    ...globals
  });
  let runtime;
  for (const [filename, source] of scripts) {
    if (filename.endsWith('/view.js')) {
      const createState = context.MacroView.createState;
      context.MacroView.createState = value => { runtime = value; return createState(value); };
    }
    new vm.Script(source, { filename }).runInContext(context);
  }
  return { messages, listeners, documentListeners, observers, elements, context, runtime };
}
function pageScripts(sources = {}) {
  const { load, root } = require('./macro-common');
  const fs = require('node:fs'), path = require('node:path');
  const html = load({ vscode: { Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') } } }, undefined, sources)
    .panelHtml({ cspSource: 'local:', asWebviewUri: uri => uri }, 'extension');
  return [...html.matchAll(/src="extension\/(macro-view\/[^" ]+)"/g)].map(([, name]) => {
    const file = 'vscode/' + name;
    return [file, sources[file] ?? fs.readFileSync(path.join(root, file), 'utf8')];
  });
}
module.exports = { startPage, pageScripts };
