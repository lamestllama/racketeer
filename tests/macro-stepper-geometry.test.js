// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks macro stepper geometry behavior.
'use strict';
const { routingCases, clip, checkArrowGeometry, rect, edge, pathPoints, checkNoArrowText, checkArrowMarker, onBoxBoundary } = require('./support/macro-geometry');
const { root, plain, load } = require('./support/macro-common');
const test = require('./support/node-test');
const Geometry = require('../vscode/macro-view/geometry');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Data = require('../vscode/macro-view-data');
const Model = require('../vscode/macro-view/model');
const { fixtureAnswer, summaryOf, project, pair, fakeModel } = require('./support/macro-fixtures');
const { fakeMacroConnections } = require('./support/macro-page');

for (const [name, source, target, sameLine] of routingCases) test(`arrow boundary routing: ${name}`, () => {
  for (const lane of [0, 5]) {
    const arrow = Geometry.route({ binder: [source], reference: [target], clip, edge: { certainty: 'possible', phase: -1 }, lane });
    checkArrowGeometry(arrow, source, target, sameLine);
  }
});

test('boundary checks reject interior attachments, box crossings and flat same-line paths', () => {
  const source = rect(30, 60, 24), target = rect(180, 60, 36);
  const good = Geometry.route({ binder: [source], reference: [target], clip, edge });
  checkArrowGeometry(good, source, target, true);
  const broken = [
    { ...good, start: { x: 42, y: 69 }, path: `M 42 69 C 42 30, 198 30, 198 50 L 198 60` },
    { ...good, end: { x: 198, y: 69 }, path: `M 42 60 C 42 30, 198 30, 198 59 L 198 69` },
    { ...good, start: { x: 42, y: 60 }, end: { x: 198, y: 60 }, path: `M 42 60 C 42 100, 198 100, 198 50 L 198 60` },
    { ...good, start: { x: 54, y: 69 }, end: { x: 180, y: 69 }, path: `M 54 69 L 180 69` },
    { ...good, start: { x: 42, y: 60 }, end: { x: 198, y: 60 }, path: `M 42 60 C 42 30, 178 60, 188 60 L 198 60` }
  ];
  for (const arrow of broken) assert.throws(() => checkArrowGeometry(arrow, source, target, true), assert.AssertionError);
});

test('head approach checks reject curved endings and short final runs in arcs and diagonals', () => {
  for (const [name, source, target, sameLine] of routingCases) {
    if (!sameLine && (source.left === target.left || Math.abs(source.top - target.top) < 1)) continue;
    const good = Geometry.route({ binder: [source], reference: [target], clip, edge });
    checkArrowGeometry(good, source, target, sameLine);
    const points = pathPoints(good), end = points.at(-1), previous = points.at(-2);
    const dx = end.x - previous.x, dy = end.y - previous.y, length = Math.hypot(dx, dy);
    const short = { x: end.x - dx / length * (Geometry.headLength - 1), y: end.y - dy / length * (Geometry.headLength - 1) };
    const prefix = good.path.slice(0, good.path.lastIndexOf(' L '));
    const broken = sameLine ? [
      // Restore the original curve-only ending, retaining its vertical tangent.
      { ...good, path: `${prefix.slice(0, prefix.lastIndexOf(','))}, ${end.x} ${end.y}` },
      { ...good, path: `${prefix.slice(0, prefix.lastIndexOf(','))}, ${short.x} ${short.y} L ${end.x} ${end.y}` }
    ] : [
      // A cubic with the original straight locus still has no final line.
      { ...good, path: `M ${good.start.x} ${good.start.y} C ${good.start.x} ${good.start.y}, ${short.x} ${short.y}, ${end.x} ${end.y}` },
      { ...good, path: `M ${good.start.x} ${good.start.y} C ${good.start.x} ${good.start.y}, ${short.x} ${short.y}, ${short.x} ${short.y} L ${end.x} ${end.y}` }
    ];
    for (const arrow of broken) assert.throws(() => checkArrowGeometry(arrow, source, target, sameLine), assert.AssertionError, name);
  }
});

test('head approach regressions in the router are rejected', () => {
  const source = fs.readFileSync(path.join(root, 'vscode/macro-view/geometry.js'), 'utf8');
  const mutants = [
    source.replace('${approach.x} ${approach.y} L ${end.x} ${end.y}', '${end.x} ${end.y}'),
    source.replace('const headRun = 10;', 'const headRun = headLength - 1;')
  ];
  const b = rect(30, 60, 24), r = rect(180, 60, 36);
  for (const mutant of mutants) {
    assert.notEqual(mutant, source);
    const geometry = load({}, 'vscode/macro-view/geometry.js', { 'vscode/macro-view/geometry.js': mutant });
    const arrow = plain(geometry.route({ binder: [b], reference: [r], clip, edge }));
    assert.throws(() => checkArrowGeometry(arrow, b, r, true), assert.AssertionError);
  }
});

for (const position of [3, 1]) test(`hover connects distant endpoints in ${position === 3 ? 'finished' : 'step'} programs`, () => {
  const a = fixtureAnswer({ sourceHash: '0'.repeat(64), sourceVersion: 1 });
  const section = position === 3 ? a.final : a.steps[0].before;
  section.text = `(x\n${'  ; padding\n'.repeat(220)}  x x)\n`;
  const reference = section.text.lastIndexOf('x x');
  section.focus = [];
  section.occurrences[0].range = [0, section.text.length - 1];
  section.occurrences[0].delimiterRanges = [[0, 1], [section.text.length - 2, section.text.length - 1]];
  section.occurrences[2].range = [reference, reference + 1];
  section.occurrences.push({ ...section.occurrences[2], id: 'possible', range: [reference + 2, reference + 3] });
  section.edges.push({ id: 'possible-edge', binder: 'b', reference: 'possible', certainty: 'possible', phase: null });
  Data.validateAnswer(summaryOf(a), a.snapshot);
  const p = project(a, position), starts = Model.lineStarts(section.text);
  const hovered = pair(section.id, Model.hit(section, 1).id);
  const edges = Model.incident(p, hovered);
  assert.equal(edges.length, 2);
  assert.deepEqual(Model.incident(p, pair('foreign')), []);
  // Rectangles supplied by the DOM adapter, in viewport coordinates. A measured
  // reference below the scroll area must still produce a clipped SVG path.
  const binder = [rect(40, 20)], references = [[rect(50, 4420)], [rect(80, 4420)]];
  for (const [i, edge] of edges.entries()) {
    const arrow = Geometry.route({ binder, reference: references[i], clip, edge });
    assert.ok(arrow.path, 'Hovering a binder produces a path to every measured reference');
    assert.equal(arrow.continuation, false);
    assert.equal(arrow.certainty, edge.certainty);
    assert.equal(arrow.end.y, references[i][0].top);
    checkArrowGeometry(arrow, binder[0], references[i][0]);
    const target = pair(section.id, edge.reference);
    assert.equal(Model.hit(section, Model.find(p, target).occurrence.range[0]).id, target.occurrenceId);
    assert.deepEqual(Model.incident(p, target), [edge]);
    const reverse = Geometry.route({ binder: [rect(40, -4380)], reference: [rect(50, 20)], clip, edge });
    assert.ok(reverse.path, 'Hovering a reference produces a path from its offscreen binder');
    assert.equal(reverse.start.y, -4362);
  }
});

test('arrow routing chooses nearest multiline endpoints, supports both directions and pins without text', () => {
  const input = { binder: [rect(50, 10), rect(80, 40)], reference: [rect(70, 80)], clip, edge };
  const forward = Geometry.route(input);
  assert.deepEqual(forward.binderRect, input.binder[1]);
  assert.deepEqual(forward.start, { x: 83.75, y: 58 }); assert.deepEqual(forward.end, { x: 78.25, y: 80 });
  checkArrowGeometry(forward, input.binder[1], input.reference[0]);
  assert.equal(forward.pinned, false); assert.equal(forward.continuation, false); assert.equal(forward.label, undefined);
  assert.deepEqual(Geometry.route(input), forward);
  const backward = Geometry.route({ ...input, binder: input.reference, reference: input.binder, pinned: true, edge: { certainty: 'possible', phase: 'label' } });
  assert.ok(backward.start.y > backward.end.y); assert.equal(backward.pinned, true); assert.equal(backward.label, undefined);
  assert.equal(Geometry.label, undefined);
  assert.equal(Geometry.route({ ...input, lane: 2 }).path, forward.path, 'Different-line paths remain straight in every lane');
  const sameLine = Geometry.route({ ...input, binder: [rect(80, 40)], reference: [rect(80, 40)] });
  assert.ok(!sameLine.path.includes('NaN')); assert.equal(sameLine.labelAt, undefined);
  assert.notEqual(Geometry.route({ ...input, binder: [rect(80, 40)], reference: [rect(80, 40)], lane: 2 }).path, sameLine.path);
});

test('unmounted endpoints yield continuation, while measured offscreen endpoints retain their paths', () => {
  {
    const g = Geometry.route({ binder: [rect(40, 20)], reference: [], clip, edge });
    assert.equal(g.continuation, true); assert.equal(g.missing, 'reference'); assert.equal(g.path, undefined); assert.equal(g.end, undefined);
  }
  const input = { binder: [rect(40, 20)], reference: [rect(40, 250)], clip, edge };
  assert.equal(Geometry.route(input).continuation, false);
  assert.equal(Geometry.route({ ...input, clip: { ...clip, bottom: 300 } }).continuation, false);
  const scroll = [rect(40, -180)], use = [rect(40, 50)];
  assert.equal(Geometry.route({ binder: scroll, reference: use, clip, edge }).continuation, false);
});

test('arrow kinds, signed phases, labels and kept ornaments follow their edge', () => {
  const pane = fakeMacroConnections('before'), { page } = pane;
  pane.render(project(fixtureAnswer({}), 1)); page.hover = pair();
  for (const phase of [0, 1, -1, 'label', null]) for (const certainty of ['definite', 'possible']) {
    Object.assign(page.projection.record.before.edges[0], { phase, certainty });
    for (const kept of [false, true]) {
      page.state.pins = kept ? [pair()] : [];
      pane.observe();
      const expected = certainty === 'possible' ? '?' : Number.isInteger(phase) && phase !== 0 ? `phase ${phase}` : '';
      assert.deepEqual(page.arrowLayer.querySelectorAll('text').map(n => n.textContent), expected ? [expected] : []);
      const group = page.arrowLayer.children.find(n => n.attributes.class?.startsWith('binding-arrow'));
      assert.equal(group.attributes.class, `binding-arrow ${certainty}${kept ? ' kept' : ''}`);
      checkArrowMarker(page.arrowLayer);
      if (expected) {
        const caption = group.children.at(-1), [box, text] = caption.children;
        const r = page.drawn[0].referenceRect;
        assert.equal(Number(box.attributes.x), (r.left + r.right) / 2 + 7);
        assert.equal(Number(box.attributes.y), r.top + 10);
        assert.equal(Number(box.attributes.width), expected.length * 7 + 4);
        assert.equal(Number(box.attributes.height), 14); assert.equal(Number(box.attributes.rx), Math.min(expected.length * 7 + 4, 14) / 4);
        assert.equal(text.attributes['font-family'], 'monospace'); assert.equal(text.attributes['font-size'], '14');
        assert.equal(text.attributes['font-weight'], 'normal'); assert.equal(text.attributes['font-style'], 'normal');
      }
    }
  }
  pane.editor.getScrolledVisiblePosition = position => position.column >= 4 ? null : ({ left: 40 + position.column * 8, top: 20, height: 18 });
  pane.observe(); checkNoArrowText(page.arrowLayer);
});

test('draw uses an oriented marker whose reference is its tip, with viewport clipping', () => {
  const pane = fakeMacroConnections('before'); pane.render(project(fixtureAnswer({}), 1));
  pane.page.hover = pair('b1', 'b');
  const dom = pane.observe(), layer = pane.page.arrowLayer;
  checkArrowMarker(layer);
  for (const arrow of dom.arrows) checkArrowGeometry(arrow, arrow.binderRect, arrow.referenceRect, true);
  const clipRect = layer.children[0].children.find(n => n.tagName === 'clipPath').children[0];
  assert.deepEqual(clipRect.attributes, { x: '40', y: '0', width: '800', height: '390' });
  const marker = layer.children.find(n => n.attributes.class?.startsWith('binding-arrow')).children.find(n => n.tagName === 'marker');
  marker.attributes.orient = '0';
  assert.throws(() => checkArrowMarker(layer), assert.AssertionError);
  marker.attributes.orient = 'auto'; marker.attributes.refX = '-1';
  assert.throws(() => checkArrowMarker(layer), assert.AssertionError);
  const css = fs.readFileSync(path.join(root, 'vscode/macro-view/view.css'), 'utf8');
  assert.match(css, /svg \.definite :is\(\.edge, \.head, \.origin, \.arrow-label-box\) \{ stroke: var\(--vscode-charts-green\)/);
  assert.match(css, /svg \.possible :is\(\.edge, \.head, \.origin, \.arrow-label-box\) \{ stroke: var\(--vscode-charts-yellow\)/);
  assert.match(css, /svg \.edge\s*\{ fill: none; \}/);
  assert.match(css, /svg \.head, svg \.origin, svg \.arrow-label-box\s*\{ fill: var\(--vscode-editor-background\); stroke-width: 1;/);
  for (const [kind, colour] of [['definite', 'green'], ['possible', 'yellow']]) {
    assert.match(css, new RegExp(`svg \\.${kind}\\.kept :is\\(\\.head, \\.origin\\), svg \\.${kind} \\.arrow-label-text \\{ fill: var\\(--vscode-charts-${colour}\\)`));
  }
  assert.doesNotMatch(css, /dasharray/);
});

test('rendered arc and diagonal heads follow the final segment and reject rotated or oversized heads', () => {
  for (const [name, source, target, sameLine] of routingCases) {
    const pane = fakeMacroConnections('before'); pane.render(project(fixtureAnswer({}), 1));
    pane.page.hover = pair('b1', 'b');
    pane.editor.getScrolledVisiblePosition = position => {
      const box = position.column <= 3 ? source : target;
      return { left: position.column % 2 === 0 ? box.left : box.right, top: box.top, height: box.bottom - box.top };
    };
    const dom = pane.observe(), layer = pane.page.arrowLayer;
    assert.equal(dom.arrows.length, 1, name);
    for (const arrow of dom.arrows) checkArrowGeometry(arrow, source, target, sameLine);
    checkArrowMarker(layer);
    const marker = layer.children.find(n => n.attributes.class?.startsWith('binding-arrow')).children.find(n => n.tagName === 'marker');
    const head = marker.children[0];
    if (source.left === target.left && source.top === target.top) continue;
    const original = head.attributes.d;
    head.attributes.d = 'M 0 0 L 6 3 L 0 4 Z';
    assert.throws(() => checkArrowMarker(layer), assert.AssertionError, name);
    head.attributes.d = original;
    marker.attributes.markerWidth = '1000';
    assert.throws(() => checkArrowMarker(layer), assert.AssertionError, name);
  }
});

for (const side of ['before', 'after']) test(`${side} pane draws and reports boxes for every transient and tacked connection in its own program`, () => {
  const panes = { before: fakeMacroConnections('before'), after: fakeMacroConnections('after') };
  const answer = fixtureAnswer({});
  // At completion Before retains the last input; After shows the final output.
  // Repeated occurrence ids make the program id essential to every assertion.
  for (const position of [3, 1]) {
    const projection = project(answer, position);
    if (position === 3) projection.terminalBefore = answer.steps.at(-1).before;
    for (const pane of Object.values(panes)) pane.render(projection);
    const pane = panes[side], other = panes[side === 'before' ? 'after' : 'before'];
    const section = Model.sections(pane.page.projection)[0].section;
    const target = pair(section.id, 'b'), expected = [target, pair(section.id, 'r')];
    const check = (message, targets = expected) => {
      const dom = pane.observe();
      assert.deepEqual(dom.boxes.map(({ sectionId, occurrenceId }) => ({ sectionId, occurrenceId })), targets, `${side} ${position}: ${message}`);
      assert.equal(dom.hoverDecorationCount, targets.length);
      assert.equal(dom.arrows.length, targets.length ? 1 : 0);
      assert.ok(dom.boxes.every(b => b.right > b.left && b.bottom > b.top));
      for (const arrow of dom.arrows) {
        assert.ok(dom.boxes.some(b => b.sectionId === arrow.sectionId && b.occurrenceId === arrow.binder && onBoxBoundary(arrow.start, b)));
        assert.ok(dom.boxes.some(b => b.sectionId === arrow.sectionId && b.occurrenceId === arrow.reference && onBoxBoundary(arrow.end, b)));
      }
      assert.deepEqual(other.observe().boxes, [], 'The other pane never supplies this pane’s boxes');
    };
    // A selection at the pointer establishes the connection even before the
    // next mouse move. Arrows must never fall back to an unboxed selection.
    pane.editor.setPosition(pane.page.editorModel.getPositionAt(1));
    pane.handlers.onMouseDown({ event: { leftButton: true }, target: { position: pane.page.editorModel.getPositionAt(1) } });
    assert.deepEqual(plain(pane.page.focused), target);
    check('selected binder');
    pane.handlers.onMouseMove({ target: { position: pane.page.editorModel.getPositionAt(1) } });
    check('hovered binder');
    pane.handlers.onMouseMove({ target: { position: pane.page.editorModel.getPositionAt(3) } });
    check('hovered reference');
    pane.handlers.onMouseLeave(); check('mouse leave', []);
    assert.deepEqual(plain(pane.page.focused), target, 'Ending hover retains syntax selection');
    pane.page.focusPair(target); check('keyboard focus');
    pane.page.state.pins = [target];
    pane.handlers.onMouseLeave(); check('tacked binder');
    pane.page.state.pins = []; pane.page.updateDecorations(); check('untacked binder', []);
  }
});

test('arrow rectangles use Monaco positions with scrolling, zones and variable column widths', () => {
  const model = fakeModel('a😀z\n\tx');
  let scrollLeft = 8, scrollTop = 20;
  const calls = [];
  const editor = { getScrolledVisiblePosition(p) {
    calls.push(p);
    const widths = { 1: [40, 49, 53, 67, 79], 2: [40, 72, 81] };
    return { left: widths[p.lineNumber][p.column - 1] - scrollLeft,
      top: (p.lineNumber === 1 ? 30 : 110) - scrollTop, height: 23 };
  } };
  const range = { startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 3 };
  const rs = Geometry.monacoRectangles(editor, model, range);
  assert.deepEqual(rs, [{ left: 41, right: 71, top: 10, bottom: 33 }, { left: 32, right: 73, top: 90, bottom: 113 }]);
  assert.deepEqual(calls, [{ lineNumber: 1, column: 2 }, { lineNumber: 1, column: 5 }, { lineNumber: 2, column: 1 }, { lineNumber: 2, column: 3 }]);
  const arrow = Geometry.route({ binder: [rs[0]], reference: [rs[1]], clip, edge });
  assert.deepEqual(arrow.start, { x: 55.496875, y: 33 }); assert.deepEqual(arrow.end, { x: 53.003125, y: 90 });
  checkArrowGeometry(arrow, rs[0], rs[1]);
  scrollLeft += 17; scrollTop += 35;
  assert.deepEqual(Geometry.monacoRectangles(editor, model, range)[1], { left: 15, right: 56, top: 55, bottom: 78 });
  assert.deepEqual(Geometry.monacoRectangles({ getScrolledVisiblePosition: () => null }, model, range), []);
});
