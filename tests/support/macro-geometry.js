// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Checks arrow boundaries, marker geometry and viewport clipping.
'use strict';
const assert = require('node:assert/strict');
const Geometry = require('../../vscode/macro-view/geometry');
const rect = (x, y, w = 12, h = 18) => ({ left: x, top: y, right: x + w, bottom: y + h });
const clip = { left: 0, top: 0, right: 300, bottom: 200 };
const edge = { certainty: 'definite', phase: 0 };
function pathPoints(arrow) {
  const numbers = arrow.path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);
  assert.ok(numbers.every(Number.isFinite));
  assert.match(arrow.path, /^M .* [LC] /);
  const points = [];
  for (let i = 0; i < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] });
  assert.match(arrow.path, /^M [^A-Z]+(?:C [^A-Z]+)?L [^A-Z]+$/);
  assert.equal(points.length, arrow.path.includes(' C ') ? 5 : 2);
  return points;
}
function pointOnPath(points, t) {
  if (points.length === 2) return { x: points[0].x * (1 - t) + points[1].x * t, y: points[0].y * (1 - t) + points[1].y * t };
  // Check each actual segment, including the straight run beyond the cubic.
  if (t >= .5) return pointOnPath(points.slice(3), 2 * t - 1);
  points = points.slice(0, 4); t *= 2;
  const weights = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
  return { x: points.reduce((sum, p, i) => sum + p.x * weights[i], 0), y: points.reduce((sum, p, i) => sum + p.y * weights[i], 0) };
}
function onBoxBoundary(point, box) {
  const epsilon = 1e-7;
  return point.x >= box.left - epsilon && point.x <= box.right + epsilon && point.y >= box.top - epsilon && point.y <= box.bottom + epsilon &&
    Math.min(Math.abs(point.x - box.left), Math.abs(point.x - box.right), Math.abs(point.y - box.top), Math.abs(point.y - box.bottom)) < epsilon;
}
function insideBox(point, box, inset = 1e-7) {
  return point.x > box.left + inset && point.x < box.right - inset && point.y > box.top + inset && point.y < box.bottom - inset;
}
function checkArrowGeometry(arrow, source, target, sameLine = false) {
  const points = pathPoints(arrow), start = points[0], end = points.at(-1);
  assert.deepEqual(start, arrow.start); assert.deepEqual(end, arrow.end);
  assert.ok(onBoxBoundary(start, source), 'Start is on the source boundary');
  assert.ok(onBoxBoundary(end, target), 'End is on the target boundary');
  for (let i = 0; i <= 1000; i++) {
    const point = pointOnPath(points, i / 1000);
    assert.ok(!insideBox(point, source) && !insideBox(point, target), 'Path stays outside both interiors');
  }
  const previous = points.at(-2), dx = end.x - previous.x, dy = end.y - previous.y;
  const length = Math.hypot(dx, dy);
  assert.ok(length >= Geometry.headLength, 'The final straight segment carries the entire head');
  assert.ok(insideBox({ x: end.x + dx / length * .01, y: end.y + dy / length * .01 }, target), 'The final tangent points into the target');
  if (sameLine) {
    assert.equal(points.length, 5, 'Same-line text uses an arc followed by a straight run');
    assert.ok(length > Geometry.headLength, 'The curve stops before the head base with clearance');
    assert.equal(previous.x, end.x, 'Same-line heads enter vertically');
    assert.equal(start.y, source.top); assert.equal(end.y, target.top);
    assert.ok(pointOnPath(points, .25).y < Math.min(source.top, target.top), 'The arc rises above the text');
  } else assert.equal(points.length, 2, 'Different lines use a straight segment');
  assert.equal(arrow.label, undefined, 'Arrows carry no text');
  assert.equal(arrow.labelAt, undefined, 'Arrows have no text position');
}
const routingCases = [
  ['same line right', rect(30, 60, 24), rect(180, 60, 36), true],
  ['same line left', rect(180, 60, 36), rect(30, 60, 24), true],
  ['above', rect(70, 110, 30), rect(70, 30, 30)],
  ['below', rect(70, 30, 30), rect(70, 110, 30)],
  ['down right', rect(30, 30), rect(150, 120, 60)],
  ['down left', rect(150, 30, 60), rect(30, 120)],
  ['up right', rect(30, 120), rect(150, 30, 60)],
  ['up left', rect(150, 120, 60), rect(30, 30)],
  ['overlapping lines right', rect(30, 30, 24, 24), rect(100, 42, 48, 24)],
  ['overlapping lines left', rect(100, 42, 48, 24), rect(30, 30, 24, 24)],
  ['coincident occurrences', rect(70, 30, 30), rect(70, 30, 30), true],
  ['same line offscreen', rect(-100, -10), rect(90, -10), true]
];
function checkNoArrowText(layer) {
  assert.deepEqual(layer.querySelectorAll('text').map(n => n.textContent), [], 'SVG arrows carry no text');
}
function checkArrowMarker(layer) {
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const nodes = descendants(layer), paths = nodes.filter(n => n.attributes.class?.split(' ').includes('edge'));
  assert.ok(paths.length);
  assert.equal(nodes.filter(n => n.attributes.class?.split(' ').includes('head')).length, paths.length);
  for (const path of paths) {
    const marker = nodes.find(n => n.tagName === 'marker' && `url(#${n.attributes.id})` === path.attributes['marker-end']);
    const points = pathPoints({ path: path.attributes.d });
    if (points[0].x === points.at(-1).x && points[0].y === points.at(-1).y) {
      assert.equal(path.attributes['marker-end'], undefined, 'Zero-length endpoints have no head'); continue;
    }
    assert.ok(marker, 'Every nonzero path uses an end marker');
    assert.equal(marker.parentNode, path.parentNode, 'Head inherits the arrow kind and kept state');
    assert.equal(marker.attributes.orient, 'auto');
    assert.equal(marker.attributes.markerUnits, 'userSpaceOnUse');
    assert.equal(Number(marker.attributes.markerWidth), 8 * Math.cos(Math.PI / 8));
    assert.equal(Number(marker.attributes.markerHeight), 16 * Math.sin(Math.PI / 8));
    const head = marker.children[0], numbers = head.attributes.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.match(head.attributes.d, / Z$/);
    assert.deepEqual(numbers.slice(2, 4), [0, 0]);
    assert.equal(Number(marker.attributes.refX), 0); assert.equal(Number(marker.attributes.refY), 0);
    assert.equal(numbers[0], -Geometry.headLength); assert.equal(numbers[4], -Geometry.headLength);
    assert.equal(numbers[1], -Geometry.headHalfWidth); assert.equal(numbers[5], Geometry.headHalfWidth);
    assert.equal(Number(path.attributes['stroke-width']), 1);
    assert.equal(path.attributes['stroke-dasharray'], undefined);
    const end = points.at(-1), previous = points.at(-2);
    assert.ok(Math.hypot(end.x - previous.x, end.y - previous.y) >= Geometry.headLength);
    assert.equal(path.parentNode.attributes['clip-path'], 'url(#program-clip)');
    const circle = path.parentNode.children.find(n => n.tagName === 'circle');
    assert.equal(circle.attributes.class, 'origin');
    assert.equal(Number(circle.attributes.r), 2.5);
    assert.equal(Number(circle.attributes.cx), points[0].x); assert.equal(Number(circle.attributes.cy), points[0].y);
  }
}
module.exports = { rect, clip, edge, pathPoints, pointOnPath, onBoxBoundary, insideBox, checkArrowGeometry, routingCases, checkNoArrowText, checkArrowMarker };
