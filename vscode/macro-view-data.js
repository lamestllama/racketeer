// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const Model = require('./macro-view/model');
const capabilities = ['syntax-selection', 'relations', 'binding-edges', 'properties', 'error-contexts', 'interactive-final', 'phase-inspection', 'lazy-positions'];
const sameSnapshot = (a, b) => !!a && !!b && /^[a-f0-9]{64}$/.test(a.sourceHash) && Number.isSafeInteger(a.sourceVersion) && a.sourceVersion >= 0 && a.sourceHash === b.sourceHash && a.sourceVersion === b.sourceVersion;
function validateShared(shared, start = 0) {
  if (!Array.isArray(shared)) throw Error('Invalid shared table');
  const depths = [];
  shared.forEach((entry, offset) => {
    let depth = 0;
    const index = start + offset;
    const child = v => {
      if (Array.isArray(v)) {
        if (v.length !== 1 || !Number.isSafeInteger(v[0]) || v[0] < 0 || v[0] >= index) throw Error('Invalid shared reference');
        depth = Math.max(depth, 1 + (depths[v[0] - start] || 0));
      } else if (!(v === null || ['string', 'boolean', 'number'].includes(typeof v))) throw Error('Invalid shared value');
    };
    if (Array.isArray(entry)) entry.forEach(child);
    else if (entry && typeof entry === 'object') Object.values(entry).forEach(child);
    else if (typeof entry !== 'string') throw Error('Invalid shared entry');
    if (depth > 256) throw Error('Shared metadata nesting exceeds the inspection bound');
    depths.push(depth);
  });
}
function validateSources(sources) {
  if (!sources || typeof sources !== 'object') throw Error('Invalid sources');
  for (const s of Object.values(sources)) if (!['file', 'untitled', 'other'].includes(s.kind) || typeof s.value !== 'string' ||
    !(s.fingerprint === null || /^[a-f0-9]{64}$/.test(s.fingerprint))) throw Error('Invalid source');
}
function validateAnswer(a, snapshot) {
  if (a.failed) throw Error(a.failed);
  if (a.schemaVersion !== 2 || a.mode !== 'summary' || !sameSnapshot(a.snapshot, snapshot) ||
      !Array.isArray(a.steps) || a.stepCount !== a.steps.length || typeof a.final !== 'boolean' ||
      !capabilities.every(c => a.capabilities?.includes(c))) throw Error('Incompatible macro stepper answer');
  if (a.final === (a.error !== null)) throw Error('Missing or conflicting terminal program');
  validateSources(a.sources);
  for (const step of a.steps) {
    if (!['rewrite', 'error', 'remark'].includes(step.kind) || typeof step.label !== 'string' ||
        (step.kind === 'error') !== (typeof step.error === 'string') ||
        ![undefined, null, 'before', 'after'].includes(step.side) || step.side && step.kind !== 'rewrite' ||
        Object.hasOwn(step, 'before') || Object.hasOwn(step, 'after')) throw Error('Invalid step summary');
  }
  return a;
}
function validatePosition(p, summary, position) {
  if (p.failed) throw Error(p.failed);
  if (p.schemaVersion !== 2 || p.mode !== 'position' || !sameSnapshot(p.snapshot, summary.snapshot) ||
      p.position !== position || p.count !== summary.stepCount + 1) throw Error('Invalid position reply');
  const metadata = summary.steps[position - 1];
  if (metadata ? !p.record || p.record.id !== metadata.id || p.record.kind !== metadata.kind || p.record.side !== metadata.side ||
      (metadata.side === 'after' ? p.record.before !== null : !p.record.before) ||
      (metadata.kind === 'rewrite' && metadata.side !== 'before' ? !p.record.after : p.record.after !== null) || p.final !== null
    : p.record !== null || !!p.final !== summary.final) throw Error('Invalid position program');
  if (p.error !== (metadata ? metadata.error : summary.error) || p.error && !p.diagnostics?.[p.error]) throw Error('Missing diagnostic');
  validateSources(p.sources);
  for (const term of Object.values(p.terms || {})) if (!['identifier', 'compound', 'atom'].includes(term.kind)) throw Error('Invalid term kind');
  for (const d of Object.values(p.diagnostics || {})) if (typeof d.message !== 'string' || !Array.isArray(d.syntax) || !Array.isArray(d.contexts)) throw Error('Invalid diagnostic');
  return validateProjection(p, 'position');
}
// A small LRU with a total byte budget; neither positions nor selected-term
// inspections grow with the length of the derivation.
class RecentCache {
  constructor(count = 3, limit = 32 * 1024 * 1024) { this.count = count; this.limit = limit; this.entries = new Map(); this.bytes = 0; }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry); return entry.value;
  }
  set(key, value) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (this.entries.has(key)) { this.bytes -= this.entries.get(key).size; this.entries.delete(key); }
    if (size > this.limit) return;
    this.entries.set(key, { value, size }); this.bytes += size;
    while (this.entries.size > this.count || this.bytes > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).size; this.entries.delete(oldest);
    }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
function validateProjection(p, kind) {
  if (kind === 'colors') {
    if (!Array.isArray(p.tokenStyles) || !p.tokenSections || typeof p.themeName !== 'string') throw Error('Invalid colors projection');
    return p;
  }
  if (kind === 'selection') {
    if (!(p.selected === null || typeof p.selected?.sectionId === 'string' && typeof p.selected?.occurrenceId === 'string') || !Array.isArray(p.related)) throw Error('Invalid selection projection');
    return p;
  }
  if (!Number.isSafeInteger(p.position) || !Number.isSafeInteger(p.count) || p.position < 1 || p.position > p.count ||
      !p.terms || !p.sources || !p.diagnostics) throw Error('Invalid position projection');
  for (const { section } of Model.sections(p)) Model.validateSection(section, p.terms);
  if (p.terminalBefore) Model.validateSection(p.terminalBefore, p.terms);
  return p;
}
function mergeInspection(old, more) {
  const merge = (a, b) => [...a.filter(x => !b.some(y => y.phase === x.phase)), ...b];
  return { ...old, ...more, inspectedPhases: [...new Set([...old.inspectedPhases, ...more.inspectedPhases])],
    bindings: merge(old.bindings, more.bindings), scopes: merge(old.scopes, more.scopes),
    implicitBindings: Object.fromEntries(['top', 'app', 'datum'].map(k => [k, merge(old.implicitBindings[k], more.implicitBindings[k])])) };
}
module.exports = { validateAnswer, validateShared, validateProjection, validatePosition, RecentCache, mergeInspection, sameSnapshot, capabilities };
