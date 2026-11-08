// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Renders term properties and manages the properties divider.
/* global MacroView */
MacroView.createDetails = function (runtime) {
  'use strict';
  function layoutProperties(fraction = runtime.state.splitFraction) {
    const r = runtime.work.getBoundingClientRect();
    const layout = runtime.E.propertiesLayout(r.width, r.height, fraction, !!runtime.state.propertiesVisible);
    runtime.state.splitFraction = layout.fraction;
    runtime.work.classList.toggle('properties-below', layout.below);
    runtime.rule('split', `#work { grid-template-columns: ${layout.columns}; grid-template-rows: ${layout.rows}; }`);
    runtime.divider.setAttribute('aria-orientation', layout.below ? 'horizontal' : 'vertical');
    runtime.divider.setAttribute('aria-label', layout.below ? 'Properties panel height' : 'Properties panel width');
    runtime.divider.setAttribute('aria-valuemin', String(Math.round(layout.minFraction * 100)));
    runtime.divider.setAttribute('aria-valuemax', String(Math.round(layout.maxFraction * 100)));
    runtime.divider.setAttribute('aria-valuenow', String(Math.round(layout.fraction * 100)));
    // Read the editor's new grid cell size after changing the tracks.
    runtime.editor?.layout(); runtime.schedule();
    return layout;
  }
  function split(fraction) { layoutProperties(fraction); runtime.persist(); }
  runtime.divider.addEventListener('keydown', e => {
    const below = runtime.E.propertiesLayout(runtime.work.getBoundingClientRect().width, 0, runtime.state.splitFraction, !!runtime.state.propertiesVisible).below;
    const keys = below ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (keys.includes(e.key)) { e.preventDefault(); split(runtime.state.splitFraction + (e.key === keys[0] ? .03 : -.03)); runtime.send('presentation', { splitFraction: runtime.state.splitFraction }); }
  });
  runtime.divider.addEventListener('pointerdown', e => { runtime.divider.setPointerCapture(e.pointerId); });
  runtime.divider.addEventListener('pointermove', e => { if (runtime.divider.hasPointerCapture(e.pointerId)) {
    const r = runtime.work.getBoundingClientRect(), below = runtime.E.propertiesLayout(r.width, r.height, runtime.state.splitFraction, !!runtime.state.propertiesVisible).below;
    split(below ? (r.bottom - e.clientY) / Math.max(1, r.height - 6) : (r.right - e.clientX) / Math.max(1, r.width));
  } });
  runtime.divider.addEventListener('pointerup', e => { if (runtime.divider.hasPointerCapture(e.pointerId)) runtime.divider.releasePointerCapture(e.pointerId); runtime.send('presentation', { splitFraction: runtime.state.splitFraction }); });
  let scopeSelection, scopeDepth = 0;
  function renderInspector() {
    const existing = [...runtime.inspector.querySelectorAll('details')];
    if (existing.length) runtime.expanded = new Set(existing.filter(d => d.open).map(d => d.dataset.name));
    const focusId = runtime.inspector.contains(document.activeElement) ? document.activeElement.id : null;
    runtime.inspector.replaceChildren();
    const term = runtime.selected.properties;
    if (!term) { scopeSelection = undefined; scopeDepth = 0; runtime.inspector.append(runtime.element('p', 'No term at cursor')); return; }
    const selection = `${runtime.env?.generation}:${runtime.projection.position}:${runtime.selected.syntaxId}`;
    if (scopeSelection !== selection) { scopeSelection = selection; scopeDepth = 0; }
    function group(name, title, lines, defaultOpen = false) {
      const details = runtime.element('details'); details.dataset.name = name; details.open = runtime.expanded ? runtime.expanded.has(name) : defaultOpen;
      details.append(runtime.id(runtime.element('summary', title), `property-${name}`), runtime.element('div', lines, 'property')); details.addEventListener('toggle', () => { runtime.expanded = new Set([...runtime.inspector.querySelectorAll('details[open]')].map(d => d.dataset.name)); runtime.persist(); }); runtime.inspector.append(details); return details;
    }
    const binding = records => {
      const entries = records.filter(b => b.status === 'known' || b.status === 'unavailable');
      return entries.length ? entries.map(b => {
        const phase = `In phase ${b.phase}${b.phase === 1 ? ' (transformer phase)' : ''}:`;
        if (b.status === 'unavailable') return `${phase} ${b.reason}`;
        if (b.kind === 'lexical') return `${phase} lexical`;
        if (b.kind === 'top-level') return `${phase} top-level`;
        return [phase, `  Defined in: ${b.definedIn}`,
          b.originalName !== b.name ? `    As: ${b.originalName}` : '',
          `  Imported from: ${b.importedFrom}`,
          b.providedName !== b.name ? `    As: ${b.providedName}` : ''].filter(Boolean).join('\n');
      }).join('\n') : 'none';
    };
    group('binding', 'Apparent identifier binding', term.kind === 'identifier' ? binding(term.bindings) : 'Not applicable', true);
    for (const key of ['top', 'app', 'datum']) group(`implicit-${key}`, `Binding if used for #%${key}`, binding(term.implicitBindings[key]));
    const source = term.source && runtime.projection.sources[term.source.sourceId];
    const sourceGroup = group('source', 'Source location', '', true);
    const sourceText = runtime.selected.sourceLocation || runtime.M.sourceLabel(term.source, source);
    const sourceLink = runtime.element('a', sourceText); sourceLink.href = '#';
    sourceLink.addEventListener('click', e => { e.preventDefault(); runtime.send('goToSource'); });
    sourceGroup.querySelector('.property').append(sourceLink);
    const phases = [0, ...Array.from({ length: scopeDepth }, (_, i) => i + 1), ...Array.from({ length: scopeDepth }, (_, i) => -i - 1)];
    const scopeGroup = group('scopes', 'Scopes', phases.map(phase => {
      const s = term.scopes.find(s => s.phase === phase);
      return `Scopes at phase ${phase}:\n${!s ? '' : s.status === 'unavailable' ? s.reason : s.scopes.map(s => s.description).join('\n')}`;
    }).join('\n\n'), true);
    const controls = runtime.element('div');
    controls.append(runtime.element('span', 'Show scopes at '));
    function phaseLink(text, id, action) {
      const link = runtime.id(runtime.element('a', text), id); link.href = '#';
      link.addEventListener('click', e => { e.preventDefault(); if (!runtime.state.busy) action(); });
      controls.append(link);
    }
    phaseLink('more phases', 'more-phases', () => {
      scopeDepth++;
      runtime.send('morePhases', { phases: [scopeDepth, -scopeDepth] });
      renderInspector();
    });
    if (scopeDepth) {
      controls.append(runtime.element('span', ' | '));
      phaseLink('fewer phases', 'fewer-phases', () => { scopeDepth--; renderInspector(); });
    }
    controls.append(runtime.element('span', '.'));
    scopeGroup.querySelector('.property').append(controls);
    group('builtins', 'Built-in properties', `Tamper status: ${term.builtins.tamperStatus}\nSource module: ${term.builtins.sourceModule ?? 'unavailable'}\nOriginal?: ${term.builtins.original ? '#t' : '#f'}`, true);
    group('properties', 'Additional properties', term.properties.length ? term.properties.map(p => `${p.name}: ${p.value.text}${p.value.truncated ? `\nTruncated: ${p.value.reason}` : ''}`).join('\n') : 'No additional properties available.', true);
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  return { split, renderInspector, layoutProperties };
};
