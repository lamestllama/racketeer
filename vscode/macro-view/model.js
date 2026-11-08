// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Validates syntax projections and derives occurrence, binding and kept-edge relations.
(function (root) {
  'use strict';
  const inside = (r, n) => r[0] <= n && n < r[1];
  const boundary = (text, n) => Number.isSafeInteger(n) && n >= 0 && n <= text.length &&
    !(n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]));
  function validRange(text, r) {
    return Array.isArray(r) && r.length === 2 && boundary(text, r[0]) && boundary(text, r[1]) && r[0] <= r[1];
  }
  function validateSection(s, terms) {
    if (!s || typeof s.id !== 'string' || typeof s.text !== 'string' || !Array.isArray(s.focus) ||
        !Array.isArray(s.occurrences) || !Array.isArray(s.edges) || !Array.isArray(s.binderOccurrences)) throw Error('Invalid section');
    if (!s.focus.every(r => validRange(s.text, r))) throw Error('Invalid focus range');
    const ids = new Map();
    for (const o of s.occurrences) {
      if (typeof o.id !== 'string' || ids.has(o.id) || !Object.hasOwn(terms, o.syntaxId) ||
          !validRange(s.text, o.range) || o.range[0] === o.range[1] ||
          !Number.isSafeInteger(o.macroScopeGroup) || o.macroScopeGroup < 0 ||
          !Array.isArray(o.delimiterRanges) || !o.delimiterRanges.every(r => validRange(s.text, r) && r[0] >= o.range[0] && r[1] <= o.range[1])) throw Error('Invalid occurrence');
      if (o.colorRange && (!validRange(s.text, o.colorRange) || o.colorRange[0] !== o.range[0] || o.colorRange[1] < o.range[1])) throw Error('Invalid color range');
      if (o.taint !== undefined && (!['armed', 'disarmed', 'tainted'].includes(o.taint) || !Number.isSafeInteger(o.taintCount) || o.taintCount < 1) || o.taint === undefined && o.taintCount !== undefined) throw Error('Invalid taint mark');
      ids.set(o.id, o);
    }
    for (const o of ids.values()) {
      if (o.parentId !== null) {
        const p = ids.get(o.parentId);
        if (!p || p.range[0] > o.range[0] || p.range[1] < o.range[1]) throw Error('Invalid parent');
        const seen = new Set([o.id]); let current = p;
        while (current) {
          if (seen.has(current.id)) throw Error('Cyclic parent');
          seen.add(current.id); current = ids.get(current.parentId);
        }
      }
    }
    const edges = new Set();
    for (const e of s.edges) {
      if (typeof e.id !== 'string' || edges.has(e.id) || !ids.has(e.binder) || !ids.has(e.reference) ||
          !['definite', 'possible'].includes(e.certainty) ||
          !(Number.isSafeInteger(e.phase) || e.phase === 'label' || (e.phase === null && e.certainty === 'possible'))) throw Error('Invalid binding edge');
      edges.add(e.id);
    }
    if (!s.binderOccurrences.every(id => ids.has(id))) throw Error('Invalid binder');
    return s;
  }
  function sections(p) {
    const context = c => ({ ...c, kind: 'before', prefix: `\n${c.label}\n` });
    if (p.record?.side && p.pane && p.record.side !== p.pane) return [];
    if (p.record?.commonContext && p.pane !== 'before') {
      return [...(p.pane ? [] : [{ section: p.record.before, label: 'Before', kind: 'before' }]),
        { section: p.record.after, label: 'After', kind: 'after' },
        { section: p.record.commonContext, label: 'In context:', kind: 'context', prefix: '\nIn context:\n' },
        ...(p.record.contexts || []).map(context)];
    }
    if (p.record?.side) {
      const side = p.record.side;
      return [{ section: p.record[side], label: side === 'before' ? 'Before' : 'After', kind: side },
        ...(p.record.contexts || []).map(context)];
    }
    if (p.record?.kind === 'remark') {
      return [{ section: p.record.before, label: p.record.label, kind: 'before' },
        ...(p.record.contexts || []).map(context)];
    }
    if (p.pane === 'before') {
      if (p.diagnostics[p.error]?.kind === 'internal') return [];
      const section = p.record?.before || p.terminalBefore || p.final || p.diagnostics[p.error]?.program;
      return section ? [{ section, label: 'Before', kind: 'before' }] : [];
    }
    if (p.pane === 'after' && !p.error) {
      const section = p.record?.after || p.final;
      return section ? [{ section, label: 'After', kind: 'after' },
        ...(p.record?.contexts || []).map(context)] : [];
    }
    const result = [], seen = new Set();
    const add = (section, label, kind, prefix) => {
      if (section && !seen.has(section.id)) { seen.add(section.id); result.push({ section, label, kind, ...(prefix ? { prefix } : {}) }); }
    };
    const diagnostic = p.error && p.diagnostics[p.error];
    if (p.record && p.pane !== 'after') add(p.record.before, 'Before', 'before');
    else if (p.final) add(p.final, 'Expansion finished', 'final');
    if (p.record?.after) add(p.record.after, 'After', 'after');
    if (diagnostic) {
      add(diagnostic.program, 'Failing program', 'before');
      for (const s of diagnostic.syntax) add(s, 'Implicated syntax', 'before');
      for (const c of diagnostic.contexts) add(c.section, c.label, 'before', context(c).prefix);
    }
    for (const c of p.record?.contexts || []) add(c.section, c.label, 'before', context(c).prefix);
    return result;
  }
  function find(p, pair) {
    const section = p && pair && sections(p).find(s => s.section.id === pair.sectionId)?.section;
    const occurrence = section?.occurrences.find(o => o.id === pair.occurrenceId);
    return occurrence ? { section, occurrence } : null;
  }
  function incident(p, pair) {
    const f = find(p, pair);
    return f ? f.section.edges.filter(e => e.binder === f.occurrence.id || e.reference === f.occurrence.id) : [];
  }
  // A kept occurrence can retain only part of its fan after another endpoint releases it.
  function pinnedEdges(p, pin) {
    return incident(p, pin).filter(edge => !pin.edgeIds || pin.edgeIds.includes(edge.id));
  }
  function keptEdges(p, pins, sectionId) {
    return [...new Map(pins.filter(pin => pin.sectionId === sectionId)
      .flatMap(pin => pinnedEdges(p, pin)).map(edge => [edge.id, edge])).values()];
  }
  function arrowStatus(p, pair, pins = []) {
    const kept = new Set(keptEdges(p, pins, pair?.sectionId).map(edge => edge.id));
    const edges = incident(p, pair);
    return { canKeepArrows: edges.some(edge => !kept.has(edge.id)), hasKeptArrows: edges.some(edge => kept.has(edge.id)) };
  }
  function bindingSentence(p, pair, { bindings, lineNumber }) {
    const f = find(p, pair), term = f && p.terms[f.occurrence.syntaxId];
    if (term?.kind !== 'identifier') return '';
    const { section, occurrence } = f;
    const name = o => `\`${section.text.slice(...o.range)}\``;
    const edges = incident(p, pair), use = edges.find(e => e.reference === occurrence.id);
    const uses = edges.filter(e => e.binder === occurrence.id);
    let phase = use?.phase ?? uses[0]?.phase ?? occurrence.phase ?? p.relationPhase ?? 0;
    let sentence;
    if (use) {
      const binder = section.occurrences.find(o => o.id === use.binder);
      sentence = `${name(occurrence)} on line ${lineNumber(section, occurrence)} refers to ${name(binder)} on line ${lineNumber(section, binder)}`;
    } else if (uses.length || section.binderOccurrences.includes(occurrence.id)) {
      const lines = [...new Set(uses.map(e => lineNumber(section, section.occurrences.find(o => o.id === e.reference))))].sort((a, b) => Number(a) - Number(b));
      const list = lines.length < 2 ? lines[0] : `${lines.slice(0, -1).join(', ')} and ${lines.at(-1)}`;
      sentence = `${name(occurrence)} on line ${lineNumber(section, occurrence)} ${lines.length ? `is used on ${lines.length === 1 ? 'line' : 'lines'} ${list}` : 'is not used here'}`;
    } else {
      // Position payloads omit inspection facts. Stay quiet until they arrive.
      const binding = bindings?.find(b => b.phase === phase) || bindings?.find(b => b.status === 'known');
      if (!binding || !['known', 'absent'].includes(binding.status)) return '';
      phase = binding.phase;
      if (binding.status === 'absent') sentence = `${name(occurrence)} is not bound here`;
      else if (binding.kind === 'module' && binding.definedIn !== 'self') {
        const origin = binding.definedIn, through = binding.importedFrom;
        sentence = `${name(occurrence)} ${origin ? `comes from \`${origin}\`` : 'is imported'}`;
        if (binding.originalName && binding.originalName !== section.text.slice(...occurrence.range)) sentence += ` as \`${binding.originalName}\``;
        if (through && through !== 'self' && through !== origin) sentence += `${origin ? ', imported' : ''} through \`${through}\``;
      } else sentence = `${name(occurrence)} is bound here`;
    }
    if (phase === 1) sentence += ' at compile time';
    else if (phase === 'label') sentence += ' for documentation only';
    else if (phase !== null && phase !== 0) sentence += ` at phase ${phase}`;
    if (occurrence.macroScopeGroup > 0 && p.record?.macro) sentence += `, introduced by \`${p.record.macro}\``;
    return sentence + '.';
  }
  function hoverBoxes(p, hover, pins = []) {
    const boxes = new Map();
    for (const pair of [...pins, ...(hover ? [hover] : [])]) {
      for (const edge of pinnedEdges(p, pair)) for (const occurrenceId of [edge.binder, edge.reference]) {
        const target = { sectionId: pair.sectionId, occurrenceId };
        boxes.set(`${pair.sectionId}:${occurrenceId}`, target);
      }
    }
    return [...boxes.values()];
  }
  // A centered interval index avoids scanning an entire program on scrolling or hit testing.
  class IntervalIndex {
    constructor(occurrences) {
      this.byId = new Map(occurrences.map(o => [o.id, o]));
      const build = items => {
        if (!items.length) return null;
        const sorted = items.slice().sort((a, b) => a.range[0] - b.range[0]);
        const center = sorted[sorted.length >>> 1].range[0], left = [], right = [], crossing = [];
        for (const o of items) {
          if (o.range[1] <= center) left.push(o);
          else if (o.range[0] > center) right.push(o);
          else crossing.push(o);
        }
        return { center, starts: crossing.slice().sort((a, b) => a.range[0] - b.range[0]),
          ends: crossing.slice().sort((a, b) => b.range[1] - a.range[1]), left: build(left), right: build(right) };
      };
      this.root = build(occurrences);
    }
    query(start, end) {
      const result = [];
      const visit = node => {
        if (!node) return;
        if (end <= node.center) {
          for (const o of node.starts) { if (o.range[0] >= end) break; result.push(o); }
          visit(node.left);
        } else if (start > node.center) {
          for (const o of node.ends) { if (o.range[1] <= start) break; result.push(o); }
          visit(node.right);
        } else { for (const o of node.starts) result.push(o); visit(node.left); visit(node.right); }
      };
      visit(this.root); return result;
    }
  }
  function hit(section, offset, occurrences = section.occurrences, byId) {
    const candidates = occurrences.filter(o => inside(o.range, offset));
    const depth = o => { let n = 0; while (o.parentId) { n++; o = byId ? byId.get(o.parentId) : section.occurrences.find(p => p.id === o.parentId); if (!o) break; } return n; };
    candidates.sort((a, b) => {
      return (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]) || depth(b) - depth(a);
    });
    return candidates[0] || null;
  }
  function clickOffset(section, occurrence) {
    // Ownership can change only at occurrence boundaries. Coincident wrappers
    // may have no character of their own; they remain reachable by keyboard.
    const points = new Set([occurrence.range[0]]);
    for (const o of section.occurrences) for (const n of o.range) {
      if (inside(occurrence.range, n)) points.add(n);
    }
    for (let n of [...points].sort((a, b) => a - b)) {
      while (n < occurrence.range[1] && /[\r\n]/.test(section.text[n])) n++;
      if (n < occurrence.range[1] && hit(section, n)?.id === occurrence.id) return n;
    }
    return null;
  }
  function move(section, id, direction) {
    const o = section.occurrences.find(o => o.id === id) || section.occurrences[0];
    if (!o) return null;
    if (direction === 'up') return section.occurrences.find(p => p.id === o.parentId) || o;
    if (direction === 'down') return section.occurrences.find(p => p.parentId === o.id) || o;
    const siblings = section.occurrences.filter(p => p.parentId === o.parentId);
    return siblings[Math.max(0, Math.min(siblings.length - 1, siblings.indexOf(o) + (direction === 'left' ? -1 : 1)))];
  }
  function rove(p, pair, direction) {
    const displayed = sections(p), found = find(p, pair);
    if (!found) {
      const first = displayed.find(x => x.section.occurrences.length);
      return first ? { sectionId: first.section.id, occurrenceId: first.section.occurrences[0].id } : null;
    }
    const next = move(found.section, found.occurrence.id, direction);
    if (next.id === found.occurrence.id && next.parentId === null && ['left', 'right'].includes(direction)) {
      const index = displayed.findIndex(s => s.section.id === found.section.id), delta = direction === 'left' ? -1 : 1;
      for (let n = index + delta; n >= 0 && n < displayed.length; n += delta) {
        const roots = displayed[n].section.occurrences.filter(o => o.parentId === null);
        if (roots.length) return { sectionId: displayed[n].section.id, occurrenceId: (delta > 0 ? roots[0] : roots.at(-1)).id };
      }
    }
    return { sectionId: found.section.id, occurrenceId: next.id };
  }
  function related(p, pair, relation) {
    const found = find(p, pair), term = found && p.terms[found.occurrence.syntaxId];
    const key = term?.kind === 'identifier' && relation !== 'none' && term.relations?.[relation];
    return key ? sections(p).flatMap(({ section }) => section.occurrences.filter(o =>
      p.terms[o.syntaxId]?.relations?.[relation] === key).map(o => ({ sectionId: section.id, occurrenceId: o.id }))) : [];
  }
  function bindingOccurrences(p, pair) {
    const f = find(p, pair);
    if (!f || p.terms[f.occurrence.syntaxId]?.kind !== 'identifier') return [];
    const connected = new Set([f.occurrence.id]);
    const neighbors = new Map();
    for (const { binder, reference } of f.section.edges) {
      if (!neighbors.has(binder)) neighbors.set(binder, []);
      if (!neighbors.has(reference)) neighbors.set(reference, []);
      neighbors.get(binder).push(reference); neighbors.get(reference).push(binder);
    }
    if (!neighbors.has(f.occurrence.id)) return p.record?.commonContext ? related(p, pair, 'free') : [];
    for (const id of connected) for (const other of neighbors.get(id) || []) connected.add(other);
    const graph = f.section.occurrences.filter(o => connected.has(o.id) && p.terms[o.syntaxId]?.kind === 'identifier')
      .map(o => ({ sectionId: f.section.id, occurrenceId: o.id }));
    return p.record?.commonContext ? [...new Map([...graph, ...related(p, pair, 'free')].map(p => [p.sectionId + ':' + p.occurrenceId, p])).values()] : graph;
  }
  function jump(value, count) {
    if (value === 'end') return count;
    if (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim())) throw Error('Enter a whole step number or end.');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > count) throw Error(`Enter a step from 1 to ${count}, or end.`);
    return n;
  }
  function copy(p, pair) {
    const f = find(p, pair);
    if (!f) throw Error('No syntax selected');
    return f.section.text.slice(...f.occurrence.range);
  }
  function lineStarts(text) {
    const starts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
  }
  function lineAt(starts, offset) {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid; else hi = mid; }
    return lo;
  }
  // Source columns expand tabs; spans count code points, with CRLF counting once.
  function sourceOffsets(text, line, column, span) {
    const next = offset => offset + (text[offset] === '\r' && text[offset + 1] === '\n'
      ? 2 : text.codePointAt(offset) > 0xffff ? 2 : 1);
    let start = 0;
    for (let row = 1; row < line && start < text.length;) {
      const character = text[start];
      start = next(start);
      if (character === '\r' || character === '\n') row++;
    }
    for (let col = 0; col < column && start < text.length && !/[\r\n]/.test(text[start]);) {
      col = text[start] === '\t' ? col + 8 - col % 8 : col + 1;
      start = next(start);
    }
    let end = start;
    for (let count = 0; count < span && end < text.length; count++) end = next(end);
    return [start, end];
  }
  function sourceLabel(location, source, text) {
    if (!location || !Number.isSafeInteger(location.line) || location.line < 1 ||
        !Number.isSafeInteger(location.column) || location.column < 0) return 'Unavailable';
    const file = source?.value || 'Unavailable source';
    let start = { line: location.line, column: location.column + 1 }, end;
    if (typeof text === 'string') {
      const offsets = sourceOffsets(text, location.line, location.column,
        Number.isSafeInteger(location.span) && location.span >= 0 ? location.span : 0);
      const starts = [0];
      for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
      const point = offset => { const line = lineAt(starts, offset); return { line: line + 1, column: offset - starts[line] + 1 }; };
      start = point(offsets[0]);
      if (Number.isSafeInteger(location.span) && location.span >= 0) end = point(offsets[1]);
    }
    const label = p => `Ln ${p.line}, Col ${p.column}`;
    return `${file}, ${label(start)}${end ? ` to ${label(end)}` : ''}`;
  }
  const api = { validRange, validateSection, IntervalIndex, sections, find, incident, pinnedEdges, keptEdges, arrowStatus, bindingSentence, hoverBoxes, hit, clickOffset, move, rove, related, bindingOccurrences, jump, copy, lineStarts, lineAt, sourceOffsets, sourceLabel };
  if (typeof module === 'object') module.exports = api; else root.MacroModel = api;
})(globalThis);
