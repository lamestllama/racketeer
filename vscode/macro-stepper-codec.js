// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

// shared-v1: term roots are indices; a child [index] references shared. Every
// string/object/array is interned. Primitive numbers and booleans are literals.
// Decode only the selected term. Missing phase records mean uninspected, while
// a present ScopePhase with no scopes means an inspected, empty context.
function decodeTerm(shared, index, fields) {
  if (!Array.isArray(shared) || !Number.isSafeInteger(index) || index < 0 || index >= shared.length) throw new Error('Invalid shared index');
  if (!shared[index] || typeof shared[index] !== 'object' || Array.isArray(shared[index])) throw new Error('Invalid term record');
  const memo = new Map();
  function entry(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= shared.length) throw new Error('Invalid shared index');
    if (memo.has(index)) return memo.get(index);
    const value = shared[index];
    const decoded = Array.isArray(value) ? value.map(child) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, child(v)])) : value;
    memo.set(index, decoded); return decoded;
  }
  function child(value) { return Array.isArray(value) ? entry(value[0]) : value; }
  if (fields) {
    const record = shared[index];
    return Object.fromEntries(fields.map(key => [key, Object.hasOwn(record, key) ? child(record[key]) : null]));
  }
  const term = entry(index);
  if (!['identifier', 'compound', 'atom'].includes(term.kind)) throw new Error('Invalid term kind');
  const binding = b => ({ phase: 0, status: 'absent', kind: null, bindingId: null, definedIn: null,
    importedFrom: null, name: null, originalName: null, providedName: null, definitionPhase: null,
    description: null, reason: null, ...b });
  return { name: null, relations: null, artificial: false, macroScopeGroup: 0,
    inspectionStatus: 'complete', inspectionNotes: [], inspectedPhases: [],
    symbolStatus: term.kind === 'identifier' ? 'interned' : 'not-applicable', ...term,
    source: term.source ? { sourceId: null, line: null, column: null, position: null, span: null, ...term.source } : null,
    bindings: (term.bindings || []).map(binding),
    implicitBindings: Object.fromEntries(['top', 'app', 'datum'].map(key => [key, (term.implicitBindings?.[key] || []).map(binding)])),
    scopes: (term.scopes || []).map(s => ({ phase: 0, status: 'known', reason: null, ...s,
      scopes: (s.scopes || []).map(scope => ({ kind: null, ...scope })) })),
    builtins: { tamperStatus: 'unarmed', original: false, sourceModule: null, ...term.builtins },
    properties: (term.properties || []).map(p => ({ ...p, value: { truncated: false, reason: null, ...p.value } })) };
}

module.exports = { decodeTerm };
