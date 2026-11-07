// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Builds the page shell, persists presentation and displays status.
/* global MacroView */
MacroView.createPage = function (runtime) {
  'use strict';
  const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const id = (e, name) => { e.id = name; return e; };
  function rule(name, css) { runtime.geometryRules.set(name, css); while (runtime.dynamic.cssRules.length) runtime.dynamic.deleteRule(0); for (const value of runtime.geometryRules.values()) runtime.dynamic.insertRule(value, runtime.dynamic.cssRules.length); }
  function send(type, fields = {}) {
    if (!runtime.env) return;
    runtime.vscode.postMessage({ ...runtime.env, v: 1, type, requestId: `page${++runtime.serial}`,
      ...(type === 'navigate' ? { clientInstanceId: runtime.clientInstanceId, navigationSequence: ++runtime.navigationSequence } : {}), ...fields });
  }
  function announce(text) { runtime.live.textContent = text; }
  const banner = id(element('div', '', 'banner'), 'banner');
  banner.hidden = true;
  const bannerText = element('span'), refresh = id(element('a', 'Refresh'), 'refresh');
  refresh.href = '#';
  refresh.addEventListener('click', e => { e.preventDefault(); if (runtime.state.refreshAvailable) send('refresh'); });
  banner.append(bannerText, refresh);
  const note = id(element('p'), 'note');
  note.setAttribute('role', 'status');
  runtime.app.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'program', preventDefaultContextMenuItems: true }));
  const work = id(element('div'), 'work'), syntax = id(element('div'), 'syntax');
  syntax.setAttribute('role', 'region');
  syntax.setAttribute('aria-label', 'Expansion syntax.');
  const divider = id(element('div'), 'divider');
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Properties panel width');
  const inspector = id(element('aside'), 'properties');
  inspector.setAttribute('aria-label', 'Current term properties');
  const connections = id(element('p', ''), 'connections');
  connections.setAttribute('aria-label', 'Binding connections');
  work.append(syntax, divider, inspector);
  runtime.app.append(banner, note, work, connections);
  function persist() {
    runtime.vscode.setState({ pairId: runtime.state.pairId, side: runtime.projection?.pane || runtime.saved.side, source: runtime.state.source, wholeFile: runtime.state.wholeFile, range: runtime.state.range,
      positionKey: runtime.env ? `${runtime.env.generation}:${runtime.projection?.position || runtime.state.position || 1}` : '',
      scroll: runtime.editor ? [runtime.editor.getScrollTop(), runtime.editor.getScrollLeft()] : [0, 0],
      splitFraction: runtime.state.splitFraction, expanded: runtime.expanded ? [...runtime.expanded] : undefined, focused: document.activeElement?.id });
  }
  function updateState() {
    refresh.setAttribute('aria-disabled', String(!runtime.state.refreshAvailable));
    work.hidden = connections.hidden = !!runtime.state.busy;
    if (!runtime.projection && runtime.state.error) syntax.replaceChildren(element('p', runtime.state.error, 'error'), element('p', 'No expansion context was obtained.'));
    updateStatus();
    work.classList.toggle('no-properties', !runtime.state.propertiesVisible); inspector.hidden = divider.hidden = !runtime.state.propertiesVisible;
    runtime.split(runtime.state.splitFraction || 1 / 3); runtime.schedule();
  }
  function updateStatus() {
    if (runtime.state.busy) { note.textContent = ''; return; }
    const p = runtime.projection, diagnostic = p?.pane === 'after' && p.diagnostics?.[p.error];
    if (diagnostic?.kind === 'internal') {
      const [before, after] = diagnostic.message.split('[details]');
      note.replaceChildren(element('span', before));
      if (diagnostic.details) {
        const link = element('a', '[details]'); link.href = '#';
        link.addEventListener('click', event => { event.preventDefault(); send('internalDetails'); });
        note.append(link, element('span', after));
      }
      return;
    }
    note.textContent = [runtime.projection?.pane === 'after' && runtime.projection?.error ? runtime.projection.diagnostics[runtime.projection.error]?.message : '', runtime.state.error].filter(Boolean).join('\n');
  }
  function setStale(m) {
    banner.hidden = !m.stale; bannerText.textContent = `${m.reason || ''} `;
    runtime.state.refreshAvailable = m.refreshAvailable; refresh.setAttribute('aria-disabled', String(!m.refreshAvailable));
    if (m.stale) announce(m.reason);
  }
  function equal(a, b) { return a === b || !!a && !!b && a.sectionId === b.sectionId && a.occurrenceId === b.occurrenceId; }
  function incident(pair) { return runtime.projection ? runtime.M.incident(runtime.projection, pair) : []; }
  return {
    work,
    rule,
    divider,
    persist,
    send,
    element,
    equal,
    syntax,
    note,
    incident,
    inspector,
    id,
    connections,
    announce,
    banner,
    updateState,
    setStale,
    updateStatus
  };
};
