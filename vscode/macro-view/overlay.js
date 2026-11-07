// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Measures and draws binding arrows and occurrence boxes.
/* global MacroView */
MacroView.createOverlay = function (runtime) {
  'use strict';
  const arrowLayer = svgElement('svg', { class: 'arrows', 'aria-hidden': 'true' });
  function rectangles(m, range) {
    return runtime.G.monacoRectangles(runtime.editor, runtime.editorModel, runtime.E.range(runtime.editorModel, m, range));
  }
  function svgElement(name, attrs = {}) { const e = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, String(value)); return e; }
  function visibleEdges(section) {
    if (runtime.state.drawBindingArrows === false) return [];
    const kept = runtime.M.keptEdges(runtime.projection, runtime.state.pins || [], section.id);
    const keptIds = new Set(kept.map(edge => edge.id));
    const transient = runtime.hover?.sectionId === section.id ? runtime.incident(runtime.hover) : [];
    return [...new Map([...kept, ...transient].map(edge => [edge.id,
      { edge, pinned: keptIds.has(edge.id) }])).values()];
  }
  function label(group, text, referenceRects) {
    const font = runtime.editor.getOption(runtime.monaco.editor.EditorOption.fontInfo);
    const node = svgElement('text', { class: 'arrow-label-text', 'font-family': font.fontFamily, 'font-size': font.fontSize,
      'font-weight': font.fontWeight, 'font-style': 'normal' });
    node.textContent = 'x'; group.append(node);
    const x = node.getBBox(); node.textContent = text;
    const box = runtime.G.labelGeometry(referenceRects, x, node.getBBox());
    // The measuring text is replaced after the box, keeping its background behind it.
    group.replaceChildren(svgElement('rect', { class: 'arrow-label-box', x: box.x, y: box.y,
      width: box.width, height: box.height, rx: box.rx }), node);
    node.setAttribute('font-weight', 'normal');
    node.setAttribute('x', box.textX); node.setAttribute('y', box.textY);
  }

  function draw() {
    if (runtime.frame) cancelAnimationFrame(runtime.frame);
    runtime.frame = 0; runtime.drawn = []; runtime.boxes = [];
    const targets = runtime.projection ? runtime.M.hoverBoxes(runtime.projection, runtime.hover, runtime.state.pins || []) : [];
    arrowLayer.replaceChildren();
    const layout = runtime.editor?.getLayoutInfo();
    if (!layout) return;
    arrowLayer.setAttribute('width', layout.width); arrowLayer.setAttribute('height', layout.height);
    arrowLayer.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    const defs = svgElement('defs'), clipPath = svgElement('clipPath', { id: 'program-clip' });
    clipPath.append(svgElement('rect', { x: layout.contentLeft, y: 0, width: layout.contentWidth, height: layout.height - layout.horizontalScrollbarHeight }));
    defs.append(clipPath); arrowLayer.append(defs);
    let markerNumber = 0;
    for (const m of runtime.partsBySection.values()) {
      for (const target of targets.filter(p => p.sectionId === m.section.id)) {
        const occurrence = runtime.M.find(runtime.projection, target).occurrence;
        // Adjacent token spans belong to a single box on each printed line.
        const lines = [];
        for (const r of rectangles(m, occurrence.range)) {
          const line = lines.find(line => Math.abs(line.top - r.top) < 1 && Math.abs(line.bottom - r.bottom) < 1 && r.left <= line.right + 1);
          if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); }
          else lines.push({ ...r });
        }
        for (const r of lines) {
          runtime.boxes.push({ ...target, ...r });
        }
      }
      const edges = visibleEdges(m.section);
      edges.forEach(({ edge, pinned }, lane) => {
        const binder = m.section.occurrences.find(o => o.id === edge.binder), reference = m.section.occurrences.find(o => o.id === edge.reference);
        const binderRects = rectangles(m, binder.range), referenceRects = rectangles(m, reference.range);
        const geometry = runtime.G.route({ binder: binderRects, reference: referenceRects,
          clip: { left: layout.contentLeft, top: 0, right: layout.contentLeft + layout.contentWidth, bottom: layout.height }, edge, pinned, lane: lane % 6 });
        if (geometry.continuation) return;
        const group = svgElement('g', { class: `binding-arrow ${edge.certainty}${pinned ? ' kept' : ''}`,
          'clip-path': 'url(#program-clip)' });
        m.svg.append(group);
        const markerId = `binding-head-${++markerNumber}`, depth = runtime.G.headLength, half = runtime.G.headHalfWidth;
        const marker = svgElement('marker', { id: markerId, viewBox: `${-depth} ${-half} ${depth} ${2 * half}`,
          refX: 0, refY: 0, markerWidth: depth, markerHeight: 2 * half, markerUnits: 'userSpaceOnUse', orient: 'auto', overflow: 'visible' });
        marker.append(svgElement('path', { d: `M ${-depth} ${-half} L 0 0 L ${-depth} ${half} Z`, class: 'head' }));
        const path = svgElement('path', { d: geometry.path, class: 'edge', 'stroke-width': runtime.G.strokeWidth,
          ...(geometry.start.x !== geometry.end.x || geometry.start.y !== geometry.end.y ? { 'marker-end': `url(#${markerId})` } : {}) });
        group.append(marker, path, svgElement('circle', { class: 'origin', cx: geometry.start.x, cy: geometry.start.y, r: runtime.G.originRadius }));
        const text = runtime.G.arrowLabel(edge);
        if (text) { const caption = svgElement('g'); group.append(caption); label(caption, text, referenceRects); }

        runtime.drawn.push({ sectionId: m.section.id, binder: edge.binder, reference: edge.reference, path: path.getAttribute('d'), certainty: edge.certainty, start: geometry.start, end: geometry.end,
          binderRect: geometry.binderRect, referenceRect: geometry.referenceRect });
      });
    }
  }
  function schedule() { if (!runtime.frame) runtime.frame = requestAnimationFrame(draw); }
  return { schedule, arrowLayer, draw, rectangles };
};
