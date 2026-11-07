// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Routes shafts and sizes the fixed arrow ornaments and measured captions.
(function (root) {
  'use strict';
  // End ornaments use fixed CSS pixels, independent of stroke and editor zoom.
  const strokeWidth = 1, originRadius = 2.5, headSide = 8;
  const headLength = headSide * Math.cos(Math.PI / 8), headHalfWidth = headSide * Math.sin(Math.PI / 8);
  const headRun = 10;
  const center = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
  // Intersect a ray from the rectangle's centre with its outer boundary.
  // The hover outline is inset by its 1px width, so it stays inside these bounds.
  function boundary(rect, towards) {
    const c = center(rect), dx = towards.x - c.x, dy = towards.y - c.y;
    const scale = Math.min(dx ? (rect.right - rect.left) / (2 * Math.abs(dx)) : Infinity,
      dy ? (rect.bottom - rect.top) / (2 * Math.abs(dy)) : Infinity);
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  function route({ binder = [], reference = [], clip, edge, pinned = false, lane = 0 }) {
    // Offscreen rectangles are real endpoints too. Let the section's SVG clip
    // the curve; discarding either endpoint would discard the entire arrow.
    const bs = binder, rs = reference;
    if (!bs.length || !rs.length) {
      const rect = bs[0] || rs[0];
      return { continuation: true, missing: bs.length ? 'reference' : 'binder', at: rect ? center(rect) : null,
        pinned, certainty: edge.certainty };
    }
    let pair, distance = Infinity;
    for (const b of bs) for (const r of rs) {
      const a = center(b), z = center(r), d = (a.x - z.x) ** 2 + (a.y - z.y) ** 2;
      if (d < distance) { distance = d; pair = [b, r]; }
    }
    const [b, r] = pair;
    const sameLine = Math.abs(b.top - r.top) < 1 && Math.abs(b.bottom - r.bottom) < 1;
    let start, end, path;
    if (sameLine) {
      start = { x: center(b).x, y: b.top }; end = { x: center(r).x, y: r.top };
      const lift = Math.min(b.top, r.top) - 20 - Math.min(20, Math.abs(end.x - start.x) * .12) - lane * 4;
      // Finish the curve above the head's base. The final straight run carries
      // the whole marker into the top edge, including on reversed paths.
      const approach = { x: end.x, y: end.y - headRun };
      path = `M ${start.x} ${start.y} C ${start.x} ${lift}, ${approach.x} ${lift}, ${approach.x} ${approach.y} L ${end.x} ${end.y}`;
    } else {
      start = boundary(b, center(r)); end = boundary(r, center(b));
      path = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    }
    return { start, end, path, binderRect: b, referenceRect: r,
      pinned, certainty: edge.certainty, continuation: false, clip };
  }
  // Monaco supplies both coordinates, including view zones, folding, font
  // metrics and scroll offsets. Never estimate columns using character widths.
  function monacoRectangles(editor, model, range) {
    const result = [];
    for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
      const start = line === range.startLineNumber ? range.startColumn : 1;
      const end = line === range.endLineNumber ? range.endColumn : model.getLineMaxColumn(line);
      if (end <= start) continue;
      const a = editor.getScrolledVisiblePosition({ lineNumber: line, column: start });
      const b = editor.getScrolledVisiblePosition({ lineNumber: line, column: end });
      if (a && b && b.left > a.left) result.push({ left: a.left, right: b.left, top: a.top, bottom: a.top + a.height });
    }
    return result;
  }
  function arrowLabel(edge) {
    return edge.certainty === 'possible' ? '?' : Number.isInteger(edge.phase) && edge.phase !== 0 ? `phase ${edge.phase}` : '';
  }
  function labelGeometry(rectangles, x, text) {
    const first = rectangles[0], last = rectangles.at(-1), padding = Math.max(0, text.y + text.height);
    const left = (first.left + last.right) / 2 + x.width;
    const top = (first.top + last.top) / 2 + x.height;
    const width = text.width + 2 * padding, height = text.height + 2 * padding;
    return { x: left, y: top, width, height, rx: Math.min(width, height) / 4,
      textX: left + padding - text.x, textY: top + padding - text.y };
  }
  const api = { route, monacoRectangles, arrowLabel, labelGeometry, originRadius, headSide, headHalfWidth, strokeWidth, headLength, headRun };
  if (typeof module === 'object') module.exports = api; else root.MacroGeometry = api;
})(globalThis);
